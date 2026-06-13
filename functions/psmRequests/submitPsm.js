'use strict'
const { onRequest }                  = require('firebase-functions/v2/https')
const { db, admin }                  = require('../db')
const { requireAuth, requireActive } = require('../middleware')
const FieldValue                     = admin.firestore.FieldValue
const REGION = 'us-central1'

const ROMAN_MONTHS = [
  'I', 'II', 'III', 'IV', 'V', 'VI',
  'VII', 'VIII', 'IX', 'X', 'XI', 'XII'
]

const LEGAL_PREFIX_PATTERN = /^(PT\.?|CV\.?|TBK\.?)\s+/i
const LEGAL_SUFFIX_PATTERN = /\s+(TBK\.?)$/i

function buildCustomerInitials(customerName) {
  let name = (customerName || '').trim()
  name = name.replace(/^\.+/, '').trim()
  name = name.replace(LEGAL_PREFIX_PATTERN, '')
  name = name.replace(LEGAL_SUFFIX_PATTERN, '')
  name = name.trim()

  const words = name.split(/\s+/).filter(Boolean)
  const initials = words.map(w => w.charAt(0).toUpperCase()).join('')
  return initials || 'XXX'
}

function buildSalesSegment(salesName) {
  const cleaned = (salesName || '').trim().replace(/\s+/g, '')
  const segment = cleaned.substring(0, 5).toUpperCase()
  return segment || 'XXXXX'
}

function buildPsmNumber(runningNumber, salesName, customerName, year) {
  const running   = String(runningNumber).padStart(3, '0')
  const salesSeg  = buildSalesSegment(salesName)
  const custSeg   = buildCustomerInitials(customerName)
  const month     = ROMAN_MONTHS[new Date().getMonth()]
  return running + '-PSMFLI-' + salesSeg + '-' + custSeg + '-' + month + '-' + year
}

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

exports.submitPsm = onRequest({ region: REGION }, run(
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

      // V1: Caller must be PSM owner
      if (psm.created_by !== req.user.uid)
        return res.status(403).json({ error: 'Only PSM owner can submit' })

      // V2: PSM must be DRAFT
      if (psm.status !== 'DRAFT')
        return res.status(422).json({ error: 'PSM status must be DRAFT' })

      // V3: At least one item exists
      const itemsSnap = await db.collection('psm_requests').doc(psm_id)
        .collection('psm_items')
        .limit(1)
        .get()
      if (itemsSnap.empty)
        return res.status(422).json({ error: 'PSM must contain at least one item' })

      // V4: aggregate_nc is not null
      if (psm.aggregate_nc === null || psm.aggregate_nc === undefined)
        return res.status(422).json({ error: 'PSM aggregate margin cannot be null' })

      // W1: Atomic transaction - recheck V1/V2/V4, generate psm_number, update to SUBMITTED
      let psm_number
      await db.runTransaction(async (tx) => {
        const freshSnap = await tx.get(psmRef)
        if (!freshSnap.exists)
          throw Object.assign(new Error('PSM not found'), { code: 404 })
        const freshPsm = freshSnap.data()

        if (freshPsm.created_by !== req.user.uid)
          throw Object.assign(new Error('Only PSM owner can submit'), { code: 403 })

        if (freshPsm.status !== 'DRAFT')
          throw Object.assign(new Error('PSM status must be DRAFT'), { code: 422 })

        if (freshPsm.aggregate_nc === null || freshPsm.aggregate_nc === undefined)
          throw Object.assign(new Error('PSM aggregate margin cannot be null'), { code: 422 })

        const year        = new Date().getFullYear()
        const counterRef  = db.collection('_counters').doc('psm_doc_' + year)
        const counterSnap = await tx.get(counterRef)
        const last_number = counterSnap.exists ? (counterSnap.data().last_number || 0) : 0
        const next_number = last_number + 1

        psm_number = buildPsmNumber(next_number, freshPsm.sales_name, freshPsm.customer_name, year)

        tx.set(counterRef, { last_number: next_number })
        tx.update(psmRef, {
          status:        'SUBMITTED',
          psm_number:    psm_number,
          submitted_at:  FieldValue.serverTimestamp(),
          submitted_by:  req.user.uid,
          updated_at:    FieldValue.serverTimestamp(),
          updated_by:    req.user.uid
        })
      })

      return res.status(200).json({ ok: true, psm_id, status: 'SUBMITTED', psm_number })

    } catch (err) {
      if (err.code === 404) return res.status(404).json({ error: err.message })
      if (err.code === 403) return res.status(403).json({ error: err.message })
      if (err.code === 422) return res.status(422).json({ error: err.message })
      console.error('[psmRequests] submitPsm:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
