'use strict'

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { db, admin }          = require('../db')
const { REQUEST_STATUS }     = require('../constants/requestStatus')

// ─── WYSIWYS integrity checks ─────────────────────────────────────────────────
// I1–I5: original frozen checks (unchanged)
// I6–I7: 3C-2-R2 additions for sequential chain

function checkWYSIWYS (data) {
  // I1: payload_snapshot non-null object
  if (data.payload_snapshot === null ||
      typeof data.payload_snapshot !== 'object' ||
      Array.isArray(data.payload_snapshot)) {
    throw new HttpsError('internal', 'payload_snapshot missing or corrupt.')
  }

  // I2: payload_schema_version integer >= 1
  const psv = data.payload_schema_version
  if (!Number.isInteger(psv) || psv < 1) {
    throw new HttpsError('internal', 'payload_schema_version missing or corrupt.')
  }

  const rs = data.resolver_snapshot || {}

  // I3: authority_owner_id non-empty string
  if (typeof rs.authority_owner_id !== 'string' || rs.authority_owner_id.trim().length === 0) {
    throw new HttpsError('internal', 'resolver_snapshot.authority_owner_id missing or corrupt.')
  }

  // I4: resolution_path non-empty array
  if (!Array.isArray(rs.resolution_path) || rs.resolution_path.length === 0) {
    throw new HttpsError('internal', 'resolver_snapshot.resolution_path missing or corrupt.')
  }

  // I5: matrix_version non-empty string
  if (typeof rs.matrix_version !== 'string' || rs.matrix_version.trim().length === 0) {
    throw new HttpsError('internal', 'resolver_snapshot.matrix_version missing or corrupt.')
  }

  // I6: approval_pipeline non-empty array (3C-2-R2)
  if (!Array.isArray(data.approval_pipeline) || data.approval_pipeline.length === 0) {
    throw new HttpsError('internal', 'approval_pipeline missing or corrupt.')
  }

  // I7: current_step valid index into approval_pipeline (3C-2-R2)
  const step = data.current_step
  if (!Number.isInteger(step) || step < 0 || step >= data.approval_pipeline.length) {
    throw new HttpsError('internal', 'current_step missing or out of bounds.')
  }

  // I8: current_approver_uid not null while status PENDING (3C-2-R3)
  if (data.status === REQUEST_STATUS.PENDING) {
    if (!data.current_approver_uid || data.current_approver_uid.trim() === '') {
      throw new HttpsError('failed-precondition',
        'current_approver_uid is null while status is PENDING. Ownership invariant violated.')
    }

    // I9: current_approver_uid === approval_pipeline[current_step] (3C-2-R3)
    if (data.current_approver_uid !== data.approval_pipeline[step]) {
      throw new HttpsError('failed-precondition',
        'current_approver_uid does not match approval_pipeline[current_step]. Ownership invariant violated.')
    }
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

const recordApprovalAction = onCall(async (request) => {

  // V1: authenticated user required
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.')
  }

  const uid  = request.auth.uid
  const data = request.data

  // V2: request_id non-empty string
  if (typeof data.request_id !== 'string' || data.request_id.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'request_id must be a non-empty string.')
  }

  // V3: decision must be exactly APPROVED or REJECTED
  if (data.decision !== REQUEST_STATUS.APPROVED && data.decision !== REQUEST_STATUS.REJECTED) {
    throw new HttpsError(
      'invalid-argument',
      'decision must be exactly "APPROVED" or "REJECTED".'
    )
  }

  const decision = data.decision

  // V4: reason policy
  // REJECTED: reason required, non-empty string
  // APPROVED: reason ignored, not stored
  let reason
  if (decision === REQUEST_STATUS.REJECTED) {
    if (typeof data.reason !== 'string' || data.reason.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'reason is required for REJECTED decisions.')
    }
    reason = data.reason.trim()
  }

  const request_id = data.request_id.trim()

  // V5: read approval_requests document — must exist
  const reqRef  = db.collection('approval_requests').doc(request_id)
  const reqSnap = await reqRef.get()

  if (!reqSnap.exists) {
    throw new HttpsError('not-found', `approval_request ${request_id} not found.`)
  }

  const reqData = reqSnap.data()

  // V6: status must be PENDING (pre-tx check)
  if (reqData.status !== REQUEST_STATUS.PENDING) {
    throw new HttpsError(
      'failed-precondition',
      `Request is no longer PENDING. Current status: ${reqData.status}.`
    )
  }

  // I1–I7: WYSIWYS + pipeline integrity checks
  checkWYSIWYS(reqData)

  // V8: acting user must be the current step owner (3C-2-R2)
  // Replaces: uid !== authority_owner_id
  const approval_pipeline = reqData.approval_pipeline
  const current_step      = reqData.current_step
  const expected_actor    = approval_pipeline[current_step]

  if (uid !== expected_actor) {
    throw new HttpsError(
      'permission-denied',
      'You are not the designated approver for the current step.'
    )
  }

  // Determine approval case
  const is_final_step = (current_step === approval_pipeline.length - 1)

  // Read acting user display name
  const userSnap      = await db.collection('users').doc(uid).get()
  const acted_by_name = userSnap.exists ? (userSnap.data().name || '') : ''

  // Generate action document reference
  const actionRef = reqRef.collection('approval_actions').doc()
  const action_id = actionRef.id

  // Construct action document
  // step_index: records chain position at time of action — immutable audit field
  // reason: included ONLY for REJECTED decisions
  const actionDocument = {
    action_id,
    request_id,
    decision,
    acted_by:      uid,
    acted_by_name,
    acted_at:      admin.firestore.FieldValue.serverTimestamp(),
    step_index:    current_step,
    ...(decision === REQUEST_STATUS.REJECTED && { reason })
  }

  // ── Decision matrix ────────────────────────────────────────────────────────
  // Case A: APPROVED + intermediate step → STEP_ADVANCE (current_step + 1)
  // Case B: APPROVED + final step        → FINAL_RESOLUTION (APPROVED)
  // Case C: REJECTED at any step         → FINAL_RESOLUTION (REJECTED)

  let requestUpdate
  let workflow_status

  if (decision === REQUEST_STATUS.APPROVED && !is_final_step) {
    // Case A — intermediate approval, workflow continues
    requestUpdate = {
      current_step:         current_step + 1,
      current_approver_uid: approval_pipeline[current_step + 1]
    }
    workflow_status = 'ADVANCED'

  } else if (decision === REQUEST_STATUS.APPROVED && is_final_step) {
    // Case B — final approval, workflow complete
    requestUpdate = {
      status:               REQUEST_STATUS.APPROVED,
      resolved_at:          admin.firestore.FieldValue.serverTimestamp(),
      resolved_by:          uid,
      current_approver_uid: null
    }
    workflow_status = 'COMPLETED'

  } else {
    // Case C — rejection, terminal at any step
    requestUpdate = {
      status:               REQUEST_STATUS.REJECTED,
      resolved_at:          admin.firestore.FieldValue.serverTimestamp(),
      resolved_by:          uid,
      current_approver_uid: null
    }
    workflow_status = 'REJECTED'
  }

  // ── Firestore transaction ──────────────────────────────────────────────────
  await db.runTransaction(async (tx) => {

    // V9a: re-read inside transaction — status race guard
    const freshSnap = await tx.get(reqRef)
    if (!freshSnap.exists || freshSnap.data().status !== REQUEST_STATUS.PENDING) {
      throw new HttpsError(
        'failed-precondition',
        'Request is no longer PENDING. Another action may have been submitted concurrently.'
      )
    }

    // V9b: stale step guard — concurrent step-advance protection (3C-2-R2)
    if (freshSnap.data().current_step !== current_step) {
      throw new HttpsError(
        'failed-precondition',
        'Workflow step has advanced. Another action may have been submitted concurrently.'
      )
    }

    // Write action to subcollection
    tx.set(actionRef, actionDocument)

    // Update request document — STEP_ADVANCE (Case A) or FINAL_RESOLUTION (Cases B/C)
    tx.update(reqRef, requestUpdate)
  })

  return {
    action_id,
    decision,
    request_number: reqData.request_number,
    workflow_status
  }
})

module.exports = { recordApprovalAction }
