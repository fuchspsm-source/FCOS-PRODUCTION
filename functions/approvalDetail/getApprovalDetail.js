'use strict'

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { db }                 = require('../db')
const { REQUEST_STATUS }     = require('../constants/requestStatus')

const REGION = 'us-central1'

async function getUserDisplayName(uid) {
  try {
    const doc = await db.collection('users').doc(uid).get()
    if (doc.exists) {
      const data = doc.data()
      return data.name || uid
    }
  } catch (_) {}
  return uid
}

exports.getApprovalDetail = onCall({ region: REGION }, async (request) => {

  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.')
  }
  const callerUid = request.auth.uid

  const raw_id     = request.data?.request_id
  const request_id = (typeof raw_id === 'string') ? raw_id.trim() : ''
  if (!request_id) {
    throw new HttpsError('invalid-argument', 'request_id is required.')
  }

  const reqRef  = db.collection('approval_requests').doc(request_id)
  const reqSnap = await reqRef.get()
  if (!reqSnap.exists) {
    throw new HttpsError('not-found', 'Approval request not found.')
  }

  const req                = reqSnap.data()
  const status             = req.status
  const currentApproverUid = req.current_approver_uid || null
  const submitterUid       = req.submitter_uid

  const isCurrentApprover = status === REQUEST_STATUS.PENDING &&
                            currentApproverUid === callerUid
  const isSubmitter       = callerUid === submitterUid

  if (!isCurrentApprover && !isSubmitter) {
    throw new HttpsError('permission-denied',
      'You do not have access to this request.')
  }

  const role   = isCurrentApprover ? 'APPROVER' : 'SUBMITTER'
  const canAct = role === 'APPROVER' && status === REQUEST_STATUS.PENDING

  const actionsSnap = await reqRef
    .collection('approval_actions')
    .orderBy('acted_at', 'asc')
    .get()

  const actions = actionsSnap.docs.map(d => d.data())

  const history = actions.map(action => {
    const item = {
      actor_name:  action.acted_by_name || action.acted_by,
      decision:    action.decision,
      acted_at:    action.acted_at.toDate().toISOString(),
      step_index:  action.step_index,
    }
    if (role === 'SUBMITTER' &&
        action.decision === REQUEST_STATUS.REJECTED &&
        action.reason) {
      item.rejection_reason = action.reason
    }
    return item
  })

  let current_approver_display_name = null
  if (status === REQUEST_STATUS.PENDING && currentApproverUid) {
    current_approver_display_name = await getUserDisplayName(currentApproverUid)
  }

  const response = {
    request_id:                    req.request_id,
    request_number:                req.request_number,
    module:                        req.module,
    summary:                       req.summary,
    status:                        status,
    submitted_at:                  req.submitted_at.toDate().toISOString(),
    payload_snapshot:              req.payload_snapshot,
    role:                          role,
    can_act:                       canAct,
    current_step:                  req.current_step,
    total_steps:                   Array.isArray(req.approval_pipeline)
                                     ? req.approval_pipeline.length : null,
    current_approver_display_name: current_approver_display_name,
    history:                       history,
  }

  if (status === REQUEST_STATUS.APPROVED || status === REQUEST_STATUS.REJECTED) {
    response.resolved_at = req.resolved_at
      ? req.resolved_at.toDate().toISOString() : null
    response.resolved_by = req.resolved_by || null
  }

  return response
})
