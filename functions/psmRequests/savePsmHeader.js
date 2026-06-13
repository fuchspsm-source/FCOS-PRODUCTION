'use strict'

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { db, admin }          = require('../db')

const REGION = 'us-central1'

// YYYY-MM-DD regex
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Validate that a YYYY-MM-DD string is a real calendar date
// e.g. "2026-02-30" must be rejected
function isValidCalendarDate(str) {
  const [y, m, d] = str.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth()    === m - 1 &&
    dt.getUTCDate()     === d
  )
}

exports.savePsmHeader = onCall({ region: REGION }, async (request) => {

  // V1: Authentication
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.')
  }
  const callerUid = request.auth.uid

  // V2: psm_id required
  const raw_psm_id = request.data?.psm_id
  if (!raw_psm_id || typeof raw_psm_id !== 'string' || raw_psm_id.trim() === '') {
    throw new HttpsError('invalid-argument', 'psm_id is required.')
  }
  const psm_id = raw_psm_id.trim()

  // V3: validity_to required — must be string, YYYY-MM-DD, valid calendar date
  const validity_to = request.data?.validity_to
  if (validity_to === undefined || validity_to === null) {
    throw new HttpsError('invalid-argument', 'validity_to is required.')
  }
  if (typeof validity_to !== 'string' || !DATE_RE.test(validity_to)) {
    throw new HttpsError('invalid-argument',
      'validity_to must be a string in YYYY-MM-DD format.')
  }
  if (!isValidCalendarDate(validity_to)) {
    throw new HttpsError('invalid-argument',
      'validity_to is not a valid calendar date.')
  }

  // V4: accrual_enabled required — must be boolean
  const accrual_enabled = request.data?.accrual_enabled
  if (accrual_enabled === undefined || accrual_enabled === null) {
    throw new HttpsError('invalid-argument', 'accrual_enabled is required.')
  }
  if (typeof accrual_enabled !== 'boolean') {
    throw new HttpsError('invalid-argument',
      'accrual_enabled must be a boolean.')
  }

  // V5: accrual_percent required — must be number, 0–100
  const accrual_percent = request.data?.accrual_percent
  if (accrual_percent === undefined || accrual_percent === null) {
    throw new HttpsError('invalid-argument', 'accrual_percent is required.')
  }
  if (typeof accrual_percent !== 'number' || isNaN(accrual_percent)) {
    throw new HttpsError('invalid-argument',
      'accrual_percent must be a number.')
  }
  if (accrual_percent < 0 || accrual_percent > 100) {
    throw new HttpsError('invalid-argument',
      'accrual_percent must be between 0 and 100.')
  }

  // V_BIZ: business_justification required - string, trimmed, min 10 chars
  const raw_business_justification = request.data?.business_justification
  if (raw_business_justification === undefined || raw_business_justification === null) {
    throw new HttpsError('invalid-argument', 'business_justification is required.')
  }
  if (typeof raw_business_justification !== 'string') {
    throw new HttpsError('invalid-argument', 'business_justification must be a string.')
  }
  const business_justification = raw_business_justification.trim()
  if (business_justification.length < 10) {
    throw new HttpsError('invalid-argument',
      'business_justification must be at least 10 characters.')
  }

  // V6: Read PSM document
  const psmRef  = db.collection('psm_requests').doc(psm_id)
  const psmSnap = await psmRef.get()

  if (!psmSnap.exists) {
    throw new HttpsError('not-found', 'PSM document not found.')
  }

  const psm = psmSnap.data()

  // V7: Owner-only — only created_by may modify
  if (psm.created_by !== callerUid) {
    throw new HttpsError('permission-denied',
      'Only the creator can modify this PSM draft.')
  }

  // V8: Status guard — only DRAFT allowed
  if (psm.status !== 'DRAFT') {
    throw new HttpsError('failed-precondition',
      `PSM status is '${psm.status}'. Only DRAFT can be modified.`)
  }

  // V9: validity_to >= validity_from
  // Both are YYYY-MM-DD strings — lexicographic comparison is correct for ISO dates
  if (validity_to < psm.validity_from) {
    throw new HttpsError('invalid-argument',
      'validity_to must be on or after validity_from.')
  }

  // Update — only the three allowed fields + updated_at
  await psmRef.update({
    validity_to,
    accrual_enabled,
    accrual_percent,
    business_justification,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  })

  return {
    psm_id,
    status:     'DRAFT',
    updated_at: new Date().toISOString(),
  }
})
