'use strict'

const { onRequest }                               = require('firebase-functions/v2/https')
const { db, admin }                               = require('./db')
const { AUDIT, STATUS }                           = require('./constants')
const { writeAudit }                              = require('./audit')
const FieldValue = admin.firestore.FieldValue
const { requireAuth, requireActive, requireRole } = require('./middleware')

const JAKARTA_TZ = 'Asia/Jakarta'

// Get today's date string in Jakarta timezone YYYY-MM-DD
function getTodayJakarta() {
  return new Date().toLocaleDateString('en-CA', { timeZone: JAKARTA_TZ })
}

// Compute effective_status from stored delegation fields
function computeEffectiveStatus(delegation) {
  if (!delegation.active) return 'deactivated'
  const today = getTodayJakarta()
  if (today < delegation.start_date) return 'scheduled'
  if (today > delegation.end_date)   return 'expired'
  return 'active'
}

// ── GET /getDelegations ──────────────────────────────────────
// Returns delegation records. Super Admin only.
// Query params:
//   ?active=true|false|all       (default: all)
//   ?original_approver_id=<uid>  (optional)
//   ?delegate_id=<uid>           (optional)

exports.getDelegations = onRequest({ region: 'us-central1' }, async (req, res) => {
  await requireAuth(req, res, async () => {
  await requireActive(req, res, async () => {
  await requireRole('SUPER_ADMIN')(req, res, async () => {

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    // Validate active filter
    const activeParam = (req.query.active || 'all').toLowerCase()
    if (!['true', 'false', 'all'].includes(activeParam)) {
      return res.status(400).json({
        error:   'Bad Request',
        message: `Invalid active filter: "${activeParam}". Allowed: true, false, all`
      })
    }

    const originalApproverId = req.query.original_approver_id || null
    const delegateId         = req.query.delegate_id || null

    try {
      let query = db.collection('delegations').orderBy('created_at', 'desc')

      // Apply active filter
      if (activeParam === 'true')  query = query.where('active', '==', true)
      if (activeParam === 'false') query = query.where('active', '==', false)

      // Apply optional filters
      if (originalApproverId) query = query.where('original_approver_id', '==', originalApproverId)
      if (delegateId)         query = query.where('delegate_id', '==', delegateId)

      const snap = await query.get()

      const delegations = snap.docs.map(doc => {
        const data = doc.data()
        return {
          id: doc.id,
          ...data,
          effective_status: computeEffectiveStatus(data)
        }
      })

      return res.status(200).json({ delegations })

    } catch (err) {
      console.error('[delegations] getDelegations error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }

  })})})
})
// ── POST /createDelegation ───────────────────────────────────
// Creates a delegation record. Super Admin only.
// Immutable after creation. Changes require deactivate + create.
// Body: { original_approver_id, delegate_id, start_date, end_date, reason? }

exports.createDelegation = onRequest({ region: 'us-central1' }, async (req, res) => {
  await requireAuth(req, res, async () => {
  await requireActive(req, res, async () => {
  await requireRole('SUPER_ADMIN')(req, res, async () => {

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    const { original_approver_id, delegate_id, start_date, end_date, reason } = req.body

    // Input presence
    if (!original_approver_id) return res.status(400).json({ error: 'Bad Request', message: 'original_approver_id is required' })
    if (!delegate_id)          return res.status(400).json({ error: 'Bad Request', message: 'delegate_id is required' })
    if (!start_date)           return res.status(400).json({ error: 'Bad Request', message: 'start_date is required' })
    if (!end_date)             return res.status(400).json({ error: 'Bad Request', message: 'end_date is required' })

    // Self-delegation
    if (original_approver_id === delegate_id) {
      return res.status(400).json({ error: 'Bad Request', message: 'Self delegation is not allowed' })
    }

    // Date validation — Jakarta timezone
    const todayJakarta = getTodayJakarta()
    if (start_date < todayJakarta) {
      return res.status(400).json({ error: 'Bad Request', message: 'start_date cannot be in the past' })
    }
    if (end_date < start_date) {
      return res.status(400).json({ error: 'Bad Request', message: 'end_date must be on or after start_date' })
    }

    try {
      // Step 1 — Verify both users exist
      const [approverSnap, delegateSnap] = await Promise.all([
        db.collection('users').doc(original_approver_id).get(),
        db.collection('users').doc(delegate_id).get()
      ])

      if (!approverSnap.exists) return res.status(404).json({ error: 'Not Found', message: 'Original approver not found' })
      if (!delegateSnap.exists) return res.status(404).json({ error: 'Not Found', message: 'Delegate not found' })

      const approver = approverSnap.data()
      const delegate = delegateSnap.data()

      // Step 2 — Both must be ACTIVE
      if (approver.status !== STATUS.ACTIVE) {
        return res.status(400).json({ error: 'Bad Request', message: 'Original approver must be ACTIVE' })
      }
      if (delegate.status !== STATUS.ACTIVE) {
        return res.status(400).json({ error: 'Bad Request', message: 'Delegate must be ACTIVE' })
      }

      // Step 3 — Direct subordinate check
      if (delegate.manager_user_id !== original_approver_id) {
        return res.status(400).json({ error: 'Bad Request', message: 'Delegate must directly report to original approver' })
      }

      // Step 4 — Transaction: one-active-per-owner + create
      let newDelegationId = null

      await db.runTransaction(async (txn) => {
        // Check existing active delegation for this approver
        const existingSnap = await txn.get(
          db.collection('delegations')
            .where('original_approver_id', '==', original_approver_id)
            .where('active', '==', true)
            .limit(1)
        )

        if (!existingSnap.empty) {
          const err = new Error('Active delegation already exists for this approver')
          err.code  = 409
          throw err
        }

        // Create delegation document
        const docRef = db.collection('delegations').doc()
        newDelegationId = docRef.id

        txn.set(docRef, {
          delegation_id:        newDelegationId,
          original_approver_id,
          delegate_id,
          start_date,
          end_date,
          active:               true,
          reason:               reason || null,
          created_by:           req.user.uid,
          created_at:           FieldValue.serverTimestamp(),
          deactivated_by:       null,
          deactivated_at:       null,
          deactivation_reason:  null
        })
      })

      // Audit after transaction commits
      await writeAudit(AUDIT.DELEGATION_CREATED, req.user.uid, newDelegationId, {
        delegation_id:        newDelegationId,
        original_approver_id,
        delegate_id,
        start_date,
        end_date
      })

      return res.status(201).json({
        id:                   newDelegationId,
        original_approver_id,
        delegate_id,
        start_date,
        end_date,
        active:               true
      })

    } catch (err) {
      if (err.code === 409) return res.status(409).json({ error: 'Conflict', message: err.message })
      console.error('[delegations] createDelegation error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }

  })})})
})

// ── POST /deactivateDelegation ───────────────────────────────
// Deactivates an active delegation. Super Admin only.
// One-way: active=true → active=false. No reactivation.
// Records retained forever. Never deleted.
// Body: { delegation_id: string, deactivation_reason?: string }

exports.deactivateDelegation = onRequest({ region: 'us-central1' }, async (req, res) => {
  await requireAuth(req, res, async () => {
  await requireActive(req, res, async () => {
  await requireRole('SUPER_ADMIN')(req, res, async () => {

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    const { delegation_id, deactivation_reason } = req.body

    if (!delegation_id || typeof delegation_id !== 'string') {
      return res.status(400).json({ error: 'Bad Request', message: 'delegation_id is required' })
    }

    const reasonTrimmed = deactivation_reason
      ? String(deactivation_reason).trim() || null
      : null

    try {
      const docRef  = db.collection('delegations').doc(delegation_id)
      const docSnap = await docRef.get()

      if (!docSnap.exists) {
        return res.status(404).json({ error: 'Not Found', message: 'Delegation not found' })
      }

      const delegation = docSnap.data()

      if (!delegation.active) {
        return res.status(400).json({ error: 'Bad Request', message: 'Delegation already deactivated' })
      }

      // Write deactivation
      await docRef.update({
        active:               false,
        deactivated_by:       req.user.uid,
        deactivated_at:       FieldValue.serverTimestamp(),
        deactivation_reason:  reasonTrimmed
      })

      // Audit
      await writeAudit(AUDIT.DELEGATION_DEACTIVATED, req.user.uid, delegation_id, {
        delegation_id,
        original_approver_id: delegation.original_approver_id,
        delegate_id:          delegation.delegate_id,
        deactivated_by:       req.user.uid,
        deactivation_reason:  reasonTrimmed
      })

      return res.status(200).json({
        ok:                  true,
        id:                  delegation_id,
        active:              false,
        deactivation_reason: reasonTrimmed
      })

    } catch (err) {
      console.error('[delegations] deactivateDelegation error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }

  })})})
})
