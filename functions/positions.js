'use strict'

const { onRequest }                          = require('firebase-functions/v2/https')
const { db }                                 = require('./db')
const { requireAuth, requireActive, requireRole } = require('./middleware')

const VALID_FILTERS = ['active', 'inactive', 'all']

// ── GET /getPositions ────────────────────────────────────────
// Returns positions registry to Super Admin.
// Query param: ?filter=active|inactive|all  (default: active)

exports.getPositions = onRequest({ region: 'us-central1' }, async (req, res) => {
  await requireAuth(req, res, async () => {
  await requireActive(req, res, async () => {
  await requireRole('SUPER_ADMIN')(req, res, async () => {

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    const filter = (req.query.filter || 'active').toLowerCase()
    if (!VALID_FILTERS.includes(filter)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: `Invalid filter value: "${filter}". Allowed: active, inactive, all`
      })
    }

    try {
      let query = db.collection('positions').orderBy('title', 'asc')

      if (filter === 'active')   query = query.where('active', '==', true)
      if (filter === 'inactive') query = query.where('active', '==', false)
      // filter === 'all' → no where clause

      const snap = await query.get()

      const positions = snap.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }))

      return res.status(200).json({ positions })

    } catch (err) {
      console.error('[positions] getPositions error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }

  })})})
})

// ── POST /createPosition ─────────────────────────────────────
// Creates a new position title. Super Admin only.
// Body: { title: string }

exports.createPosition = onRequest({ region: 'us-central1' }, async (req, res) => {
  await requireAuth(req, res, async () => {
  await requireActive(req, res, async () => {
  await requireRole('SUPER_ADMIN')(req, res, async () => {

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    // Normalize title
    const raw = req.body.title
    if (typeof raw !== 'string') {
      return res.status(400).json({ error: 'Bad Request', message: 'title is required' })
    }
    const title = raw.trim().replace(/\s+/g, ' ')
    if (!title) {
      return res.status(400).json({ error: 'Bad Request', message: 'title cannot be empty' })
    }
    if (title.length > 100) {
      return res.status(400).json({ error: 'Bad Request', message: 'title must not exceed 100 characters' })
    }

    try {
      // Uniqueness check — case-insensitive, all statuses
      const titleLower = title.toLowerCase()
      const existing = await db.collection('positions')
        .where('title_lower', '==', titleLower)
        .limit(1)
        .get()

      if (!existing.empty) {
        const found = existing.docs[0].data()
        return res.status(409).json({
          error: 'Conflict',
          message: `Position title already exists`,
          existing_title: found.title,
          active: found.active
        })
      }

      // Write new document
      const { admin: adminSdk } = require('./db')
      const FieldValue = adminSdk.firestore.FieldValue

      const docRef = db.collection('positions').doc()
      await docRef.set({
        title,
        title_lower: titleLower,
        active:      true,
        created_by:  req.user.uid,
        created_at:  FieldValue.serverTimestamp()
      })

      return res.status(201).json({
        id:    docRef.id,
        title,
        active: true
      })

    } catch (err) {
      console.error('[positions] createPosition error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }

  })})})
})

// ── PATCH /updatePosition ────────────────────────────────────
// Corrects a position title. Super Admin only.
// Title correction blocked if any ACTIVE user references this position.
// Inactive users do NOT block rename.
// Body: { positionId: string, title: string }

exports.updatePosition = onRequest({ region: 'us-central1' }, async (req, res) => {
  await requireAuth(req, res, async () => {
  await requireActive(req, res, async () => {
  await requireRole('SUPER_ADMIN')(req, res, async () => {

    if (req.method !== 'PATCH') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    const { positionId, title: rawTitle } = req.body

    if (!positionId || typeof positionId !== 'string') {
      return res.status(400).json({ error: 'Bad Request', message: 'positionId is required' })
    }
    if (typeof rawTitle !== 'string') {
      return res.status(400).json({ error: 'Bad Request', message: 'title is required' })
    }

    const title = rawTitle.trim().replace(/\s+/g, ' ')
    if (!title) {
      return res.status(400).json({ error: 'Bad Request', message: 'title cannot be empty' })
    }
    if (title.length > 100) {
      return res.status(400).json({ error: 'Bad Request', message: 'title must not exceed 100 characters' })
    }

    try {
      const { admin: adminSdk } = require('./db')
      const FieldValue = adminSdk.firestore.FieldValue

      // Confirm position exists
      const posDoc = await db.collection('positions').doc(positionId).get()
      if (!posDoc.exists) {
        return res.status(404).json({ error: 'Not Found', message: 'Position not found' })
      }

      const posData = posDoc.data()

      // Must be active to rename
      if (!posData.active) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot rename an inactive position. Reactivate it first.'
        })
      }

      // Uniqueness check — case-insensitive, all statuses, excluding self
      const titleLower = title.toLowerCase()
      if (titleLower !== posData.title_lower) {
        const conflict = await db.collection('positions')
          .where('title_lower', '==', titleLower)
          .limit(1)
          .get()

        if (!conflict.empty) {
          const found = conflict.docs[0].data()
          return res.status(409).json({
            error: 'Conflict',
            message: 'Position title already exists',
            existing_title: found.title,
            active: found.active
          })
        }
      } else {
        // Title unchanged — nothing to do
        return res.status(400).json({
          error: 'Bad Request',
          message: 'New title is identical to current title'
        })
      }

      // Block rename if any ACTIVE user references this position
      const activeUsers = await db.collection('users')
        .where('position_id', '==', positionId)
        .where('status', '==', 'ACTIVE')
        .limit(1)
        .get()

      if (!activeUsers.empty) {
        const count = activeUsers.size
        return res.status(409).json({
          error: 'Conflict',
          message: `Cannot rename: ${count} active user(s) reference this position`
        })
      }

      // Write update
      await db.collection('positions').doc(positionId).update({
        title,
        title_lower:  titleLower,
        updated_by:   req.user.uid,
        updated_at:   FieldValue.serverTimestamp()
      })

      return res.status(200).json({ id: positionId, title, active: posData.active })

    } catch (err) {
      console.error('[positions] updatePosition error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }

  })})})
})

// ── POST /deactivatePosition ─────────────────────────────────
// Sets position active: false. Super Admin only.
// Blocked if any ACTIVE user references this position.
// Record is never deleted.
// Body: { positionId: string, reason: string (optional) }

exports.deactivatePosition = onRequest({ region: 'us-central1' }, async (req, res) => {
  await requireAuth(req, res, async () => {
  await requireActive(req, res, async () => {
  await requireRole('SUPER_ADMIN')(req, res, async () => {

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    const { positionId, reason } = req.body

    if (!positionId || typeof positionId !== 'string') {
      return res.status(400).json({ error: 'Bad Request', message: 'positionId is required' })
    }

    // Validate reason if provided
    if (reason !== undefined && typeof reason !== 'string') {
      return res.status(400).json({ error: 'Bad Request', message: 'reason must be a string' })
    }
    const reasonTrimmed = reason ? reason.trim() : null
    if (reasonTrimmed && reasonTrimmed.length > 255) {
      return res.status(400).json({ error: 'Bad Request', message: 'reason must not exceed 255 characters' })
    }

    try {
      const { admin: adminSdk } = require('./db')
      const FieldValue = adminSdk.firestore.FieldValue

      // Confirm position exists
      const posDoc = await db.collection('positions').doc(positionId).get()
      if (!posDoc.exists) {
        return res.status(404).json({ error: 'Not Found', message: 'Position not found' })
      }

      const posData = posDoc.data()

      // Must be active to deactivate
      if (!posData.active) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Position is already inactive'
        })
      }

      // Block if any ACTIVE user references this position
      const activeUsers = await db.collection('users')
        .where('position_id', '==', positionId)
        .where('status', '==', 'ACTIVE')
        .limit(1)
        .get()

      if (!activeUsers.empty) {
        return res.status(409).json({
          error: 'Conflict',
          message: `Cannot deactivate: ${activeUsers.size} active user(s) reference this position`
        })
      }

      // Build update payload
      const update = {
        active:     false,
        updated_by: req.user.uid,
        updated_at: FieldValue.serverTimestamp()
      }
      if (reasonTrimmed) update.deactivation_reason = reasonTrimmed

      await db.collection('positions').doc(positionId).update(update)

      return res.status(200).json({
        id:     positionId,
        active: false,
        ...(reasonTrimmed && { deactivation_reason: reasonTrimmed })
      })

    } catch (err) {
      console.error('[positions] deactivatePosition error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }

  })})})
})
// ── POST /reactivatePosition ─────────────────────────────────
// Reactivates a deactivated position. Super Admin only.
// State transition: active=false → active=true
// Clears deactivation_reason on reactivation.
// Body: { positionId: string }

exports.reactivatePosition = onRequest({ region: 'us-central1' }, async (req, res) => {
  await requireAuth(req, res, async () => {
  await requireActive(req, res, async () => {
  await requireRole('SUPER_ADMIN')(req, res, async () => {

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    const { positionId } = req.body

    if (!positionId || typeof positionId !== 'string') {
      return res.status(400).json({ error: 'Bad Request', message: 'positionId is required' })
    }

    try {
      const { admin: adminSdk } = require('./db')
      const FieldValue = adminSdk.firestore.FieldValue

      // Confirm position exists
      const posDoc = await db.collection('positions').doc(positionId).get()
      if (!posDoc.exists) {
        return res.status(404).json({ error: 'Not Found', message: 'Position not found' })
      }

      const posData = posDoc.data()

      // Must be inactive to reactivate
      if (posData.active) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Position is already active'
        })
      }

      // Reactivate — clear deactivation_reason
      await db.collection('positions').doc(positionId).update({
        active:               true,
        deactivation_reason:  FieldValue.delete(),
        updated_by:           req.user.uid,
        updated_at:           FieldValue.serverTimestamp()
      })

      return res.status(200).json({
        id:     positionId,
        title:  posData.title,
        active: true
      })

    } catch (err) {
      console.error('[positions] reactivatePosition error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }

  })})})
})