'use strict'

const { onRequest }  = require('firebase-functions/v2/https')
const { db, admin }  = require('../db')
const { writeAudit } = require('../audit')
const { setPortalCors } = require('../middleware')
const { INVITATION_STATUS, CUSTOMER_USER_STATUS, PORTAL_AUDIT } = require('./constants')

const FieldValue = admin.firestore.FieldValue
const REGION     = 'us-central1'

exports.acceptCustomerInvitation = onRequest({ region: REGION }, async (req, res) => {
  setPortalCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).send('')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { invitation_id, password } = req.body || {}

  if (!invitation_id?.trim()) return res.status(400).json({ error: 'invitation_id is required' })
  if (!password || password.length < 8)
    return res.status(400).json({ error: 'password is required (min 8 characters)' })

  const invId = invitation_id.trim()
  let createdUid = null

  try {
    // ── PHASE 1: Validate invitation (transaction-guarded against double-accept) ──
    const invRef = db.collection('customer_invitations').doc(invId)

    // Pre-read for validation (fast-fail before creating Auth user)
    const preSnap = await invRef.get()
    if (!preSnap.exists) return res.status(404).json({ error: 'Invitation not found' })

    const inv = preSnap.data()

    if (inv.status === INVITATION_STATUS.ACCEPTED)
      return res.status(409).json({ error: 'Invitation has already been accepted' })
    if (inv.status === INVITATION_STATUS.EXPIRED)
      return res.status(410).json({ error: 'Invitation has expired' })
    if (inv.status !== INVITATION_STATUS.PENDING)
      return res.status(400).json({ error: 'Invitation is not in a usable state' })

    // Expiry check
    const expiresMs = inv.expires_at?.toMillis ? inv.expires_at.toMillis() : 0
    if (Date.now() > expiresMs) {
      await invRef.update({ status: INVITATION_STATUS.EXPIRED })
      return res.status(410).json({ error: 'Invitation has expired' })
    }

    // ── PHASE 2: Create Firebase Auth user ──
    let authUser
    try {
      authUser = await admin.auth().createUser({
        email    : inv.email,
        password : password
      })
      createdUid = authUser.uid
    } catch (authErr) {
      if (authErr.code === 'auth/email-already-exists')
        return res.status(409).json({ error: 'An account with this email already exists' })
      console.error('[portal] acceptCustomerInvitation auth:', authErr)
      return res.status(500).json({ error: 'Failed to create account' })
    }

    // ── PHASE 3: Atomic Firestore write (customer_users + invitation flip) ──
    // Guard against double-accept via transaction re-check on invitation status.
    try {
      await db.runTransaction(async (tx) => {
        const freshInv = await tx.get(invRef)
        if (!freshInv.exists)
          throw Object.assign(new Error('Invitation not found'), { code: 404 })

        const fresh = freshInv.data()
        if (fresh.status !== INVITATION_STATUS.PENDING)
          throw Object.assign(new Error('Invitation has already been accepted'), { code: 409 })

        const now = FieldValue.serverTimestamp()

        // Create customer_users doc
        tx.set(db.collection('customer_users').doc(createdUid), {
          uid           : createdUid,
          email         : inv.email,
          name          : inv.name || '',
          customer_code : inv.customer_code,
          status        : CUSTOMER_USER_STATUS.ACTIVE,
          created_at    : now,
          updated_at    : now
        })

        // Flip invitation to ACCEPTED
        tx.update(invRef, {
          status      : INVITATION_STATUS.ACCEPTED,
          accepted_at : now,
          accepted_uid: createdUid
        })
      })
    } catch (txErr) {
      // Rollback: delete the Auth user we created
      if (createdUid) {
        try { await admin.auth().deleteUser(createdUid) }
        catch (delErr) { console.error('[portal] rollback deleteUser failed:', delErr) }
      }
      if (txErr.code === 409) return res.status(409).json({ error: txErr.message })
      if (txErr.code === 404) return res.status(404).json({ error: txErr.message })
      console.error('[portal] acceptCustomerInvitation tx:', txErr)
      return res.status(500).json({ error: 'Internal error' })
    }

    await writeAudit(PORTAL_AUDIT.CUSTOMER_INVITATION_ACCEPTED, createdUid, invId, {
      invitation_id: invId,
      customer_code: inv.customer_code,
      email        : inv.email
    })

    return res.status(201).json({
      ok            : true,
      uid           : createdUid,
      customer_code : inv.customer_code,
      status        : CUSTOMER_USER_STATUS.ACTIVE
    })

  } catch (err) {
    if (createdUid) {
      try { await admin.auth().deleteUser(createdUid) }
      catch (delErr) { console.error('[portal] outer rollback deleteUser failed:', delErr) }
    }
    console.error('[portal] acceptCustomerInvitation:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})
