'use strict'

const { onRequest }                  = require('firebase-functions/v2/https')
const { db, admin }                  = require('../db')
const { requireAuth, requireActive } = require('../middleware')
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

exports.resolveCprPrice = onRequest({ region: REGION }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const { customer_code, product_code, requested_qty, order_date } = req.body

    // V1: required fields
    if (!customer_code)  return res.status(400).json({ error: 'customer_code is required' })
    if (!product_code)   return res.status(400).json({ error: 'product_code is required' })
    if (!requested_qty)  return res.status(400).json({ error: 'requested_qty is required' })
    if (!order_date)     return res.status(400).json({ error: 'order_date is required' })

    // V2: requested_qty must be positive integer
    const qty = parseInt(requested_qty, 10)
    if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: 'requested_qty must be a positive integer' })

    try {
      // Q1: Query ALL matching active CPR records
      const cprSnap = await db.collection('cpr_records')
        .where('customer_code', '==', customer_code)
        .where('product_code',  '==', product_code)
        .where('status',        '==', 'ACTIVE')
        .get()

      // Filter by date and remaining_qty in memory (Firestore composite index limitation)
      const eligible = cprSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(cpr => {
          if (cpr.remaining_qty <= 0) return false
          if (cpr.validity_from > order_date) return false
          if (cpr.validity_to   < order_date) return false
          return true
        })
        .sort((a, b) => {
          // FIFO: validity_from ASC, created_at ASC
          if (a.validity_from !== b.validity_from) {
            return a.validity_from.localeCompare(b.validity_from)
          }
          const aTime = a.created_at?.toMillis?.() ?? 0
          const bTime = b.created_at?.toMillis?.() ?? 0
          return aTime - bTime
        })

      if (eligible.length > 0) {
        // CPR path
        const total_remaining_qty = eligible.reduce((sum, cpr) => sum + (cpr.remaining_qty || 0), 0)
        const allowed             = qty <= total_remaining_qty
        const first               = eligible[0]

        const message = allowed ? null :
          `Anda tidak dapat memproses Product ${first.product_name}.\n\nPermintaan: ${qty} unit\nSisa alokasi tersedia: ${total_remaining_qty} unit\n\nUntuk tambahan alokasi silakan hubungi Sales Manager terkait.`

        return res.status(200).json({
          allowed,
          price_source:       'CPR',
          resolved_price:     first.proposed_price,
          editable:           false,
          requested_qty:      qty,
          total_remaining_qty,
          matched_cpr_ids:    eligible.map(c => c.cpr_id),
          matched_psm_numbers: eligible.map(c => c.psm_number),
          message
        })
      }

      // DBP path — no eligible CPR found
      const productSnap = await db.collection('product_registry')
        .where('product_code', '==', product_code)
        .limit(1)
        .get()

      if (productSnap.empty) {
        return res.status(404).json({ error: `Product not found: ${product_code}` })
      }

      const product = productSnap.docs[0].data()

      return res.status(200).json({
        allowed:            true,
        price_source:       'DBP',
        resolved_price:     product.dbp || 0,
        editable:           true,
        requested_qty:      qty,
        total_remaining_qty: 0,
        matched_cpr_ids:    [],
        matched_psm_numbers: [],
        message:            null
      })

    } catch (err) {
      console.error('[CPR-1B] resolveCprPrice error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
