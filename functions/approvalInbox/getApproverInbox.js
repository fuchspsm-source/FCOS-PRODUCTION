'use strict'

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { db, admin }          = require('../db')
const { REQUEST_STATUS }     = require('../constants/requestStatus')

const REGION                = 'us-central1'
const DEFAULT_PAGE_SIZE     = 20
const MAX_PAGE_SIZE         = 50
const MIN_PAGE_SIZE         = 1
const AGING_THRESHOLD_HOURS = 24

// ── I10: Per-document integrity validation ─────────────────────────────────
// Returns true if valid, false if corrupted.
// Corrupted documents: excluded from response + logged — never throw.

function checkIntegrity(docId, data) {
  const failures = []

  if (typeof data.summary !== 'string' || data.summary.length === 0) {
    failures.push('summary missing or empty')
  }

  if (!Array.isArray(data.approval_pipeline) || data.approval_pipeline.length === 0) {
    failures.push('approval_pipeline missing or empty')
  }

  const pipelineLen = Array.isArray(data.approval_pipeline)
    ? data.approval_pipeline.length : 0
  const step = data.current_step

  if (!Number.isInteger(step) || step < 0 || step >= pipelineLen) {
    failures.push('current_step missing, invalid, or out of bounds')
  }

  if (typeof data.current_approver_uid !== 'string' ||
      data.current_approver_uid.trim() === '') {
    failures.push('current_approver_uid missing or empty')
  }

  if (failures.length > 0) {
    console.error(
      '[getApproverInbox] I10 integrity failure on document ' +
      docId + ': ' + failures.join(', ')
    )
    return false
  }

  return true
}

// ── Timestamp normalisation ────────────────────────────────────────────────

function toISO(ts) {
  if (!ts)                             return null
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString()
  if (ts instanceof Date)              return ts.toISOString()
  return String(ts)
}

// ── DTO assembly ───────────────────────────────────────────────────────────

function buildInboxItem(docId, data) {
  const submittedAt = toISO(data.submitted_at)
  const ageMs       = submittedAt
    ? Date.now() - new Date(submittedAt).getTime() : 0
  const ageHours    = Math.round((ageMs / 3600000) * 10) / 10
  const currentStep = data.current_step
  const totalSteps  = data.approval_pipeline.length
  const stepLabel   = 'Step ' + (currentStep + 1) + ' of ' + totalSteps

  return {
    request_id:     docId,
    request_number: data.request_number,
    module:         data.module,
    summary:        data.summary,
    submitted_at:   submittedAt,
    current_step:   currentStep,
    total_steps:    totalSteps,
    step_label:     stepLabel,
    age_hours:      ageHours,
    is_aging:       ageHours > AGING_THRESHOLD_HOURS,
  }
}

// ── Public export ──────────────────────────────────────────────────────────

exports.getApproverInbox = onCall({ region: REGION }, async (request) => {

  // V1: Authentication
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.')
  }
  const callerUid = request.auth.uid

  // V2: page_size — integer, clamped to [1, 50], default 20
  let pageSize = request.data?.page_size ?? DEFAULT_PAGE_SIZE
  if (!Number.isInteger(pageSize)) pageSize = DEFAULT_PAGE_SIZE
  pageSize = Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, pageSize))

  // V3: cursor — optional ISO 8601 string
  const rawCursor = request.data?.cursor ?? null
  let cursorTimestamp = null
  if (rawCursor !== null) {
    const d = new Date(rawCursor)
    if (isNaN(d.getTime())) {
      throw new HttpsError('invalid-argument',
        'cursor must be a valid ISO 8601 timestamp.')
    }
    cursorTimestamp = admin.firestore.Timestamp.fromDate(d)
  }

  // ── Firestore query (limit + 1 for has_more detection) ──────────────────
  let query = db.collection('approval_requests')
    .where('current_approver_uid', '==', callerUid)
    .where('status',               '==', REQUEST_STATUS.PENDING)
    .orderBy('submitted_at', 'asc')
    .limit(pageSize + 1)

  if (cursorTimestamp !== null) {
    query = query.startAfter(cursorTimestamp)
  }

  const snapshot = await query.get()
  const rawDocs  = snapshot.docs

  // has_more determined from raw count (before I10 filtering)
  const hasMore       = rawDocs.length > pageSize
  const docsToProcess = hasMore ? rawDocs.slice(0, pageSize) : rawDocs

  // Cursor from last raw doc in window
  // (ensures pagination works correctly even when some docs fail I10)
  const lastRawDoc = docsToProcess.length > 0
    ? docsToProcess[docsToProcess.length - 1] : null
  const cursor = (hasMore && lastRawDoc)
    ? toISO(lastRawDoc.data().submitted_at) : null

  // ── I10: per-document validation — exclude corrupted, log, never throw ──
  const items = []
  for (const doc of docsToProcess) {
    if (checkIntegrity(doc.id, doc.data())) {
      items.push(buildInboxItem(doc.id, doc.data()))
    }
  }

  return { items, cursor, has_more: hasMore }
})
