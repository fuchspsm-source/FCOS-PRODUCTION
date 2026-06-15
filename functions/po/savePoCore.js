'use strict'

const { db, admin }  = require('../db')
const { writeAudit } = require('../audit')
const FieldValue     = admin.firestore.FieldValue

// ============================================================
// savePoCore — shared PO save business logic
// Used by both savePo (FCOS internal) and portalSavePo (external).
//
// Params:
//   payload  : {
//     po_date, customer_code, customer_name, customer_address,
//     shipto_code, shipto_name, shipto_address,
//     segment_code, segment_name,
//     sales_uid, sales_name, sales_email,
//     lines: [{ product_code, product_name, qty, price_source,
//               resolved_price, final_price, matched_cpr_ids }]
//   }
//   actorUid : string — the uid recorded as created_by / consumed_by / audit actor
//
// Returns: { po_number }
// Throws:  Error with .code (400 | 409) for caller to map to HTTP status
// ============================================================
async function savePoCore(payload, actorUid) {
  const {
    po_date, customer_code, customer_name, customer_address,
    shipto_code, shipto_name, shipto_address,
    segment_code, segment_name,
    sales_uid, sales_name, sales_email,
    fli_sales_name,
    lines
  } = payload || {}

  const fail = (msg, code) => { throw Object.assign(new Error(msg), { code }) }

  // ── Validation ────────────────────────────────────────────
  if (!po_date)       fail('po_date is required', 400)
  if (!customer_code) fail('customer_code is required', 400)
  if (!customer_name) fail('customer_name is required', 400)
  if (!shipto_code)   fail('shipto_code is required', 400)
  if (!segment_code)  fail('segment_code is required', 400)
  if (!sales_uid)     fail('sales_uid is required', 400)

  if (!Array.isArray(lines) || lines.length === 0)
    fail('lines must be a non-empty array', 400)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.product_code) fail(`Line ${i+1}: product_code is required`, 400)
    if (!line.product_name) fail(`Line ${i+1}: product_name is required`, 400)
    const qty = parseInt(line.qty, 10)
    if (isNaN(qty) || qty <= 0) fail(`Line ${i+1}: qty must be a positive integer`, 400)
    if (!line.price_source || !['CPR','DBP'].includes(line.price_source))
      fail(`Line ${i+1}: price_source must be CPR or DBP`, 400)
    const finalPrice = Number(line.final_price)
    if (isNaN(finalPrice) || finalPrice < 0)
      fail(`Line ${i+1}: final_price must be a non-negative number`, 400)
  }

  // Collect unique CPR IDs
  const allCprIds = []
  for (const line of lines) {
    if (line.price_source === 'CPR' && Array.isArray(line.matched_cpr_ids)) {
      for (const id of line.matched_cpr_ids) {
        if (!allCprIds.includes(id)) allCprIds.push(id)
      }
    }
  }

  let po_number
  let finalSubtotal = 0

  await db.runTransaction(async (tx) => {

    // ── PHASE 1: ALL READS FIRST ──────────────────────────────
    const year        = new Date().getFullYear()
    const counterRef  = db.collection('_counters').doc('po_' + year)
    const counterSnap = await tx.get(counterRef)

    const cprSnapMap = {}
    for (const cpr_id of allCprIds) {
      const snap = await tx.get(db.collection('cpr_records').doc(cpr_id))
      if (!snap.exists)
        throw Object.assign(new Error(`CPR record not found: ${cpr_id}`), { code: 409 })
      cprSnapMap[cpr_id] = snap
    }

    // ── PHASE 2: VALIDATE + BUILD CONSUMPTION PLAN ───────────
    const workingQty      = {}
    const consumptionPlan = []
    for (const id of allCprIds) {
      workingQty[id] = cprSnapMap[id].data().remaining_qty
    }

    for (const line of lines) {
      if (line.price_source !== 'CPR') continue
      const cprIds = Array.isArray(line.matched_cpr_ids) ? line.matched_cpr_ids : []
      if (cprIds.length === 0) continue

      let remaining_to_consume = parseInt(line.qty, 10)

      for (const cpr_id of cprIds) {
        if (remaining_to_consume <= 0) break
        const cprData = cprSnapMap[cpr_id].data()

        if (cprData.status !== 'ACTIVE' || workingQty[cpr_id] <= 0)
          throw Object.assign(
            new Error(`CPR allocation no longer available for product ${line.product_code}. Please re-check pricing.`),
            { code: 409 }
          )

        const consume = Math.min(remaining_to_consume, workingQty[cpr_id])
        const before  = workingQty[cpr_id]
        const after   = before - consume

        consumptionPlan.push({ cpr_id, consume, before, after, product_code: line.product_code, cprData })
        workingQty[cpr_id]   = after
        remaining_to_consume -= consume
      }

      if (remaining_to_consume > 0)
        throw Object.assign(
          new Error(`Insufficient CPR allocation for product ${line.product_code}. Shortfall: ${remaining_to_consume}`),
          { code: 409 }
        )
    }

    // ── PHASE 3: ALL WRITES ───────────────────────────────────
    const now         = FieldValue.serverTimestamp()
    const last_number = counterSnap.exists ? (counterSnap.data().last_number || 0) : 0
    const next_number = last_number + 1
    po_number         = 'PO-' + year + '-' + String(next_number).padStart(6, '0')

    tx.set(counterRef, { last_number: next_number })

    let subtotal = 0
    for (let i = 0; i < lines.length; i++) {
      const line       = lines[i]
      const qty        = parseInt(line.qty, 10)
      const finalPrice = Number(line.final_price)
      const lineTotal  = qty * finalPrice
      subtotal        += lineTotal

      tx.set(db.collection('po_lines').doc(), {
        po_number,
        line_number     : i + 1,
        product_code    : line.product_code,
        product_name    : line.product_name,
        qty,
        price_source    : line.price_source,
        resolved_price  : Number(line.resolved_price) || 0,
        final_price     : finalPrice,
        line_total      : lineTotal,
        matched_cpr_ids : Array.isArray(line.matched_cpr_ids) ? line.matched_cpr_ids : [],
        created_at      : now
      })
    }

    finalSubtotal     = subtotal
    const vat_amount  = Math.round(subtotal * 0.11)
    const grand_total = subtotal + vat_amount

    tx.set(db.collection('po_headers').doc(po_number), {
      po_number,
      po_reference_number : payload.po_reference_number || null,
      po_date,
      customer_code,
      customer_name,
      customer_address : customer_address || '',
      shipto_code,
      shipto_name      : shipto_name    || '',
      shipto_address   : shipto_address || '',
      segment_code,
      segment_name     : segment_name   || '',
      sales_uid,
      sales_name       : sales_name     || '',
      sales_email      : sales_email    || '',
      fli_sales_name   : fli_sales_name || '',
      total_lines      : lines.length,
      subtotal,
      vat_amount,
      grand_total,
      status           : 'CONFIRMED',
      created_by       : actorUid,
      created_at       : now,
      updated_by       : actorUid,
      updated_at       : now
    })

    for (const plan of consumptionPlan) {
      tx.update(db.collection('cpr_records').doc(plan.cpr_id), {
        remaining_qty : plan.after,
        status        : plan.after === 0 ? 'EXHAUSTED' : 'ACTIVE',
        updated_at    : now
      })

      tx.set(db.collection('cpr_consumption_logs').doc(), {
        cpr_id               : plan.cpr_id,
        psm_id               : plan.cprData.psm_id     || null,
        psm_number           : plan.cprData.psm_number || null,
        po_number,
        customer_code,
        product_code         : plan.product_code,
        qty_consumed         : plan.consume,
        before_remaining_qty : plan.before,
        after_remaining_qty  : plan.after,
        consumed_at          : now,
        consumed_by          : actorUid
      })
    }
  })

  await writeAudit('PO_CREATED', actorUid, po_number, {
    po_number,
    customer_code,
    line_count  : lines.length,
    grand_total : Math.round(finalSubtotal * 1.11)
  })

  return { po_number }
}

module.exports = { savePoCore }
