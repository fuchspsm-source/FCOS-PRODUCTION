'use strict'
const { onRequest }                  = require('firebase-functions/v2/https')
const { db, admin }                  = require('../db')
const { requireAuth, requireActive } = require('../middleware')
const { resolveApprover }            = require('../resolver')
const { REQUEST_STATUS }             = require('../constants/requestStatus')
const { sendEmail, RESEND_API_KEY }  = require('../email/sendEmail')
const { buildPsmApprovalEmail }      = require('../email/buildPsmApprovalEmail')
const FieldValue                     = admin.firestore.FieldValue
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

exports.createPsmApprovalRequest = onRequest({ region: REGION, secrets: [RESEND_API_KEY] }, run(
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

      // V1: PSM status must be SUBMITTED
      if (psm.status !== 'SUBMITTED')
        return res.status(422).json({ error: 'PSM status must be SUBMITTED' })

      // V2: idempotency guard
      if (psm.approval_request_id)
        return res.status(409).json({ error: 'Approval request already exists for this PSM' })

      // V3: aggregate_nc must not be null
      if (psm.aggregate_nc === null || psm.aggregate_nc === undefined)
        return res.status(422).json({ error: 'PSM aggregate_nc cannot be null' })

      // V4: required header fields
      if (!psm.validity_from || !psm.validity_to)
        return res.status(422).json({ error: 'PSM validity_from and validity_to are required' })

      if (!psm.created_by)
        return res.status(422).json({ error: 'PSM created_by is missing' })

      // L2: Read all PSM items for payload_snapshot
      const itemsSnap = await db.collection('psm_requests').doc(psm_id)
        .collection('psm_items').get()
      if (itemsSnap.empty)
        return res.status(422).json({ error: 'PSM must contain at least one item' })

      const items = itemsSnap.docs.map(doc => {
        const d = doc.data()
        return {
          item_id:        d.item_id,
          product_id:     d.product_id,
          product_code:   d.product_code,
          product_name:   d.product_name,
          source:         d.source,
          dbp:            d.dbp,
          cost:           d.cost,
          qty:            d.qty,
          proposed_price: d.proposed_price,
          total_sales:    d.total_sales,
          total_cost:     d.total_cost,
          nc:             d.nc,
          previous_price: d.previous_price,
          previous_nc:    d.previous_nc
        }
      })

      // WYSIWYS: immutable payload_snapshot — captured before resolver call
      const payload_snapshot = JSON.parse(JSON.stringify({
        psm_id,
        aggregate_nc:    psm.aggregate_nc,
        validity_from:   psm.validity_from,
        validity_to:     psm.validity_to,
        accrual_enabled: psm.accrual_enabled ?? false,
        accrual_percent: psm.accrual_percent ?? 0,
        items
      }))

      // R1: Resolve approver — identical call to createApprovalRequest.js
      let resolverResult
      try {
        resolverResult = await resolveApprover(psm.created_by, psm.aggregate_nc)
      } catch (resolverErr) {
        console.error('[PSM-6] resolveApprover failed:', resolverErr)
        return res.status(422).json({ error: resolverErr.message || 'Could not resolve approver chain' })
      }

      if (!resolverResult)
        return res.status(422).json({ error: 'No valid approver found in hierarchy' })

      // resolver_snapshot — identical structure to createApprovalRequest.js
      const resolver_snapshot = {
        matrix_version:          resolverResult.matrix_version,
        required_authority_rank: resolverResult.required_authority_rank,
        authority_owner_id:      resolverResult.authority_owner_id,
        authority_owner_name:    resolverResult.authority_owner_name,
        authority_owner_rank:    resolverResult.authority_owner_rank,
        resolution_path:         resolverResult.resolution_path
      }

      // approval_pipeline — PSM-SEQ-1: sequential hierarchy pipeline
      // Built from resolution_path, preserving traversal order, ACTIVE users only
      const approval_pipeline = resolverResult.resolution_path
        .filter(node => node.status === 'ACTIVE')
        .map(node => node.user_id)

      if (approval_pipeline.length === 0)
        return res.status(422).json({ error: 'No active approvers in resolution path' })

      // summary — max 255 chars
      const summary = ('PSM ' + (psm.psm_number || psm_id) + ' | NC: ' + psm.aggregate_nc + '% | ' + psm.validity_from + ' ~ ' + psm.validity_to).substring(0, 255)

      // counter + doc refs — identical pattern to createApprovalRequest.js
      const year       = new Date().getFullYear().toString()
      const docRef     = db.collection('approval_requests').doc()
      const request_id = docRef.id
      const counterRef = db.collection('_counters').doc('ar_PSM_' + year)

      let request_number

      // Atomic transaction — extends createApprovalRequest.js pattern with PSM link-back
      await db.runTransaction(async (tx) => {
        const counterSnap = await tx.get(counterRef)
        const last_number = counterSnap.exists ? (counterSnap.data().last_number || 0) : 0
        const next_number = last_number + 1

        // request_number — identical format to createApprovalRequest.js
        request_number = 'PSM-' + year + '-' + String(next_number).padStart(6, '0')

        // Write counter — identical to createApprovalRequest.js
        tx.set(counterRef, { last_number: next_number })

        // Write approval_requests doc — identical schema to createApprovalRequest.js
        tx.set(docRef, {
          request_id,
          request_number,
          module:                'PSM',
          payload_schema_version: 1,
          payload_snapshot,
          submitter_uid:         psm.created_by,
          resolver_snapshot,
          status:                REQUEST_STATUS.PENDING,
          submitted_at:          FieldValue.serverTimestamp(),
          approval_pipeline,
          current_step:          0,
          current_approver_uid:  approval_pipeline[0],
          summary
        })

        // PSM-6 addition: link approval_request_id back to PSM (same transaction)
        tx.update(psmRef, {
          approval_request_id: request_id,
          updated_at:          FieldValue.serverTimestamp(),
          updated_by:          req.user.uid
        })
      })

      // EML-1B: Notify first approver — non-blocking, never affects response
      try {
        const approverUid  = approval_pipeline[0]
        const approverSnap = await db.collection('users').doc(approverUid).get()
        const approverData = approverSnap.exists ? approverSnap.data() : null

        if (approverData && approverData.email) {
          const { subject, html } = buildPsmApprovalEmail({
            approval_request_id: request_id,
            request_number,
            summary,
            approver_name:  approverData.name || '',
            psm_number: psm.psm_number,
            aggregate_nc:   psm.aggregate_nc,
            validity_from:  psm.validity_from,
            validity_to:    psm.validity_to
          })

          const emailResult = await sendEmail({ to: approverData.email, subject, html })
          if (emailResult.error) {
            console.error('[EML-1B] sendEmail failed:', emailResult.error)
          }
        } else {
          console.error('[EML-1B] Approver email not found for uid:', approverUid)
        }
      } catch (emailErr) {
        console.error('[EML-1B] Notification error:', emailErr)
      }

      return res.status(200).json({
        psm_id,
        approval_request_id: request_id,
        status: REQUEST_STATUS.PENDING
      })

    } catch (err) {
      console.error('[PSM-6] createPsmApprovalRequest:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
