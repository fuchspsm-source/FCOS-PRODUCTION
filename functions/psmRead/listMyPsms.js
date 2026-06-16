'use strict'
const { onRequest }                  = require('firebase-functions/v2/https')
const { db, admin }                  = require('../db')
const { requireAuth, requireActive } = require('../middleware')
const REGION     = 'us-central1'
const PAGE_SIZE  = 10
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

function buildItem(doc, userMap) {
  const d = doc.data()
  const createdByUid = d.created_by ?? null
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
    created_by:          createdByUid,
    created_by_name:     (userMap && userMap[createdByUid]) ? userMap[createdByUid] : createdByUid,
    created_at:          toISO(d.created_at),
    updated_at:          toISO(d.updated_at)
  }
}

async function buildUserMap(docs) {
  const uids = [...new Set(docs.map(d => d.data().created_by).filter(Boolean))]
  if (uids.length === 0) return {}
  const userMap = {}
  const chunks = []
  for (let i = 0; i < uids.length; i += 10) chunks.push(uids.slice(i, i + 10))
  for (const chunk of chunks) {
    const snaps = await db.collection('users')
      .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
      .select('name')
      .get()
    snaps.docs.forEach(d => { userMap[d.id] = d.data().name || d.id })
  }
  return userMap
}

exports.listMyPsms = onRequest({ region: REGION }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    const statusFilter = req.query.status || null
    const VALID_STATUSES = ['DRAFT', 'SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED']
    if (statusFilter && !VALID_STATUSES.includes(statusFilter))
      return res.status(400).json({ error: 'Invalid status' })

    let pageSize = parseInt(req.query.page_size) || PAGE_SIZE
    if (pageSize < 1 || pageSize > 100) pageSize = PAGE_SIZE

    const rawCursor = req.query.cursor || null
    let cursorTimestamp = null
    if (rawCursor) {
      const d = new Date(rawCursor)
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid cursor' })
      cursorTimestamp = admin.firestore.Timestamp.fromDate(d)
    }

    const uid      = req.user.uid
    const isAdmin  = (req.user.roles || []).some(r => ADMIN_ROLES.includes(r))

    try {
      let psmIds = null  // null = fetch all (admin), Set = fetch specific IDs (non-admin)

      if (!isAdmin) {
        // Step 1: PSM created by user
        const ownedSnap = await db.collection('psm_requests')
          .where('created_by', '==', uid)
          .select()
          .get()
        const ownedIds = ownedSnap.docs.map(d => d.id)

        // Step 2: PSM where user was an approver (via approval_request_actions)
        const actionsSnap = await db.collection('approval_request_actions')
          .where('actor_uid', '==', uid)
          .select('approval_request_id')
          .get()
        const arIds = [...new Set(actionsSnap.docs.map(d => d.data().approval_request_id).filter(Boolean))]

        // Step 3: Resolve psm_id from approval_requests
        let approverPsmIds = []
        if (arIds.length > 0) {
          const chunks = []
          for (let i = 0; i < arIds.length; i += 10) chunks.push(arIds.slice(i, i + 10))
          for (const chunk of chunks) {
            const arSnap = await db.collection('approval_requests')
              .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
              .select('payload_snapshot')
              .get()
            arSnap.docs.forEach(d => {
              const psm_id = d.data()?.payload_snapshot?.psm_id
              if (psm_id) approverPsmIds.push(psm_id)
            })
          }
        }

        // Merge + deduplicate
        psmIds = [...new Set([...ownedIds, ...approverPsmIds])]
      }

      // Build final query
      let items = []
      let cursor = null
      let hasMore = false

      if (isAdmin) {
        // Admin: standard ordered query with cursor pagination
        let q = db.collection('psm_requests').orderBy('created_at', 'desc')
        if (statusFilter) q = q.where('status', '==', statusFilter)
        if (cursorTimestamp) q = q.startAfter(cursorTimestamp)
        q = q.limit(pageSize + 1)
        const snap = await q.get()
        const docs = snap.docs
        hasMore = docs.length > pageSize
        const toProcess = hasMore ? docs.slice(0, pageSize) : docs
        const lastDoc = toProcess.length > 0 ? toProcess[toProcess.length - 1] : null
        cursor = (hasMore && lastDoc) ? toISO(lastDoc.data().created_at) : null
        const userMapAdmin = await buildUserMap(toProcess)
        items = toProcess.map(d => buildItem(d, userMapAdmin))
      } else {
        if (psmIds.length === 0) {
          return res.status(200).json({ items: [], cursor: null, has_more: false, total_in_page: 0 })
        }
        // Non-admin: fetch by IDs in chunks, then filter + sort in memory
        const allDocs = []
        const chunks = []
        for (let i = 0; i < psmIds.length; i += 10) chunks.push(psmIds.slice(i, i + 10))
        for (const chunk of chunks) {
          const snap = await db.collection('psm_requests')
            .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
            .get()
          allDocs.push(...snap.docs)
        }
        // Filter by status
        let filtered = statusFilter
          ? allDocs.filter(d => d.data().status === statusFilter)
          : allDocs
        // Sort by created_at desc
        filtered.sort((a, b) => {
          const ta = a.data().created_at?.toMillis?.() ?? 0
          const tb = b.data().created_at?.toMillis?.() ?? 0
          return tb - ta
        })
        // Cursor-based pagination (by index since no Firestore cursor)
        let startIdx = 0
        if (cursorTimestamp) {
          const cursorMs = cursorTimestamp.toMillis()
          startIdx = filtered.findIndex(d => (d.data().created_at?.toMillis?.() ?? 0) < cursorMs)
          if (startIdx === -1) startIdx = filtered.length
        }
        const page = filtered.slice(startIdx, startIdx + pageSize + 1)
        hasMore = page.length > pageSize
        const toProcess = hasMore ? page.slice(0, pageSize) : page
        const lastDoc = toProcess.length > 0 ? toProcess[toProcess.length - 1] : null
        cursor = (hasMore && lastDoc) ? toISO(lastDoc.data().created_at) : null
        const userMapNonAdmin = await buildUserMap(toProcess)
        items = toProcess.map(d => buildItem(d, userMapNonAdmin))
      }

      return res.status(200).json({ items, cursor, has_more: hasMore, total_in_page: items.length })

    } catch (err) {
      console.error('[psmRead] listMyPsms:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
