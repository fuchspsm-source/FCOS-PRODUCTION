'use strict'

const { db, admin } = require('../db')
const FieldValue    = admin.firestore.FieldValue

async function createCprFromPsm(freshDataSnapshot, approvalRequestId) {
  const ps     = freshDataSnapshot.payload_snapshot || {}
  const psm_id = ps.psm_id

  if (!psm_id) {
    console.error('[CPR-1A] payload_snapshot.psm_id missing — cannot generate CPR')
    return
  }

  const psmRef  = db.collection('psm_requests').doc(psm_id)
  const psmSnap = await psmRef.get()

  if (!psmSnap.exists) {
    console.error('[CPR-1A] psm_requests doc not found:', psm_id)
    return
  }

  const psmData = psmSnap.data()

  if (psmData.status !== 'APPROVED') {
    console.warn('[CPR-1A] G1 failed — psm.status is not APPROVED:', psmData.status)
    return
  }

  if (psmData.cpr_generated === true) {
    console.warn('[CPR-1A] G2 failed — CPR already generated for psm_id:', psm_id)
    return
  }

  const items = Array.isArray(ps.items) ? ps.items : []

  if (items.length === 0) {
    console.error('[CPR-1A] payload_snapshot.items is empty — nothing to generate')
    await psmRef.update({
      cpr_generation_failed:       true,
      cpr_generation_attempted_at: FieldValue.serverTimestamp(),
      cpr_generation_error:        'payload_snapshot.items is empty',
      updated_at:                  FieldValue.serverTimestamp()
    })
    return
  }

  try {
    const batch      = db.batch()
    const now        = FieldValue.serverTimestamp()
    const created_by = freshDataSnapshot.approved_by || null

    for (const item of items) {
      const cprRef = db.collection('cpr_records').doc()

      const cprDoc = {
        cpr_id:                      cprRef.id,
        psm_id:                      psm_id,
        psm_number:                  psmData.psm_number || null,
        source_psm_id:               psm_id,
        source_psm_number:           psmData.psm_number || null,
        source_approval_request_id:  approvalRequestId || null,
        customer_code:               psmData.customer_code || null,
        customer_name:               psmData.customer_name || null,
        product_code:                item.product_code   || null,
        product_name:                item.product_name   || null,
        proposed_price:              item.proposed_price ?? 0,
        dbp:                         item.dbp            ?? 0,
        discount:                    item.nc             ?? null,
        approved_qty:                item.qty            ?? 0,
        consumed_qty:                0,
        remaining_qty:               item.qty            ?? 0,
        validity_from:               ps.validity_from    || null,
        validity_to:                 ps.validity_to      || null,
        status:                      'ACTIVE',
        created_at:                  now,
        created_by:                  created_by,
        cpr_generation_version:      1
      }

      batch.set(cprRef, cprDoc)
    }

    batch.update(psmRef, {
      cpr_generated:    true,
      cpr_generated_at: now,
      updated_at:       now
    })

    await batch.commit()
    console.log(`[CPR-1A] Generated ${items.length} CPR records for psm_id: ${psm_id}`)

  } catch (err) {
    console.error('[CPR-1A] CPR generation failed for psm_id:', psm_id, err)
    try {
      await psmRef.update({
        cpr_generation_failed:       true,
        cpr_generation_attempted_at: FieldValue.serverTimestamp(),
        cpr_generation_error:        err.message || String(err),
        updated_at:                  FieldValue.serverTimestamp()
      })
    } catch (flagErr) {
      console.error('[CPR-1A] Failed to flag cpr_generation_failed on PSM:', flagErr)
    }
  }
}

module.exports = { createCprFromPsm }
