'use strict'

const { onRequest } = require('firebase-functions/v2/https')
const { db, admin }  = require('./db')
const { requireAuth, requireActive, requireRole } = require('./middleware')

const FieldValue = admin.firestore.FieldValue

function run(middlewares, handler) {
  return onRequest(async (req, res) => {
    let idx = 0
    const next = async () => {
      const mw = middlewares[idx++]
      if (mw) {
        const r = mw(req, res, next)
        if (r && typeof r.then === 'function') await r
      } else {
        await handler(req, res)
      }
    }
    await next()
  })
}

// ============================================================
// listSegments
// GET ?activeOnly=true
// ============================================================
exports.listSegments = run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    try {
      const { activeOnly } = req.query
      let q = db.collection('segments').orderBy('segment_code')
      if (activeOnly === 'true') q = q.where('active', '==', true)
      const snap = await q.get()
      return res.status(200).json({
        segments: snap.docs.map(d => ({ id: d.id, ...d.data() }))
      })
    } catch (err) {
      console.error('[segments] listSegments:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// ============================================================
// getSegment
// GET ?id=<doc_id>
// ============================================================
exports.getSegment = run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id is required' })
    try {
      const snap = await db.collection('segments').doc(id).get()
      if (!snap.exists) return res.status(404).json({ error: 'Segment not found' })
      return res.status(200).json({ id: snap.id, ...snap.data() })
    } catch (err) {
      console.error('[segments] getSegment:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// ============================================================
// createSegment
// POST { segment_code, segment_name }
// ============================================================
exports.createSegment = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { segment_code, segment_name } = req.body || {}

    if (!segment_code?.trim())
      return res.status(400).json({ error: 'segment_code is required' })
    if (!segment_name?.trim())
      return res.status(400).json({ error: 'segment_name is required' })

    const code = segment_code.trim()
    const name = segment_name.trim()

    try {
      const dup = await db.collection('segments')
        .where('segment_code', '==', code).limit(1).get()
      if (!dup.empty)
        return res.status(409).json({ error: 'segment_code already exists' })

      const now = FieldValue.serverTimestamp()
      const ref = await db.collection('segments').add({
        segment_code : code,
        segment_name : name,
        active       : true,
        created_at   : now,
        updated_at   : now,
        created_by   : req.user.uid,
        updated_by   : req.user.uid
      })
      return res.status(201).json({ ok: true, id: ref.id })
    } catch (err) {
      console.error('[segments] createSegment:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// ============================================================
// updateSegment
// POST { id, segment_name?, active? }
// segment_code is IMMUTABLE
// ============================================================
exports.updateSegment = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { id, segment_name, active } = req.body || {}

    if (!id) return res.status(400).json({ error: 'id is required' })

    try {
      const ref  = db.collection('segments').doc(id)
      const snap = await ref.get()
      if (!snap.exists) return res.status(404).json({ error: 'Segment not found' })

      const updates = {
        updated_at : FieldValue.serverTimestamp(),
        updated_by : req.user.uid
      }

      if (segment_name !== undefined) {
        if (!segment_name.trim())
          return res.status(400).json({ error: 'segment_name cannot be empty' })
        updates.segment_name = segment_name.trim()
      }

      if (active !== undefined) {
        if (typeof active !== 'boolean')
          return res.status(400).json({ error: 'active must be boolean' })
        updates.active = active
      }

      await ref.update(updates)
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[segments] updateSegment:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)
