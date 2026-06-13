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

exports.syncApprovalResult = onRequest({ region: REGION }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const { approval_request_id } = req.body
    if (!approval_request_id)
      return res.status(400).json({ error: 'approval_request_id is required' })

    try {
      // L1: approval_request lookup
      const arRef  = db.collection('approval_requests').doc(approval_request_id)
      const arSnap = await arRef.get()
      if (!arSnap.exists)
        return res.status(404).json({ error: 'Approval request not found' })

      const ar = arSnap.data()

      // V1: status must be terminal
      if (ar.status !== 'APPROVED' && ar.status !== 'REJECTED')
        return res.status(422).json({ error: 'Approval request status must be APPROVED or REJECTED' })

      // L2: resolve linked psm_id from payload_snapshot
      const psm_id = ar.payload_snapshot && ar.payload_snapshot.psm_id
      if (!psm_id)
        return res.status(422).json({ error: 'approval_request payload_snapshot.psm_id is missing' })

      // L3: PSM lookup
      const psmRef  = db.collection('psm_requests').doc(psm_id)
      const psmSnap = await psmRef.get()
      if (!psmSnap.exists)
        return res.status(404).json({ error: 'Linked PSM not found' })

      // Build PSM update based on terminal status
      let psmUpdate
      if (ar.status === 'APPROVED') {
        psmUpdate = {
          status:      'APPROVED',
          approved_at: FieldValue.serverTimestamp(),
          updated_at:  FieldValue.serverTimestamp(),
          updated_by:  req.user.uid
        }
      } else {
        psmUpdate = {
          status:      'REJECTED',
          rejected_at: FieldValue.serverTimestamp(),
          updated_at:  FieldValue.serverTimestamp(),
          updated_by:  req.user.uid
        }
      }

      // Atomic transaction: re-read both docs + update PSM
      await db.runTransaction(async (tx) => {
        const freshAr  = await tx.get(arRef)
        const freshPsm = await tx.get(psmRef)

        if (!freshAr.exists)
          throw Object.assign(new Error('Approval request not found'), { code: 404 })

        if (freshAr.data().status !== 'APPROVED' && freshAr.data().status !== 'REJECTED')
          throw Object.assign(new Error('Approval request status must be APPROVED or REJECTED'), { code: 422 })

        if (!freshPsm.exists)
          throw Object.assign(new Error('Linked PSM not found'), { code: 404 })

        tx.update(psmRef, psmUpdate)
      })

      return res.status(200).json({ psm_id, status: ar.status })

    } catch (err) {
      if (err.code === 404) return res.status(404).json({ error: err.message })
      if (err.code === 422) return res.status(422).json({ error: err.message })
      console.error('[PSM-8] syncApprovalResult:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
