'use strict'

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { db, admin }          = require('../db')
const { resolveApprover }    = require('../resolver')
const { REQUEST_STATUS }     = require('../constants/requestStatus')

// ─── Validation helpers ───────────────────────────────────────────────────────

const MODULE_RE = /^[A-Z]{2,6}$/

function validateInputs (data) {
  // V2: module — string, uppercase alpha, length 2–6
  if (typeof data.module !== 'string' || !MODULE_RE.test(data.module)) {
    throw new HttpsError(
      'invalid-argument',
      'module must be an uppercase alphabetic string of 2–6 characters.'
    )
  }

  // V3: payload — non-null object
  if (data.payload === null || typeof data.payload !== 'object' || Array.isArray(data.payload)) {
    throw new HttpsError(
      'invalid-argument',
      'payload must be a non-null object.'
    )
  }

  // V4: payload_schema_version — integer >= 1
  const psv = data.payload_schema_version
  if (!Number.isInteger(psv) || psv < 1) {
    throw new HttpsError(
      'invalid-argument',
      'payload_schema_version must be an integer >= 1.'
    )
  }

  // V5: resolver_input — required object
  if (data.resolver_input === null || typeof data.resolver_input !== 'object' || Array.isArray(data.resolver_input)) {
    throw new HttpsError(
      'invalid-argument',
      'resolver_input must be a non-null object.'
    )
  }

  // V5a: resolver_input.nc_value — finite number
  const nc = data.resolver_input.nc_value
  if (typeof nc !== 'number' || !Number.isFinite(nc)) {
    throw new HttpsError(
      'invalid-argument',
      'resolver_input.nc_value must be a finite number.'
    )
  }

  // V6: summary — required string, non-empty after trim, max 255 chars
  if (typeof data.summary !== 'string') {
    throw new HttpsError('invalid-argument', 'summary must be a string.')
  }
  if (data.summary.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'summary must not be empty.')
  }
  if (data.summary.trim().length > 255) {
    throw new HttpsError('invalid-argument', 'summary must not exceed 255 characters.')
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

const createApprovalRequest = onCall(async (request) => {
  // V1: authenticated user required
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError(
      'unauthenticated',
      'Authentication required.'
    )
  }

  const submitter_uid = request.auth.uid
  const data          = request.data

  // Validate all inputs — fail fast, no writes, no resolver call
  validateInputs(data)

  // ── WYSIWYS: capture payload_snapshot before any async call ──────────────
  // Deep-copy at this exact moment. No async operations precede this line.
  // Engine never reads inside payload_snapshot after capture.
  const payload_snapshot = JSON.parse(JSON.stringify(data.payload))
  // ─────────────────────────────────────────────────────────────────────────

  const module                 = data.module
  const payload_schema_version = data.payload_schema_version
  const nc_value               = data.resolver_input.nc_value
  const summary                = data.summary.trim()

  // Resolve approver — read-only, module-agnostic
  // Engine passes nc_value through directly — no interpretation of meaning
  // Forbidden: payload.nc_value / payload.margin / any payload field access
  const resolverResult = await resolveApprover(submitter_uid, nc_value)

  if (!resolverResult) {
    throw new HttpsError(
      'not-found',
      'Could not resolve an approver for this request. No valid approver found in hierarchy.'
    )
  }

  // Capture full resolver snapshot exactly as returned — no transformation
  const resolver_snapshot = {
    matrix_version:          resolverResult.matrix_version,
    required_authority_rank: resolverResult.required_authority_rank,
    authority_owner_id:      resolverResult.authority_owner_id,
    authority_owner_name:    resolverResult.authority_owner_name,
    authority_owner_rank:    resolverResult.authority_owner_rank,
    resolution_path:         resolverResult.resolution_path
  }

  // Derive approval_pipeline from resolution_path
  // Filter: ACTIVE users only. Map: user_id only. Order: preserved from resolver.
  const approval_pipeline = resolverResult.resolution_path
    .filter(node => node.status === 'ACTIVE')
    .map(node => node.user_id)

  if (approval_pipeline.length === 0) {
    throw new HttpsError(
      'internal',
      'No active approvers in resolution path. Cannot create approval pipeline.'
    )
  }

  // Determine submission year for counter key and request_number
  const year = new Date().getFullYear().toString()

  // Generate Firestore document ID
  const docRef     = db.collection('approval_requests').doc()
  const request_id = docRef.id

  // Counter document path: _counters/ar_{MODULE}_{YYYY}
  const counterRef = db.collection('_counters').doc(`ar_${module}_${year}`)

  let request_number

  // Atomic transaction: counter increment + document creation
  await db.runTransaction(async (tx) => {
    const counterSnap = await tx.get(counterRef)
    const last_number = counterSnap.exists ? (counterSnap.data().last_number || 0) : 0
    const next_number = last_number + 1

    // Format: {MODULE}-{YYYY}-{NNNNNN} zero-padded 6 digits
    request_number = `${module}-${year}-${String(next_number).padStart(6, '0')}`

    // Write counter
    tx.set(counterRef, { last_number: next_number })

    // Write approval_requests document
    tx.set(docRef, {
      request_id,
      request_number,
      module,
      payload_schema_version,
      payload_snapshot,
      submitter_uid,
      resolver_snapshot,
      status:            REQUEST_STATUS.PENDING,
      submitted_at:      admin.firestore.FieldValue.serverTimestamp(),
      approval_pipeline:    approval_pipeline,
      current_step:         0,
      current_approver_uid: approval_pipeline[0],
      summary
    })
  })

  return { request_id, request_number }
})

module.exports = { createApprovalRequest }
