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

exports.removePsmItem = onRequest({ region: REGION }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const { psm_id, item_id } = req.body

    if (!psm_id)   return res.status(400).json({ error: 'psm_id is required' })
    if (!item_id)  return res.status(400).json({ error: 'item_id is required' })

    try {
      // L1: PSM lookup
      const psmRef  = db.collection('psm_requests').doc(psm_id)
      const psmSnap = await psmRef.get()
      if (!psmSnap.exists) return res.status(404).json({ error: 'PSM not found' })
      const psm = psmSnap.data()

      // V1: PSM must be DRAFT
      if (psm.status !== 'DRAFT')
        return res.status(422).json({ error: 'PSM status must be DRAFT' })

      // V2: Caller must be PSM owner
      if (psm.created_by !== req.user.uid)
        return res.status(403).json({ error: 'Only PSM owner can remove items' })

      // L2: Item lookup
      const itemRef  = db.collection('psm_requests').doc(psm_id).collection('psm_items').doc(item_id)
      const itemSnap = await itemRef.get()
      if (!itemSnap.exists) return res.status(404).json({ error: 'Item not found' })

      // W1: Delete item
      await itemRef.delete()

      // C1: Recalculate aggregate_nc from remaining items
      const allItemsSnap = await db.collection('psm_requests').doc(psm_id)
        .collection('psm_items').get()

      let sumSales = 0
      let sumCost  = 0
      allItemsSnap.forEach(doc => {
        const d = doc.data()
        sumSales += d.total_sales || 0
        sumCost  += d.total_cost  || 0
      })

      const aggregate_nc = sumSales > 0
        ? Math.round(((sumSales - sumCost) / sumSales) * 100 * 10) / 10
        : null

      // W2: Update PSM parent
      await psmRef.update({
        aggregate_nc,
        updated_at: FieldValue.serverTimestamp(),
        updated_by: req.user.uid
      })

      return res.status(200).json({ ok: true, aggregate_nc })

    } catch (err) {
      console.error('[psmRequests] removePsmItem:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
