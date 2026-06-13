'use strict'
const { onRequest }                  = require('firebase-functions/v2/https')
const { db, admin }                  = require('../db')
const { requireAuth, requireActive } = require('../middleware')
const FieldValue                     = admin.firestore.FieldValue
const REGION = 'us-central1'

function run(middlewares, handler) {
  return async (req, res) => {
    for (const mw of middlewares) {
      let next = false
      await mw(req, res, () => { next = true })
      if (!next) return
    }
    return handler(req, res)
  }
}

exports.recallPsm = onRequest({ region: REGION }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const { psm_id } = req.body
    if (!psm_id) return res.status(400).json({ error: 'psm_id is required' })

    try {
      // L1: PSM lookup
      const psmRef  = db.collection('psm_requests').doc(psm_id)
      const psmSnap = await psmRef.get()
      if (!psmSnap.exists) return res.status(404).json({ error: 'PSM not found' })
      const psm = psmSnap.data()

      // V1: caller must be PSM owner
      if (psm.created_by !== req.user.uid)
        return res.status(403).json({ error: 'Only PSM owner can recall' })

      // V2: PSM status must be REJECTED
      if (psm.status !== 'REJECTED')
        return res.status(422).json({ error: 'Only REJECTED PSM can be recalled' })

      // Atomic transaction: re-read + update
      await db.runTransaction(async (tx) => {
        const freshSnap = await tx.get(psmRef)
        if (!freshSnap.exists)
          throw Object.assign(new Error('PSM not found'), { code: 404 })
        if (freshSnap.data().created_by !== req.user.uid)
          throw Object.assign(new Error('Only PSM owner can recall'), { code: 403 })
        if (freshSnap.data().status !== 'REJECTED')
          throw Object.assign(new Error('Only REJECTED PSM can be recalled'), { code: 422 })

        tx.update(psmRef, {
          status:              'DRAFT',
          recalled_at:         FieldValue.serverTimestamp(),
          recalled_by:         req.user.uid,
          approval_request_id: null,
          updated_at:          FieldValue.serverTimestamp(),
          updated_by:          req.user.uid
        })
      })

      return res.status(200).json({ psm_id, status: 'DRAFT' })

    } catch (err) {
      if (err.code === 404) return res.status(404).json({ error: err.message })
      if (err.code === 403) return res.status(403).json({ error: err.message })
      if (err.code === 422) return res.status(422).json({ error: err.message })
      console.error('[PSM-9] recallPsm:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
