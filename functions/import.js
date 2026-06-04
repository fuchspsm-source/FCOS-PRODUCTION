'use strict'

const { onRequest }  = require('firebase-functions/v2/https')
const { db, admin }  = require('./db')
const { requireAuth, requireActive, requireRole } = require('./middleware')
const { writeAudit } = require('./audit')
const {
  AUDIT, PRODUCT_STATUS,
  IMPORT_JOB_STATUS, IMPORT_FILE_TYPE, VALIDATION_STATUS, USER_DECISION,
  COMMIT_STATUS, CLEANUP_STATUS
} = require('./constants')

const FieldValue = admin.firestore.FieldValue

// ─── run helper ──────────────────────────────────────────
function run(middlewares, handler) {
  return onRequest(async (req, res) => {
    let idx = 0
    const next = async () => {
      const mw = middlewares[idx++]
      if (mw) {
        const r = mw(req, res, next)
        if (r && typeof r.then === 'function') await r
      } else {
        await handler(req, res)
      }
    }
    await next()
  })
}

// ─── nextId: single-use (non-import paths) ───────────────
async function nextId(seqName, prefix, padLen) {
  const ref = db.collection('_sequences').doc(seqName)
  const id  = await db.runTransaction(async tx => {
    const snap = await tx.get(ref)
    const next = snap.exists ? (snap.data().current + 1) : 1
    tx.set(ref, { current: next })
    return next
  })
  return prefix + String(id).padStart(padLen, '0')
}

// ─── reserveIds: block allocation for bulk import ────────
// One transaction reserves N IDs atomically.
// Returns array of formatted ID strings.
// Example: reserveIds('products','PRD-',6,500)
//   → ['PRD-000001','PRD-000002',...,'PRD-000500']
async function reserveIds(seqName, prefix, padLen, count) {
  const ref = db.collection('_sequences').doc(seqName)
  const start = await db.runTransaction(async tx => {
    const snap = await tx.get(ref)
    const current = snap.exists ? snap.data().current : 0
    tx.set(ref, { current: current + count })
    return current + 1
  })
  const ids = []
  for (let i = 0; i < count; i++) {
    ids.push(prefix + String(start + i).padStart(padLen, '0'))
  }
  return ids
}

// ─── RETENTION: 90 days from now ─────────────────────────
function expiresAt() {
  const d = new Date()
  d.setDate(d.getDate() + 90)
  return d
}

// ═══════════════════════════════════════════════════════════
// createImportJob
// POST { file_name, file_type, total_rows }
// ═══════════════════════════════════════════════════════════
exports.createImportJob = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { file_name, file_type, total_rows } = req.body

    if (!file_name)
      return res.status(400).json({ error: 'file_name is required' })
    if (!IMPORT_FILE_TYPE[file_type])
      return res.status(400).json({ error: `Invalid file_type. Must be: ${Object.keys(IMPORT_FILE_TYPE).join(', ')}` })
    if (!total_rows || total_rows < 1)
      return res.status(400).json({ error: 'total_rows must be >= 1' })

    try {
      const job_id = await nextId('import_jobs', 'IMP-', 6)
      await db.collection('import_jobs').doc(job_id).set({
        job_id,
        status         : IMPORT_JOB_STATUS.PENDING,
        file_name,
        file_type,
        import_source  : file_type,
        total_rows,
        valid_rows     : 0,
        conflict_rows  : 0,
        error_rows     : 0,
        staged_rows    : 0,
        created_by     : req.user.uid,
        created_at     : FieldValue.serverTimestamp(),
        updated_at     : FieldValue.serverTimestamp(),
        committed_at   : null,
        committed_by   : null
      })
      await writeAudit(AUDIT.IMPORT_JOB_CREATED, req.user.uid, job_id, { file_name, file_type, total_rows })
      return res.status(201).json({ ok: true, job_id })
    } catch (err) {
      console.error('[import] createImportJob:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// ═══════════════════════════════════════════════════════════
// submitImportRows
// POST { job_id, rows: [...] }
// Frontend sends chunks of 250. Hard cap 300 per request.
// Staging docs written with commit_status=PENDING,
// expires_at=now+90d, cleanup_status=ACTIVE.
// ═══════════════════════════════════════════════════════════
exports.submitImportRows = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { job_id, rows } = req.body

    if (!job_id)
      return res.status(400).json({ error: 'job_id is required' })
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows must be a non-empty array' })
    if (rows.length > 300)
      return res.status(400).json({ error: 'Max 300 rows per chunk' })

    try {
      const jobSnap = await db.collection('import_jobs').doc(job_id).get()
      if (!jobSnap.exists)
        return res.status(404).json({ error: 'Import job not found' })
      const job = jobSnap.data()
      if (job.status !== IMPORT_JOB_STATUS.PENDING && job.status !== IMPORT_JOB_STATUS.STAGED)
        return res.status(400).json({ error: `Cannot submit rows to a job with status: ${job.status}` })
      if (job.created_by !== req.user.uid)
        return res.status(403).json({ error: 'You do not own this import job' })

      // Reserve staging IDs in one transaction (block allocation)
      const stagingIds = await reserveIds('import_staging', 'STG-', 8, rows.length)

      const expiry = expiresAt()

      // Batch write: max rows.length (≤300) + 1 job update = ≤301 — well under 500 limit
      const batch = db.batch()

      rows.forEach((row, i) => {
        const { row_number, product_code, product_name, sku, raw_row } = row
        const ref = db.collection('import_staging').doc(stagingIds[i])
        batch.set(ref, {
          staging_id          : stagingIds[i],
          job_id,
          row_number          : row_number || 0,
          raw_row             : raw_row || {},
          product_code        : (product_code || '').trim(),
          product_name        : (product_name || '').trim(),
          sku                 : (sku || '').trim() || null,
          validation_status   : VALIDATION_STATUS.OK,
          validation_errors   : [],
          conflict_type       : null,
          conflict_with       : null,
          similar_name_warning: false,
          user_decision       : null,
          decided_at          : null,
          decided_by          : null,
          // Idempotency fields
          commit_status       : COMMIT_STATUS.PENDING,
          committed_at        : null,
          // Cleanup / retention fields
          cleanup_status      : CLEANUP_STATUS.ACTIVE,
          expires_at          : expiry,
          created_at          : FieldValue.serverTimestamp()
        })
      })

      batch.update(db.collection('import_jobs').doc(job_id), {
        staged_rows : FieldValue.increment(rows.length),
        status      : IMPORT_JOB_STATUS.STAGED,
        updated_at  : FieldValue.serverTimestamp()
      })

      await batch.commit()
      return res.status(200).json({ ok: true, staged: rows.length })
    } catch (err) {
      console.error('[import] submitImportRows:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// ═══════════════════════════════════════════════════════════
// validateImportJob
// POST { job_id }
// Loads all staging rows, runs validation + conflict detection.
// Resets commit_status to PENDING on re-validation.
// ═══════════════════════════════════════════════════════════
exports.validateImportJob = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { job_id } = req.body
    if (!job_id) return res.status(400).json({ error: 'job_id is required' })

    try {
      const jobSnap = await db.collection('import_jobs').doc(job_id).get()
      if (!jobSnap.exists) return res.status(404).json({ error: 'Import job not found' })
      const job = jobSnap.data()
      if (job.created_by !== req.user.uid)
        return res.status(403).json({ error: 'You do not own this import job' })
      if (job.status !== IMPORT_JOB_STATUS.STAGED)
        return res.status(400).json({ error: `Job must be STAGED to validate. Current: ${job.status}` })

      // Load all staging rows for this job across all chunks
      const stagingSnap = await db.collection('import_staging')
        .where('job_id', '==', job_id)
        .orderBy('row_number')
        .get()
      const stagingRows = stagingSnap.docs.map(d => ({ _ref: d.ref, ...d.data() }))

      // Load all existing products for conflict detection
      const registrySnap = await db.collection('product_registry').get()
      const registryByCode = {}
      const registryNameSet = new Set()
      registrySnap.docs.forEach(d => {
        const data = d.data()
        if (data.product_code) {
          registryByCode[data.product_code.trim()] = {
            product_id        : d.id,
            product_name_lower: data.product_name_lower || ''
          }
        }
        if (data.product_name_lower) registryNameSet.add(data.product_name_lower)
      })

      // Track codes seen within this file (cross-chunk duplicate detection)
      const seenCodesInFile = {}

      let valid_rows    = 0
      let conflict_rows = 0
      let error_rows    = 0

      const BATCH_SIZE = 400
      let currentBatch = db.batch()
      let batchCount   = 0

      const flushBatch = async () => {
        if (batchCount > 0) {
          await currentBatch.commit()
          currentBatch = db.batch()
          batchCount   = 0
        }
      }

      for (const row of stagingRows) {
        const errors       = []
        let   conflictType = null
        let   conflictWith = null
        let   similarWarn  = false

        const code      = (row.product_code || '').trim()
        const name      = (row.product_name || '').trim()
        const nameLower = name.toLowerCase()

        // ERROR rules
        if (!code)  errors.push('product_code_required')
        if (!name)  errors.push('product_name_required')

        if (code && seenCodesInFile[code] !== undefined) {
          errors.push('duplicate_code_in_file')
        } else if (code) {
          seenCodesInFile[code] = row.row_number
        }

        // CONFLICT rule (exact match only — no fuzzy)
        if (errors.length === 0 && registryByCode[code]) {
          conflictType = 'DUPLICATE_CODE_IN_REGISTRY'
          conflictWith = registryByCode[code].product_id
        }

        // WARNING only — similar name (never blocks, never requires action)
        if (errors.length === 0 && nameLower) {
          for (const existingName of registryNameSet) {
            if (existingName !== nameLower &&
                (existingName.includes(nameLower) || nameLower.includes(existingName))) {
              similarWarn = true
              break
            }
          }
        }

        let vstatus
        if (errors.length > 0)  { vstatus = VALIDATION_STATUS.ERROR;    error_rows++ }
        else if (conflictType)  { vstatus = VALIDATION_STATUS.CONFLICT;  conflict_rows++ }
        else                    { vstatus = VALIDATION_STATUS.OK;        valid_rows++ }

        currentBatch.update(row._ref, {
          validation_status   : vstatus,
          validation_errors   : errors,
          conflict_type       : conflictType,
          conflict_with       : conflictWith,
          similar_name_warning: similarWarn,
          // Reset decisions and commit_status on re-validation
          user_decision       : null,
          decided_at          : null,
          decided_by          : null,
          commit_status       : COMMIT_STATUS.PENDING,
          committed_at        : null
        })
        batchCount++
        if (batchCount >= BATCH_SIZE) await flushBatch()
      }

      await flushBatch()

      await db.collection('import_jobs').doc(job_id).update({
        status        : IMPORT_JOB_STATUS.VALIDATED,
        valid_rows,
        conflict_rows,
        error_rows,
        updated_at    : FieldValue.serverTimestamp()
      })

      return res.status(200).json({
        ok: true,
        summary: { total: stagingRows.length, valid_rows, conflict_rows, error_rows }
      })
    } catch (err) {
      console.error('[import] validateImportJob:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// ═══════════════════════════════════════════════════════════
// getImportJob
// GET ?job_id=IMP-000001
// ═══════════════════════════════════════════════════════════
exports.getImportJob = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    const { job_id } = req.query
    if (!job_id) return res.status(400).json({ error: 'job_id is required' })
    try {
      const jobSnap = await db.collection('import_jobs').doc(job_id).get()
      if (!jobSnap.exists) return res.status(404).json({ error: 'Import job not found' })

      const stagingSnap = await db.collection('import_staging')
        .where('job_id', '==', job_id)
        .orderBy('row_number')
        .get()
      const rows = stagingSnap.docs.map(d => d.data())

      return res.status(200).json({ job: { job_id: jobSnap.id, ...jobSnap.data() }, rows })
    } catch (err) {
      console.error('[import] getImportJob:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// ═══════════════════════════════════════════════════════════
// listImportJobs
// GET ?limit=50
// ═══════════════════════════════════════════════════════════
exports.listImportJobs = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    try {
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 100)
      const snap = await db.collection('import_jobs')
        .orderBy('created_at', 'desc')
        .limit(limit)
        .get()
      return res.status(200).json({ jobs: snap.docs.map(d => ({ job_id: d.id, ...d.data() })) })
    } catch (err) {
      console.error('[import] listImportJobs:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// ═══════════════════════════════════════════════════════════
// setRowDecision
// POST { staging_id, decision: SKIP | UPDATE | MANUAL_REVIEW }
// ═══════════════════════════════════════════════════════════
exports.setRowDecision = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { staging_id, decision } = req.body
    if (!staging_id) return res.status(400).json({ error: 'staging_id is required' })
    if (!USER_DECISION[decision])
      return res.status(400).json({ error: `Invalid decision. Must be: ${Object.keys(USER_DECISION).join(', ')}` })

    try {
      const ref  = db.collection('import_staging').doc(staging_id)
      const snap = await ref.get()
      if (!snap.exists) return res.status(404).json({ error: 'Staging row not found' })

      const row = snap.data()
      if (row.validation_status === VALIDATION_STATUS.ERROR)
        return res.status(400).json({ error: 'Cannot set decision on ERROR rows' })
      if (row.commit_status === COMMIT_STATUS.COMMITTED)
        return res.status(400).json({ error: 'Row is already committed' })

      const jobSnap = await db.collection('import_jobs').doc(row.job_id).get()
      if (!jobSnap.exists || jobSnap.data().created_by !== req.user.uid)
        return res.status(403).json({ error: 'You do not own this import job' })

      await ref.update({
        user_decision : decision,
        decided_at    : FieldValue.serverTimestamp(),
        decided_by    : req.user.uid
      })
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[import] setRowDecision:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// ═══════════════════════════════════════════════════════════
// commitImportJob
// POST { job_id }
//
// IDEMPOTENCY DESIGN:
//   - Only processes rows where commit_status = PENDING
//   - Each row is marked PROCESSING before write, COMMITTED after
//   - If crash: re-run skips COMMITTED rows, retries PROCESSING rows
//   - PROCESSING rows on re-run are treated as PENDING (safe retry)
//
// BATCH DESIGN:
//   - Reserve all needed product IDs in ONE block allocation
//   - No sequential nextId() per row
//   - Sub-batches of 400 writes each
//
// PARTIAL COMMIT:
//   - MANUAL_REVIEW rows → left as PENDING, job = PARTIALLY_COMMITTED
//   - ERROR rows → always skipped
// ═══════════════════════════════════════════════════════════
exports.commitImportJob = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { job_id } = req.body
    if (!job_id) return res.status(400).json({ error: 'job_id is required' })

    try {
      const jobSnap = await db.collection('import_jobs').doc(job_id).get()
      if (!jobSnap.exists) return res.status(404).json({ error: 'Import job not found' })
      const job = jobSnap.data()
      if (job.created_by !== req.user.uid)
        return res.status(403).json({ error: 'You do not own this import job' })
      if (![IMPORT_JOB_STATUS.VALIDATED, IMPORT_JOB_STATUS.PARTIALLY_COMMITTED].includes(job.status))
        return res.status(400).json({ error: `Job must be VALIDATED to commit. Current: ${job.status}` })

      // Load all staging rows — only process PENDING and PROCESSING
      // (PROCESSING = crashed mid-commit last time, safe to retry)
      const stagingSnap = await db.collection('import_staging')
        .where('job_id', '==', job_id)
        .orderBy('row_number')
        .get()
      const allRows = stagingSnap.docs.map(d => ({ _ref: d.ref, ...d.data() }))

      // Filter to rows that need processing (skip already COMMITTED)
      const pendingRows = allRows.filter(r =>
        r.commit_status === COMMIT_STATUS.PENDING ||
        r.commit_status === COMMIT_STATUS.PROCESSING
      )

      // Check for CONFLICT rows with no decision
      const unresolved = pendingRows.filter(r =>
        r.validation_status === VALIDATION_STATUS.CONFLICT && !r.user_decision
      )
      if (unresolved.length > 0) {
        return res.status(400).json({
          error            : 'Unresolved conflicts exist. Set a decision for all conflict rows before committing.',
          unresolved_count : unresolved.length
        })
      }

      // Count how many OK inserts we need — reserve IDs in ONE block allocation
      const insertRows = pendingRows.filter(r =>
        r.validation_status === VALIDATION_STATUS.OK
      )
      const reservedIds = insertRows.length > 0
        ? await reserveIds('products', 'PRD-', 6, insertRows.length)
        : []
      let idIndex = 0

      let inserted      = 0
      let updated       = 0
      let skipped       = 0
      let manual_review = 0
      let errors_skipped = 0

      const BATCH_SIZE  = 400
      let currentBatch  = db.batch()
      let batchCount    = 0

      const flushBatch = async () => {
        if (batchCount > 0) {
          await currentBatch.commit()
          currentBatch = db.batch()
          batchCount   = 0
        }
      }

      for (const row of pendingRows) {

        // ── ERROR rows → skip, mark COMMITTED (won't retry) ──
        if (row.validation_status === VALIDATION_STATUS.ERROR) {
          currentBatch.update(row._ref, {
            commit_status : COMMIT_STATUS.COMMITTED,
            committed_at  : FieldValue.serverTimestamp()
          })
          batchCount++
          errors_skipped++
          if (batchCount >= BATCH_SIZE) await flushBatch()
          continue
        }

        // ── CONFLICT + SKIP ───────────────────────────────────
        if (row.validation_status === VALIDATION_STATUS.CONFLICT &&
            row.user_decision === USER_DECISION.SKIP) {
          currentBatch.update(row._ref, {
            commit_status : COMMIT_STATUS.COMMITTED,
            committed_at  : FieldValue.serverTimestamp()
          })
          batchCount++
          skipped++
          if (batchCount >= BATCH_SIZE) await flushBatch()
          continue
        }

        // ── CONFLICT + MANUAL_REVIEW → leave PENDING ─────────
        if (row.validation_status === VALIDATION_STATUS.CONFLICT &&
            row.user_decision === USER_DECISION.MANUAL_REVIEW) {
          manual_review++
          continue
        }

        // ── OK rows → INSERT ──────────────────────────────────
        if (row.validation_status === VALIDATION_STATUS.OK) {
          // Mark PROCESSING before write (crash-safe checkpoint)
          currentBatch.update(row._ref, { commit_status: COMMIT_STATUS.PROCESSING })
          batchCount++
          if (batchCount >= BATCH_SIZE) await flushBatch()

          const product_id = reservedIds[idIndex++]
          const productRef = db.collection('product_registry').doc(product_id)
          currentBatch.set(productRef, {
            product_id,
            product_code        : row.product_code,
            product_name        : row.product_name,
            product_name_lower  : row.product_name.toLowerCase().trim(),
            sku                 : row.sku || null,
            status              : PRODUCT_STATUS.ACTIVE,
            import_job_id       : job_id,
            taxonomy_ordo_id    : null,
            taxonomy_family_id  : null,
            taxonomy_genus_id   : null,
            taxonomy_species_id : null,
            created_at          : FieldValue.serverTimestamp(),
            updated_at          : FieldValue.serverTimestamp(),
            created_by          : req.user.uid,
            updated_by          : req.user.uid
          })
          batchCount++
          if (batchCount >= BATCH_SIZE) await flushBatch()

          // Mark COMMITTED after product write is in batch
          currentBatch.update(row._ref, {
            commit_status : COMMIT_STATUS.COMMITTED,
            committed_at  : FieldValue.serverTimestamp()
          })
          batchCount++
          inserted++
          if (batchCount >= BATCH_SIZE) await flushBatch()
          continue
        }

        // ── CONFLICT + UPDATE → overwrite existing ────────────
        if (row.validation_status === VALIDATION_STATUS.CONFLICT &&
            row.user_decision === USER_DECISION.UPDATE &&
            row.conflict_with) {
          // Mark PROCESSING
          currentBatch.update(row._ref, { commit_status: COMMIT_STATUS.PROCESSING })
          batchCount++
          if (batchCount >= BATCH_SIZE) await flushBatch()

          const productRef = db.collection('product_registry').doc(row.conflict_with)
          currentBatch.update(productRef, {
            product_code       : row.product_code,
            product_name       : row.product_name,
            product_name_lower : row.product_name.toLowerCase().trim(),
            sku                : row.sku || null,
            import_job_id      : job_id,
            updated_at         : FieldValue.serverTimestamp(),
            updated_by         : req.user.uid
          })
          batchCount++
          if (batchCount >= BATCH_SIZE) await flushBatch()

          // Mark COMMITTED
          currentBatch.update(row._ref, {
            commit_status : COMMIT_STATUS.COMMITTED,
            committed_at  : FieldValue.serverTimestamp()
          })
          batchCount++
          updated++
          if (batchCount >= BATCH_SIZE) await flushBatch()
          continue
        }
      }

      await flushBatch()

      // Determine job status based on remaining uncommitted rows
      const remainingManual = allRows.filter(r =>
        r.commit_status === COMMIT_STATUS.PENDING &&
        r.user_decision === USER_DECISION.MANUAL_REVIEW
      ).length + manual_review

      const finalStatus = remainingManual > 0
        ? IMPORT_JOB_STATUS.PARTIALLY_COMMITTED
        : IMPORT_JOB_STATUS.COMMITTED

      await db.collection('import_jobs').doc(job_id).update({
        status       : finalStatus,
        committed_at : FieldValue.serverTimestamp(),
        committed_by : req.user.uid,
        updated_at   : FieldValue.serverTimestamp()
      })

      await writeAudit(AUDIT.IMPORT_JOB_COMMITTED, req.user.uid, job_id, {
        inserted, updated, skipped, manual_review, errors_skipped
      })

      return res.status(200).json({
        ok     : true,
        status : finalStatus,
        summary: { inserted, updated, skipped, manual_review, errors_skipped }
      })
    } catch (err) {
      console.error('[import] commitImportJob:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// ═══════════════════════════════════════════════════════════
// cancelImportJob
// POST { job_id }
// ═══════════════════════════════════════════════════════════
exports.cancelImportJob = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { job_id } = req.body
    if (!job_id) return res.status(400).json({ error: 'job_id is required' })
    try {
      const jobSnap = await db.collection('import_jobs').doc(job_id).get()
      if (!jobSnap.exists) return res.status(404).json({ error: 'Import job not found' })
      const job = jobSnap.data()
      if (job.created_by !== req.user.uid)
        return res.status(403).json({ error: 'You do not own this import job' })
      if ([IMPORT_JOB_STATUS.COMMITTED, IMPORT_JOB_STATUS.CANCELLED].includes(job.status))
        return res.status(400).json({ error: `Cannot cancel a job with status: ${job.status}` })

      await db.collection('import_jobs').doc(job_id).update({
        status     : IMPORT_JOB_STATUS.CANCELLED,
        updated_at : FieldValue.serverTimestamp()
      })
      await writeAudit(AUDIT.IMPORT_JOB_CANCELLED, req.user.uid, job_id, {})
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[import] cancelImportJob:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)
