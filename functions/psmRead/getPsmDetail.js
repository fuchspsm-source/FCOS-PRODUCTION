'use strict'
const { onRequest }                  = require('firebase-functions/v2/https')
const { db }                         = require('../db')
const { requireAuth, requireActive } = require('../middleware')
const REGION      = 'us-central1'
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN']

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

function toISO(ts) {
  if (!ts)                             return null
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString()
  if (ts instanceof Date)              return ts.toISOString()
  return String(ts)
}

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

exports.getPsmDetail = onRequest({ region: REGION }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    const psm_id = (req.query.psm_id || '').trim()
    if (!psm_id) return res.status(400).json({ error: 'psm_id is required' })

    try {
      // L1: PSM lookup
      const psmRef  = db.collection('psm_requests').doc(psm_id)
      const psmSnap = await psmRef.get()
      if (!psmSnap.exists) return res.status(404).json({ error: 'PSM not found' })
      const psm = psmSnap.data()

      // Authorization
      const callerUid = req.user.uid
      const isAdmin   = (req.user.roles || []).some(r => ADMIN_ROLES.includes(r))
      const isOwner   = psm.created_by === callerUid

      // Check if caller is current approver (need approval_request)
      let isApprover = false
      let arData     = null
      if (psm.approval_request_id) {
        const arSnap = await db.collection('approval_requests').doc(psm.approval_request_id).get()
        if (arSnap.exists) {
          arData     = arSnap.data()
          isApprover = arData.status === 'PENDING' && arData.current_approver_uid === callerUid
        }
      }

      if (!isOwner && !isAdmin && !isApprover)
        return res.status(403).json({ error: 'Access denied' })

      // Determine caller_role
      let caller_role = 'OWNER'
      if (isAdmin && !isOwner) caller_role = 'ADMIN'
      else if (isAdmin && isOwner) caller_role = 'OWNER'
      if (isApprover && !isOwner && !isAdmin) caller_role = 'APPROVER'

      // L2: PSM items
      const itemsSnap = await psmRef.collection('psm_items').get()
      const items = itemsSnap.docs.map(doc => {
        const d = doc.data()
        return {
          item_id:        d.item_id        ?? doc.id,
          product_id:     d.product_id     ?? null,
          product_code:   d.product_code   ?? null,
          product_name:   d.product_name   ?? null,
          source:         d.source         ?? null,
          dbp:            d.dbp            ?? null,
          cost:           d.cost           ?? null,
          qty:            d.qty            ?? null,
          proposed_price: d.proposed_price ?? null,
          total_sales:    d.total_sales    ?? null,
          total_cost:     d.total_cost     ?? null,
          nc:             d.nc             ?? null,
          previous_price: d.previous_price ?? null,
          previous_nc:    d.previous_nc    ?? null
        }
      })

      // L3: Approval summary (from arData already loaded above)
      let approval = null
      if (arData) {
        approval = {
          request_id:       psm.approval_request_id,
          request_number:   arData.request_number   ?? null,
          status:           arData.status            ?? null,
          approved_at:      toISO(arData.approved_at),
          approved_by:      arData.approved_by       ?? null,
          decision_comment: arData.decision_comment  ?? null,
          rejected_at:      toISO(arData.rejected_at),
          rejected_by:      arData.rejected_by       ?? null,
          current_approver_uid: arData.current_approver_uid ?? null
        }
      }

      // L4: Approval history from approval_request_actions
      let approval_history = []
      if (psm.approval_request_id) {
        const actionsSnap = await db.collection('approval_request_actions')
          .where('approval_request_id', '==', psm.approval_request_id)
          .orderBy('created_at', 'asc')
          .get()
        // Deduplicate actor_uid lookups
        const actorNameCache = new Map()
        for (const doc of actionsSnap.docs) {
          const uid = doc.data().actor_uid
          if (uid && !actorNameCache.has(uid)) {
            actorNameCache.set(uid, await getUserDisplayName(uid))
          }
        }

        approval_history = actionsSnap.docs.map(doc => {
          const d = doc.data()
          const uid = d.actor_uid ?? null
          return {
            audit_id:   d.audit_id   ?? doc.id,
            action:     d.action     ?? null,
            actor_uid:  uid,
            actor_name: uid ? actorNameCache.get(uid) : null,
            comment:    d.comment    ?? null,
            created_at: toISO(d.created_at)
          }
        })
      }

      // Computed flags
      const can_edit    = psm.status === 'DRAFT'     && caller_role === 'OWNER'
      const can_submit  = psm.status === 'DRAFT'     && caller_role === 'OWNER' && items.length > 0
      const can_recall  = psm.status === 'REJECTED'  && caller_role === 'OWNER'
      const can_approve = isApprover && (approval ? approval.status === 'PENDING' : false)

      // PSM response object
      const psmResponse = {
        psm_id:              psm_id,
        psm_number:          psm.psm_number          ?? null,
        customer_id:         psm.customer_id         ?? null,
        customer_code:       psm.customer_code       ?? null,
        customer_name:       psm.customer_name       ?? null,
        sales_uid:           psm.sales_uid           ?? null,
        sales_name:          psm.sales_name          ?? null,
        validity_from:       psm.validity_from       ?? null,
        validity_to:         psm.validity_to         ?? null,
        business_justification: psm.business_justification ?? null,
        accrual_enabled:     psm.accrual_enabled     ?? false,
        accrual_percent:     psm.accrual_percent     ?? 0,
        aggregate_nc:        psm.aggregate_nc        ?? null,
        status:              psm.status              ?? null,
        approval_request_id: psm.approval_request_id ?? null,
        created_by:          psm.created_by          ?? null,
        created_at:          toISO(psm.created_at),
        updated_at:          toISO(psm.updated_at),
        submitted_at:        toISO(psm.submitted_at),
        recalled_at:         toISO(psm.recalled_at),
        recalled_by:         psm.recalled_by         ?? null
      }

      return res.status(200).json({
        psm:              psmResponse,
        items,
        approval,
        approval_history,
        caller_role,
        can_edit,
        can_submit,
        can_recall,
        can_approve
      })

    } catch (err) {
      console.error('[psmRead] getPsmDetail:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
