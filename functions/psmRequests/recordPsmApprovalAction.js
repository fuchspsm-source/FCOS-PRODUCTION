'use strict'
const { onRequest }                  = require('firebase-functions/v2/https')
const { db, admin }                  = require('../db')
const { requireAuth, requireActive } = require('../middleware')
const { REQUEST_STATUS }             = require('../constants/requestStatus')
const { sendEmail, RESEND_API_KEY }  = require('../email/sendEmail')
const { buildPsmApprovalEmail }      = require('../email/buildPsmApprovalEmail')
const { buildPsmApprovedEmail }      = require('../email/buildPsmApprovedEmail')
const { buildPsmRejectedEmail }      = require('../email/buildPsmRejectedEmail')
const FieldValue                     = admin.firestore.FieldValue
const { createCprFromPsm }           = require('./createCprFromPsm')
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

exports.recordPsmApprovalAction = onRequest({ region: REGION, secrets: [RESEND_API_KEY] }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const { approval_request_id, action, comment } = req.body

    // V1: required fields
    if (!approval_request_id)
      return res.status(400).json({ error: 'approval_request_id is required' })
    if (!action)
      return res.status(400).json({ error: 'action is required' })

    // V2: action must be APPROVE or REJECT
    if (action !== 'APPROVE' && action !== 'REJECT')
      return res.status(400).json({ error: 'action must be APPROVE or REJECT' })

    // V3: comment required for REJECT
    if (action === 'REJECT') {
      if (!comment || comment.trim().length === 0)
        return res.status(400).json({ error: 'comment is required for REJECT' })
    }

    // V4: comment max 1000 chars
    if (comment && comment.trim().length > 1000)
      return res.status(400).json({ error: 'comment must not exceed 1000 characters' })

    try {
      // L1: approval_request lookup
      const arRef  = db.collection('approval_requests').doc(approval_request_id)
      const arSnap = await arRef.get()
      if (!arSnap.exists)
        return res.status(404).json({ error: 'Approval request not found' })
      const ar = arSnap.data()

      // V5: status must be PENDING
      if (ar.status !== REQUEST_STATUS.PENDING)
        return res.status(422).json({ error: 'Approval request status must be PENDING' })

      // V6: authenticated user must be current_approver_uid
      if (ar.current_approver_uid !== req.user.uid)
        return res.status(403).json({ error: 'You are not the designated approver for this request' })

      // Build audit entry (status-independent fields only)
      const auditRef = db.collection('approval_request_actions').doc()
      const auditDoc = {
        audit_id:            auditRef.id,
        approval_request_id,
        action,
        actor_uid:           req.user.uid,
        comment:             comment ? comment.trim() : null,
        created_at:          FieldValue.serverTimestamp()
      }

      let finalStatus
      let freshDataSnapshot
      let nextApproverUid = null

      // Atomic transaction: update approval_request + insert audit
      await db.runTransaction(async (tx) => {
        // Race condition guard: re-read inside transaction
        const freshSnap = await tx.get(arRef)
        if (!freshSnap.exists || freshSnap.data().status !== REQUEST_STATUS.PENDING) {
          throw Object.assign(new Error('Approval request is no longer PENDING'), { code: 409 })
        }
        const freshData = freshSnap.data()
        if (freshData.current_approver_uid !== req.user.uid) {
          throw Object.assign(new Error('You are not the designated approver for this request'), { code: 403 })
        }

        let requestUpdate

        if (action === 'APPROVE') {
          const pipeline   = Array.isArray(freshData.approval_pipeline) ? freshData.approval_pipeline : []
          const stepIndex  = Number.isInteger(freshData.current_step) ? freshData.current_step : 0
          const isLastStep = (stepIndex + 1) >= pipeline.length

          if (isLastStep) {
            requestUpdate = {
              status:           REQUEST_STATUS.APPROVED,
              approved_at:      FieldValue.serverTimestamp(),
              approved_by:      req.user.uid,
              decision_comment: comment ? comment.trim() : null,
              updated_at:       FieldValue.serverTimestamp()
            }
            finalStatus = REQUEST_STATUS.APPROVED
          } else {
            requestUpdate = {
              current_step:         stepIndex + 1,
              current_approver_uid: pipeline[stepIndex + 1],
              updated_at:           FieldValue.serverTimestamp()
            }
            finalStatus = REQUEST_STATUS.PENDING
            nextApproverUid = pipeline[stepIndex + 1]
          }
        } else {
          requestUpdate = {
            status:           REQUEST_STATUS.REJECTED,
            rejected_at:      FieldValue.serverTimestamp(),
            rejected_by:      req.user.uid,
            decision_comment: comment.trim(),
            updated_at:       FieldValue.serverTimestamp()
          }
          finalStatus = REQUEST_STATUS.REJECTED
        }

        tx.update(arRef, requestUpdate)
        tx.set(auditRef, auditDoc)

        const psm_id = freshData.payload_snapshot.psm_id

        if (finalStatus === REQUEST_STATUS.APPROVED) {
          tx.update(db.collection('psm_requests').doc(psm_id), {
            status:      'APPROVED',
            approved_at: FieldValue.serverTimestamp(),
            updated_at:  FieldValue.serverTimestamp(),
            updated_by:  req.user.uid
          })
        } else if (finalStatus === REQUEST_STATUS.REJECTED) {
          tx.update(db.collection('psm_requests').doc(psm_id), {
            status:      'REJECTED',
            rejected_at: FieldValue.serverTimestamp(),
            updated_at:  FieldValue.serverTimestamp(),
            updated_by:  req.user.uid
          })
        }

        freshDataSnapshot = freshData
      })

      // CPR-1A: Generate CPR records — non-blocking, never affects approval response
      if (finalStatus === REQUEST_STATUS.APPROVED) {
        createCprFromPsm(freshDataSnapshot, approval_request_id).catch(err => {
          console.error('[CPR-1A] Unhandled error in createCprFromPsm:', err)
        })
      }

      // EML-1C: Post-transaction notifications — non-blocking, never affects response
      try {
        const ps = freshDataSnapshot.payload_snapshot || {}

        let psm_number = null
        try {
          const psmSnap = await db.collection('psm_requests').doc(ps.psm_id).get()
          if (psmSnap.exists) psm_number = psmSnap.data().psm_number || null
        } catch (psmLookupErr) {
          console.error('[EML-1C] psm_number lookup failed:', psmLookupErr)
        }

        if (finalStatus === REQUEST_STATUS.PENDING && nextApproverUid) {
          // Notify next approver
          const approverSnap = await db.collection('users').doc(nextApproverUid).get()
          const approverData = approverSnap.exists ? approverSnap.data() : null

          if (approverData && approverData.email) {
            const { subject, html } = buildPsmApprovalEmail({
              approval_request_id,
              request_number:  freshDataSnapshot.request_number,
              summary:         freshDataSnapshot.summary,
              approver_name:   approverData.name || '',
              psm_number,
              aggregate_nc:    ps.aggregate_nc,
              validity_from:   ps.validity_from,
              validity_to:     ps.validity_to
            })
            const emailResult = await sendEmail({ to: approverData.email, subject, html })
            if (emailResult.error) {
              console.error('[EML-1C] sendEmail (next approver) failed:', emailResult.error)
            }
          } else {
            console.error('[EML-1C] Next approver email not found for uid:', nextApproverUid)
          }
        } else if (finalStatus === REQUEST_STATUS.APPROVED) {
          // Notify submitter — approved
          const submitterUid  = freshDataSnapshot.submitter_uid
          const submitterSnap = await db.collection('users').doc(submitterUid).get()
          const submitterData = submitterSnap.exists ? submitterSnap.data() : null

          if (submitterData && submitterData.email) {
            const { subject, html } = buildPsmApprovedEmail({
              approval_request_id,
              request_number:  freshDataSnapshot.request_number,
              summary:         freshDataSnapshot.summary,
              submitter_name:  submitterData.name || '',
              psm_number,
              aggregate_nc:    ps.aggregate_nc,
              validity_from:   ps.validity_from,
              validity_to:     ps.validity_to
            })
            const emailResult = await sendEmail({ to: submitterData.email, subject, html })
            if (emailResult.error) {
              console.error('[EML-1C] sendEmail (approved) failed:', emailResult.error)
            }
          } else {
            console.error('[EML-1C] Submitter email not found for uid:', submitterUid)
          }
        } else if (finalStatus === REQUEST_STATUS.REJECTED) {
          // Notify submitter — rejected
          const submitterUid  = freshDataSnapshot.submitter_uid
          const submitterSnap = await db.collection('users').doc(submitterUid).get()
          const submitterData = submitterSnap.exists ? submitterSnap.data() : null

          const rejectorSnap = await db.collection('users').doc(req.user.uid).get()
          const rejectorData = rejectorSnap.exists ? rejectorSnap.data() : null

          if (submitterData && submitterData.email) {
            const { subject, html } = buildPsmRejectedEmail({
              approval_request_id,
              request_number:    freshDataSnapshot.request_number,
              summary:           freshDataSnapshot.summary,
              submitter_name:    submitterData.name || '',
              psm_number,
              aggregate_nc:      ps.aggregate_nc,
              validity_from:     ps.validity_from,
              validity_to:       ps.validity_to,
              decision_comment:  comment.trim(),
              rejected_by_name:  (rejectorData && rejectorData.name) || ''
            })
            const emailResult = await sendEmail({ to: submitterData.email, subject, html })
            if (emailResult.error) {
              console.error('[EML-1C] sendEmail (rejected) failed:', emailResult.error)
            }
          } else {
            console.error('[EML-1C] Submitter email not found for uid:', submitterUid)
          }
        }
      } catch (emailErr) {
        console.error('[EML-1C] Notification error:', emailErr)
      }

      return res.status(200).json({
        approval_request_id,
        status: finalStatus
      })

    } catch (err) {
      if (err.code === 409) return res.status(409).json({ error: err.message })
      if (err.code === 403) return res.status(403).json({ error: err.message })
      console.error('[PSM-7] recordPsmApprovalAction:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
