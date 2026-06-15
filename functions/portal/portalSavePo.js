'use strict'

const { onRequest }         = require('firebase-functions/v2/https')
const { db }                = require('../db')
const { requirePortalAuth } = require('../middleware')
const { savePoCore }        = require('../po/savePoCore')
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

// ── Internal CPR resolver (full — WITH matched_cpr_ids for consumption) ──
// Mirrors resolveCprPrice logic. Portal-facing wrapper (PO-FE-6) strips the
// CPR ids; here we need them to build the savePoCore payload.
async function resolveLinePricing(customer_code, product_code, requested_qty, order_date) {
  const cprSnap = await db.collection('cpr_records')
    .where('customer_code', '==', customer_code)
    .where('product_code',  '==', product_code)
    .where('status',        '==', 'ACTIVE')
    .get()

  const eligible = cprSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(cpr => {
      if (cpr.remaining_qty <= 0)         return false
      if (cpr.validity_from > order_date) return false
      if (cpr.validity_to   < order_date) return false
      return true
    })
    .sort((a, b) => {
      if (a.validity_from !== b.validity_from)
        return a.validity_from.localeCompare(b.validity_from)
      const aTime = a.created_at?.toMillis?.() ?? 0
      const bTime = b.created_at?.toMillis?.() ?? 0
      return aTime - bTime
    })

  if (eligible.length > 0) {
    const total_remaining_qty = eligible.reduce((s, c) => s + (c.remaining_qty || 0), 0)
    const allowed             = requested_qty <= total_remaining_qty
    const first               = eligible[0]
    return {
      allowed,
      price_source        : 'CPR',
      unit_price          : first.proposed_price,
      total_remaining_qty,
      matched_cpr_ids     : eligible.map(c => c.cpr_id || c.id),
      product_name        : first.product_name || null
    }
  }

  // DBP fallback
  const productSnap = await db.collection('product_registry')
    .where('product_code', '==', product_code)
    .limit(1)
    .get()

  if (productSnap.empty)
    return { notFound: true }

  const product = productSnap.docs[0].data()
  return {
    allowed         : true,
    price_source    : 'DBP',
    unit_price      : product.dbp || 0,
    total_remaining_qty : 0,
    matched_cpr_ids : [],
    product_name    : product.product_name || null
  }
}

exports.portalSavePo = onRequest({ region: REGION }, run(
  [requirePortalAuth],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const {
      po_reference_number,
      shipto_code,
      segment_code,
      signature_name,
      fli_sales_name,
      lines
    } = req.body || {}

    // customer_code ALWAYS from token — any client-sent value is ignored
    const customer_code = req.portalUser.customer_code
    const order_date    = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

    // ── Basic validation ──────────────────────────────────────
    if (!shipto_code?.trim())  return res.status(400).json({ error: 'shipto_code is required' })
    if (!segment_code?.trim()) return res.status(400).json({ error: 'segment_code is required' })
    if (!Array.isArray(lines) || lines.length === 0)
      return res.status(400).json({ error: 'lines must be a non-empty array' })

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].product_code) return res.status(400).json({ error: `Line ${i+1}: product_code is required` })
      const q = parseInt(lines[i].qty, 10)
      if (isNaN(q) || q <= 0) return res.status(400).json({ error: `Line ${i+1}: qty must be a positive integer` })
    }

    try {
      // ── V1: Customer must exist + active ────────────────────
      const custSnap = await db.collection('customers')
        .where('customerCode', '==', customer_code)
        .where('active', '==', true)
        .limit(1)
        .get()
      if (custSnap.empty) return res.status(404).json({ error: 'Customer not found or inactive' })
      const cust = custSnap.docs[0].data()

      // ── V2: Ship-To must belong to THIS customer ────────────
      const shipSnap = await db.collection('customerShipTos')
        .where('shipToCode', '==', shipto_code.trim().toUpperCase())
        .where('active', '==', true)
        .limit(1)
        .get()
      if (shipSnap.empty)
        return res.status(404).json({ error: 'Ship-To not found or inactive' })
      const ship = shipSnap.docs[0].data()
      if (ship.soldToCode !== customer_code)
        return res.status(403).json({ error: 'Ship-To does not belong to your customer account' })

      // ── V3: Segment must exist ──────────────────────────────
      const segSnap = await db.collection('segments')
        .where('segment_code', '==', segment_code.trim())
        .limit(1)
        .get()
      if (segSnap.empty)
        return res.status(404).json({ error: 'Segment not found' })
      const seg = segSnap.docs[0].data()

      // ── V4: Per-line server-side pricing resolution ─────────
      const resolvedLines = []
      for (let i = 0; i < lines.length; i++) {
        const reqQty = parseInt(lines[i].qty, 10)
        const pricing = await resolveLinePricing(
          customer_code, lines[i].product_code, reqQty, order_date
        )

        if (pricing.notFound)
          return res.status(404).json({ error: `Line ${i+1}: product not found: ${lines[i].product_code}` })

        if (!pricing.allowed)
          return res.status(409).json({
            error: `Line ${i+1}: quota exceeded for ${lines[i].product_code}. Requested ${reqQty}, available ${pricing.total_remaining_qty}.`
          })

        resolvedLines.push({
          product_code    : lines[i].product_code,
          product_name    : pricing.product_name || lines[i].product_code,
          qty             : reqQty,
          price_source    : pricing.price_source,
          resolved_price  : pricing.unit_price,
          final_price     : pricing.unit_price,
          matched_cpr_ids : pricing.matched_cpr_ids
        })
      }

      // ── Build normalized payload (server-resolved only) ─────
      const payload = {
        po_date          : order_date,
        po_reference_number : (po_reference_number || '').trim() || null,
        customer_code,
        customer_name    : cust.customerName,
        customer_address : cust.address || '',
        shipto_code      : ship.shipToCode,
        shipto_name      : ship.shipToName,
        shipto_address   : ship.address || '',
        segment_code     : seg.segment_code,
        segment_name     : seg.segment_name,
        // Portal-originated: actor is the portal user; no FLI sales rep mapping exists
        sales_uid        : req.portalUser.uid,
        sales_name       : (signature_name || '').trim() || cust.customerName,
        sales_email      : req.portalUser.email || '',
        fli_sales_name   : (fli_sales_name || '').trim(),
        lines            : resolvedLines
      }

      // ── Single shared transaction engine ────────────────────
      const { po_number } = await savePoCore(payload, req.portalUser.uid)

      return res.status(201).json({ ok: true, po_number, status: 'CONFIRMED' })

    } catch (err) {
      if (err.code === 400) return res.status(400).json({ error: err.message })
      if (err.code === 409) return res.status(409).json({ error: err.message })
      console.error('[portal] portalSavePo:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
