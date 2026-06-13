'use strict'
const { onRequest }                          = require('firebase-functions/v2/https')
const { db, admin }                          = require('../db')
const { requireAuth, requireActive }         = require('../middleware')
const FieldValue                             = admin.firestore.FieldValue
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

exports.addPsmItem = onRequest({ region: REGION }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const { psm_id, product_id, qty, proposed_price } = req.body

    if (!psm_id)        return res.status(400).json({ error: 'psm_id is required' })
    if (!product_id)    return res.status(400).json({ error: 'product_id is required' })
    if (qty === undefined || qty === null)
      return res.status(400).json({ error: 'qty is required' })
    if (proposed_price === undefined || proposed_price === null)
      return res.status(400).json({ error: 'proposed_price is required' })

    if (!Number.isInteger(qty) || qty < 1)
      return res.status(400).json({ error: 'qty must be an integer >= 1' })

    if (typeof proposed_price !== 'number' || isNaN(proposed_price) || proposed_price < 0)
      return res.status(400).json({ error: 'proposed_price must be a number >= 0' })

    try {
      const psmRef  = db.collection('psm_requests').doc(psm_id)
      const psmSnap = await psmRef.get()
      if (!psmSnap.exists) return res.status(404).json({ error: 'PSM not found' })
      const psm = psmSnap.data()

      if (psm.status !== 'DRAFT')
        return res.status(422).json({ error: 'PSM status must be DRAFT' })

      if (psm.created_by !== req.user.uid)
        return res.status(403).json({ error: 'Only PSM owner can add items' })

      const productSnap = await db.collection('product_registry').doc(product_id).get()
      if (!productSnap.exists) return res.status(404).json({ error: 'Product not found' })
      const product = productSnap.data()

      if (product.status !== 'ACTIVE')
        return res.status(404).json({ error: 'Product is not active' })

      const product_code = product.product_code || ''
      const product_name = product.product_name || ''
      const source       = product.source       || ''
      const dbp          = product.dbp          ?? 0
      const cost         = product.cost         ?? 0

      const dupSnap = await db.collection('psm_requests').doc(psm_id)
        .collection('psm_items')
        .where('product_code', '==', product_code)
        .limit(1)
        .get()
      if (!dupSnap.empty)
        return res.status(409).json({ error: 'product_code already exists in this PSM' })

      const histId   = `${psm.customer_code}_${product_code}`
      const histSnap = await db.collection('historical_sales').doc(histId).get()
      let previous_price = null
      let previous_nc    = null
      if (histSnap.exists) {
        const hist     = histSnap.data()
        previous_price = hist.previous_price ?? null
        previous_nc    = hist.previous_nc    ?? null
      }

      const total_sales = qty * proposed_price
      const total_cost  = qty * cost
      const nc = total_sales > 0
        ? Math.round(((total_sales - total_cost) / total_sales) * 100 * 10) / 10
        : null

      const itemRef = db.collection('psm_requests').doc(psm_id).collection('psm_items').doc()
      const item_id = itemRef.id

      await itemRef.set({
        item_id,
        product_id,
        product_code,
        product_name,
        source,
        dbp,
        cost,
        qty,
        proposed_price,
        total_sales,
        total_cost,
        nc,
        previous_price,
        previous_nc,
        created_at: FieldValue.serverTimestamp(),
        created_by: req.user.uid
      })

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

      await psmRef.update({
        aggregate_nc,
        updated_at: FieldValue.serverTimestamp(),
        updated_by: req.user.uid
      })

      return res.status(200).json({ ok: true, item_id, nc, aggregate_nc })

    } catch (err) {
      console.error('[psmRequests] addPsmItem:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
