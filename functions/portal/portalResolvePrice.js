'use strict'

const { onRequest }         = require('firebase-functions/v2/https')
const { db }                = require('../db')
const { requirePortalAuth } = require('../middleware')
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

exports.portalResolvePrice = onRequest({ region: REGION }, run(
  [requirePortalAuth],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const { product_code, qty, order_date } = req.body || {}

    // customer_code ALWAYS from token — never from client
    const customer_code = req.portalUser.customer_code

    if (!product_code?.trim()) return res.status(400).json({ error: 'product_code is required' })
    if (!order_date?.trim())   return res.status(400).json({ error: 'order_date is required' })

    const requested_qty = parseInt(qty, 10)
    if (isNaN(requested_qty) || requested_qty <= 0)
      return res.status(400).json({ error: 'qty must be a positive integer' })

    try {
      // Q1: Query active CPR records for this customer + product
      const cprSnap = await db.collection('cpr_records')
        .where('customer_code', '==', customer_code)
        .where('product_code',  '==', product_code.trim())
        .where('status',        '==', 'ACTIVE')
        .get()

      // Filter by date validity and remaining_qty in memory
      const eligible = cprSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(cpr => {
          if (cpr.remaining_qty <= 0)          return false
          if (cpr.validity_from > order_date)  return false
          if (cpr.validity_to   < order_date)  return false
          return true
        })
        .sort((a, b) => {
          // FIFO: validity_from ASC → created_at ASC
          if (a.validity_from !== b.validity_from)
            return a.validity_from.localeCompare(b.validity_from)
          const aTime = a.created_at?.toMillis?.() ?? 0
          const bTime = b.created_at?.toMillis?.() ?? 0
          return aTime - bTime
        })

      if (eligible.length > 0) {
        // CPR path
        const total_remaining_qty = eligible.reduce((s, c) => s + (c.remaining_qty || 0), 0)
        const allowed             = requested_qty <= total_remaining_qty
        const first               = eligible[0]

        const message = allowed ? null :
          `Anda tidak dapat memproses Product ${first.product_name}.\n\n` +
          `Permintaan: ${requested_qty} unit\n` +
          `Sisa alokasi tersedia: ${total_remaining_qty} unit\n\n` +
          `Untuk tambahan alokasi silakan hubungi Sales Manager terkait.`

        // Portal-safe response — NO matched_cpr_ids, NO psm_numbers
        return res.status(200).json({
          allowed,
          price_source       : 'CPR',
          unit_price         : first.proposed_price,
          requested_qty,
          total_remaining_qty,
          message
        })
      }

      // DBP fallback path
      const productSnap = await db.collection('product_registry')
        .where('product_code', '==', product_code.trim())
        .limit(1)
        .get()

      if (productSnap.empty)
        return res.status(404).json({ error: `Product not found: ${product_code}` })

      const product = productSnap.docs[0].data()

      return res.status(200).json({
        allowed             : true,
        price_source        : 'DBP',
        unit_price          : product.dbp || 0,
        requested_qty,
        total_remaining_qty : 0,
        message             : null
      })

    } catch (err) {
      console.error('[portal] portalResolvePrice:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
