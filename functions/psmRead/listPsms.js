'use strict'
const { onRequest }                  = require('firebase-functions/v2/https')
const { db, admin }                  = require('../db')
const { requireAuth, requireActive } = require('../middleware')
const REGION = 'us-central1'

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE     = 100
const ADMIN_ROLES       = ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN']

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

function buildItem(doc) {
  const d = doc.data()
  return {
    psm_id:              doc.id,
    psm_number:          d.psm_number          ?? null,
    customer_code:       d.customer_code        ?? null,
    customer_name:       d.customer_name        ?? null,
    validity_from:       d.validity_from        ?? null,
    validity_to:         d.validity_to          ?? null,
    aggregate_nc:        d.aggregate_nc         ?? null,
    status:              d.status               ?? null,
    approval_request_id: d.approval_request_id  ?? null,
    created_by:          d.created_by           ?? null,
    created_at:          toISO(d.created_at),
    updated_at:          toISO(d.updated_at)
  }
}

exports.listPsms = onRequest({ region: REGION }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    // P1: page_size
    let pageSize = parseInt(req.query.page_size) || DEFAULT_PAGE_SIZE
    if (isNaN(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
      return res.status(400).json({ error: 'page_size must be between 1 and 100' })

    // P2: status filter (optional)
    const statusFilter = req.query.status || null
    const VALID_STATUSES = ['DRAFT', 'SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED']
    if (statusFilter && !VALID_STATUSES.includes(statusFilter))
      return res.status(400).json({ error: 'Invalid status. Must be one of: ' + VALID_STATUSES.join(', ') })

    // P3: cursor (optional ISO string)
    const rawCursor = req.query.cursor || null
    let cursorTimestamp = null
    if (rawCursor) {
      const d = new Date(rawCursor)
      if (isNaN(d.getTime()))
        return res.status(400).json({ error: 'cursor must be a valid ISO 8601 timestamp' })
      cursorTimestamp = admin.firestore.Timestamp.fromDate(d)
    }

    // Authorization: admin sees all, non-admin sees own only
    const isAdmin = (req.user.roles || []).some(r => ADMIN_ROLES.includes(r))

    try {
      // Build query
      let q = db.collection('psm_requests').orderBy('created_at', 'desc')

      if (!isAdmin) q = q.where('created_by', '==', req.user.uid)
      if (statusFilter) q = q.where('status', '==', statusFilter)
      if (cursorTimestamp) q = q.startAfter(cursorTimestamp)

      q = q.limit(pageSize + 1)

      const snap = await q.get()
      const docs = snap.docs

      const hasMore       = docs.length > pageSize
      const docsToProcess = hasMore ? docs.slice(0, pageSize) : docs

      // Cursor from last doc in window
      const lastDoc = docsToProcess.length > 0 ? docsToProcess[docsToProcess.length - 1] : null
      const cursor  = (hasMore && lastDoc) ? toISO(lastDoc.data().created_at) : null

      const items = docsToProcess.map(buildItem)

      return res.status(200).json({
        items,
        cursor,
        has_more:      hasMore,
        total_in_page: items.length
      })

    } catch (err) {
      console.error('[psmRead] listPsms:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
