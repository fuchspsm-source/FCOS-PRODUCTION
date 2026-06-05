'use strict'

const { onRequest }  = require('firebase-functions/v2/https')
const { db, admin }  = require('./db')
const { requireAuth, requireActive, requireRole } = require('./middleware')
const { writeAudit } = require('./audit')
const {
  AUDIT, PRODUCT_STATUS,
  IMPORT_JOB_STATUS, IMPORT_FILE_TYPE, IMPORT_MODULE_NAME, IMPORT_PRIMARY_KEY_FIELD,
  VALIDATION_STATUS, USER_DECISION,
  COMMIT_STATUS, CLEANUP_STATUS
} = require('./constants')

const FieldValue = admin.firestore.FieldValue

// run helper
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

// nextId
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

// reserveIds
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

// expiresAt: 90 days
function expiresAt() {
  const d = new Date()
  d.setDate(d.getDate() + 90)
  return d
}

// DISPATCH: extractFields
function extractFields(file_type, row) {
  if (file_type === IMPORT_FILE_TYPE.PRODUCT) {
    const product_code = (row.product_code || '').trim()
    const product_name = (row.product_name || '').trim()
    const sku          = (row.sku          || '').trim() || null
    return { primary_key: product_code, fields: { product_code, product_name, sku } }
  }
  if (file_type === IMPORT_FILE_TYPE.CUSTOMER) {
    const customerCode = (row.customerCode || '').trim()
    const customerName = (row.customerName || '').trim()
    return { primary_key: customerCode, fields: { customerCode, customerName } }
  }
  if (file_type === IMPORT_FILE_TYPE.SHIP_TO) {
    const shipToCode         = (row.shipToCode         || '').trim()
    const shipToName         = (row.shipToName         || '').trim()
    const parentCustomerCode = (row.parentCustomerCode || '').trim()
    return { primary_key: shipToCode, fields: { shipToCode, shipToName, parentCustomerCode } }
  }
  throw new Error(`extractFields: unknown file_type ${file_type}`)
}

// DISPATCH: validateProduct
async function validateProduct(stagingRows, db) {
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
  const seenCodesInFile = {}
  let valid_rows = 0, conflict_rows = 0, error_rows = 0
  const results = []
  for (const row of stagingRows) {
    const errors = []
    let conflictType = null, conflictWith = null, similarWarn = false
    const code      = (row.fields && row.fields.product_code || row.product_code || '').trim()
    const name      = (row.fields && row.fields.product_name || row.product_name || '').trim()
    const nameLower = name.toLowerCase()
    if (!code) errors.push('product_code_required')
    if (!name) errors.push('product_name_required')
    if (code && seenCodesInFile[code] !== undefined) {
      errors.push('duplicate_code_in_file')
    } else if (code) {
      seenCodesInFile[code] = row.row_number
    }
    if (errors.length === 0 && registryByCode[code]) {
      conflictType = 'DUPLICATE_CODE_IN_REGISTRY'
      conflictWith = registryByCode[code].product_id
    }
    if (errors.length === 0 && nameLower) {
      for (const existingName of registryNameSet) {
        if (existingName !== nameLower &&
            (existingName.includes(nameLower) || nameLower.includes(existingName))) {
          similarWarn = true; break
        }
      }
    }
    let vstatus
    if (errors.length > 0)  { vstatus = VALIDATION_STATUS.ERROR;    error_rows++ }
    else if (conflictType)  { vstatus = VALIDATION_STATUS.CONFLICT;  conflict_rows++ }
    else                    { vstatus = VALIDATION_STATUS.OK;        valid_rows++ }
    results.push({ _ref: row._ref, validation_status: vstatus, validation_errors: errors,
                   conflict_type: conflictType, conflict_with: conflictWith,
                   similar_name_warning: similarWarn })
  }
  return { results, valid_rows, conflict_rows, error_rows }
}

// DISPATCH: validateCustomer (Package 5B — SOLD_TO only)
async function validateCustomer(stagingRows, db) {
  const registrySnap = await db.collection('customers').get()
  const registryByCode = {}
  registrySnap.docs.forEach(d => {
    const data = d.data()
    if (data.customerCode)
      registryByCode[data.customerCode.trim().toUpperCase()] = d.id
  })
  const seenCodesInBatch = {}
  let valid_rows = 0, conflict_rows = 0, error_rows = 0
  const results = []
  for (const row of stagingRows) {
    const errors = []
    let conflictType = null, conflictWith = null
    const f    = row.fields || {}
    const code = (f.customerCode || '').trim().toUpperCase()
    const name = (f.customerName || '').trim()
    // Rule 3: reject SHIP_TO
    const rawRow  = row.raw_row || {}
    const typeKey = Object.keys(rawRow).find(k => k.trim().toLowerCase() === 'customertype')
    const rawType = typeKey ? String(rawRow[typeKey]).trim().toUpperCase() : 'SOLD_TO'
    if (rawType === 'SHIP_TO') errors.push('SHIP_TO import not supported in Package 5B')
    // Rule 1: customerCode required
    if (!code) errors.push('customerCode_required')
    // Rule 2: customerName required
    if (!name) errors.push('customerName_required')
    // Rule 4: unique within batch
    if (code && seenCodesInBatch[code] !== undefined) {
      errors.push('duplicate_code_in_batch')
    } else if (code) {
      seenCodesInBatch[code] = row.row_number
    }
    // Rule 5: not already in registry
    if (errors.length === 0 && code && registryByCode[code]) {
      conflictType = 'DUPLICATE_CODE_IN_REGISTRY'
      conflictWith = registryByCode[code]
    }
    let vstatus
    if (errors.length > 0) { vstatus = VALIDATION_STATUS.ERROR;    error_rows++ }
    else if (conflictType)  { vstatus = VALIDATION_STATUS.CONFLICT;  conflict_rows++ }
    else                    { vstatus = VALIDATION_STATUS.OK;        valid_rows++ }
    results.push({ _ref: row._ref, validation_status: vstatus, validation_errors: errors,
                   conflict_type: conflictType, conflict_with: conflictWith,
                   similar_name_warning: false })
  }
  return { results, valid_rows, conflict_rows, error_rows }
}

// DISPATCH: validateShipTo (Package 5C)
async function validateShipTo(stagingRows, db) {
  // Load parent registry (customers collection, SOLD_TO only)
  const parentSnap = await db.collection('customers').get()
  const parentByCode = {}
  parentSnap.docs.forEach(d => {
    const data = d.data()
    if (data.customerCode && data.customerType !== 'SHIP_TO')
      parentByCode[data.customerCode.trim().toUpperCase()] = { id: d.id, active: data.active, name: data.customerName }
  })
  // Load existing Ship-To registry for duplicate check
  const shipToSnap = await db.collection('customerShipTos').get()
  const registryByCode = {}
  shipToSnap.docs.forEach(d => {
    const data = d.data()
    if (data.shipToCode)
      registryByCode[data.shipToCode.trim().toUpperCase()] = d.id
  })
  const seenCodesInBatch = {}
  let valid_rows = 0, conflict_rows = 0, error_rows = 0
  const results = []
  for (const row of stagingRows) {
    const errors = []
    let conflictType = null, conflictWith = null
    let resolvedParentId = null, resolvedParentCode = null, resolvedParentName = null
    const f            = row.fields || {}
    const code         = (f.shipToCode         || '').trim().toUpperCase()
    const name         = (f.shipToName         || '').trim()
    const parentCode   = (f.parentCustomerCode || '').trim().toUpperCase()
    // Rule 1: shipToCode required
    if (!code) errors.push('shipToCode_required')
    // Rule 2: shipToName required
    if (!name) errors.push('shipToName_required')
    // Rule 3: parentCustomerCode required
    if (!parentCode) {
      errors.push('parentCustomerCode_required')
    } else {
      const parent = parentByCode[parentCode]
      // Rule 4: parent must exist
      if (!parent) {
        errors.push('parentCustomerCode_not_found')
      } else if (!parent.active) {
        // Rule 5: parent must be active
        errors.push('parent_customer_inactive')
      } else {
        resolvedParentId   = parent.id
        resolvedParentCode = parentCode
        resolvedParentName = parent.name
      }
    }
    // Rule 6: duplicate within batch
    if (code && seenCodesInBatch[code] !== undefined) {
      errors.push('duplicate_code_in_batch')
    } else if (code) {
      seenCodesInBatch[code] = row.row_number
    }
    // Rule 7: duplicate in registry -> CONFLICT
    if (errors.length === 0 && code && registryByCode[code]) {
      conflictType = 'DUPLICATE_CODE_IN_REGISTRY'
      conflictWith = registryByCode[code]
    }
    let vstatus
    if (errors.length > 0) { vstatus = VALIDATION_STATUS.ERROR;    error_rows++ }
    else if (conflictType)  { vstatus = VALIDATION_STATUS.CONFLICT;  conflict_rows++ }
    else                    { vstatus = VALIDATION_STATUS.OK;        valid_rows++ }
    results.push({
      _ref               : row._ref,
      validation_status  : vstatus,
      validation_errors  : errors,
      conflict_type      : conflictType,
      conflict_with      : conflictWith,
      resolved_parent_id   : resolvedParentId,
      resolved_parent_code : resolvedParentCode,
      resolved_parent_name : resolvedParentName,
      similar_name_warning: false
    })
  }
  return { results, valid_rows, conflict_rows, error_rows }
}

// DISPATCH: commitProduct
async function commitProduct(row, batch, reservedId, userId, jobId) {
  if (row.validation_status === VALIDATION_STATUS.ERROR) {
    batch.update(row._ref, { commit_status: COMMIT_STATUS.COMMITTED, committed_at: FieldValue.serverTimestamp() })
    return 'error_skipped'
  }
  if (row.validation_status === VALIDATION_STATUS.CONFLICT && row.user_decision === USER_DECISION.SKIP) {
    batch.update(row._ref, { commit_status: COMMIT_STATUS.COMMITTED, committed_at: FieldValue.serverTimestamp() })
    return 'skipped'
  }
  if (row.validation_status === VALIDATION_STATUS.CONFLICT && row.user_decision === USER_DECISION.MANUAL_REVIEW) {
    return 'manual_review'
  }
  if (row.validation_status === VALIDATION_STATUS.OK) {
    batch.update(row._ref, { commit_status: COMMIT_STATUS.PROCESSING })
    const product_id = reservedId
    const f = row.fields || {}
    batch.set(db.collection('product_registry').doc(product_id), {
      product_id,
      product_code        : f.product_code        || row.product_code,
      product_name        : f.product_name        || row.product_name,
      product_name_lower  : (f.product_name || row.product_name || '').toLowerCase().trim(),
      sku                 : f.sku !== undefined ? f.sku : (row.sku || null),
      status              : PRODUCT_STATUS.ACTIVE,
      import_job_id       : jobId,
      taxonomy_ordo_id    : null,
      taxonomy_family_id  : null,
      taxonomy_genus_id   : null,
      taxonomy_species_id : null,
      created_at          : FieldValue.serverTimestamp(),
      updated_at          : FieldValue.serverTimestamp(),
      created_by          : userId,
      updated_by          : userId
    })
    batch.update(row._ref, { commit_status: COMMIT_STATUS.COMMITTED, committed_at: FieldValue.serverTimestamp() })
    return 'inserted'
  }
  if (row.validation_status === VALIDATION_STATUS.CONFLICT &&
      row.user_decision === USER_DECISION.UPDATE && row.conflict_with) {
    batch.update(row._ref, { commit_status: COMMIT_STATUS.PROCESSING })
    const f = row.fields || {}
    batch.update(db.collection('product_registry').doc(row.conflict_with), {
      product_code       : f.product_code        || row.product_code,
      product_name       : f.product_name        || row.product_name,
      product_name_lower : (f.product_name || row.product_name || '').toLowerCase().trim(),
      sku                : f.sku !== undefined ? f.sku : (row.sku || null),
      import_job_id      : jobId,
      updated_at         : FieldValue.serverTimestamp(),
      updated_by         : userId
    })
    batch.update(row._ref, { commit_status: COMMIT_STATUS.COMMITTED, committed_at: FieldValue.serverTimestamp() })
    return 'updated'
  }
  return 'error_skipped'
}

// DISPATCH: commitCustomer (Package 5B — SOLD_TO only)
async function commitCustomer(row, batch, _reservedId, userId, jobId) {
  if (row.validation_status === VALIDATION_STATUS.ERROR) {
    batch.update(row._ref, { commit_status: COMMIT_STATUS.COMMITTED, committed_at: FieldValue.serverTimestamp() })
    return 'error_skipped'
  }
  if (row.validation_status === VALIDATION_STATUS.CONFLICT && row.user_decision === USER_DECISION.SKIP) {
    batch.update(row._ref, { commit_status: COMMIT_STATUS.COMMITTED, committed_at: FieldValue.serverTimestamp() })
    return 'skipped'
  }
  if (row.validation_status === VALIDATION_STATUS.CONFLICT && row.user_decision === USER_DECISION.MANUAL_REVIEW) {
    return 'manual_review'
  }
  if (row.validation_status === VALIDATION_STATUS.OK) {
    batch.update(row._ref, { commit_status: COMMIT_STATUS.PROCESSING })
    const f = row.fields || {}
    const customerRef = db.collection('customers').doc()
    batch.set(customerRef, {
      customerCode       : f.customerCode,
      customerName       : f.customerName,
      customerType       : 'SOLD_TO',
      parentCustomerId   : null,
      parentCustomerCode : null,
      address            : f.address  || '',
      city               : f.city     || '',
      province           : f.province || '',
      island             : f.island   || '',
      active             : true,
      import_job_id      : jobId,
      createdAt          : FieldValue.serverTimestamp(),
      updatedAt          : FieldValue.serverTimestamp(),
      created_by         : userId,
      updated_by         : userId
    })
    batch.update(row._ref, { commit_status: COMMIT_STATUS.COMMITTED, committed_at: FieldValue.serverTimestamp() })
    return 'inserted'
  }
  if (row.validation_status === VALIDATION_STATUS.CONFLICT &&
      row.user_decision === USER_DECISION.UPDATE && row.conflict_with) {
    batch.update(row._ref, { commit_status: COMMIT_STATUS.PROCESSING })
    const f = row.fields || {}
    batch.update(db.collection('customers').doc(row.conflict_with), {
      customerName : f.customerName,
      address      : f.address  || '',
      city         : f.city     || '',
      province     : f.province || '',
      island       : f.island   || '',
      import_job_id : jobId,
      updatedAt    : FieldValue.serverTimestamp(),
      updated_by   : userId
    })
    batch.update(row._ref, { commit_status: COMMIT_STATUS.COMMITTED, committed_at: FieldValue.serverTimestamp() })
    return 'updated'
  }
  return 'error_skipped'
}

// DISPATCH: commitShipTo (Package 5C)
async function commitShipTo(row, batch, _reservedId, userId, jobId) {
  if (row.validation_status === VALIDATION_STATUS.ERROR) {
    batch.update(row._ref, { commit_status: COMMIT_STATUS.COMMITTED, committed_at: FieldValue.serverTimestamp() })
    return 'error_skipped'
  }
  if (row.validation_status === VALIDATION_STATUS.CONFLICT && row.user_decision === USER_DECISION.SKIP) {
    batch.update(row._ref, { commit_status: COMMIT_STATUS.COMMITTED, committed_at: FieldValue.serverTimestamp() })
    return 'skipped'
  }
  if (row.validation_status === VALIDATION_STATUS.CONFLICT && row.user_decision === USER_DECISION.MANUAL_REVIEW) {
    return 'manual_review'
  }
  if (row.validation_status === VALIDATION_STATUS.OK) {
    batch.update(row._ref, { commit_status: COMMIT_STATUS.PROCESSING })
    const f = row.fields || {}
    const shipToRef = db.collection('customerShipTos').doc()
    batch.set(shipToRef, {
      shipToCode           : f.shipToCode,
      shipToName           : f.shipToName,
      soldToId             : row.resolved_parent_id   || null,
      soldToCode           : row.resolved_parent_code || null,
      soldToName           : row.resolved_parent_name || null,
      parentCustomerId     : row.resolved_parent_id   || null,
      parentCustomerCode   : row.resolved_parent_code || null,
      address              : f.address  || '',
      city                 : f.city     || '',
      province             : f.province || '',
      island               : f.island   || '',
      active               : true,
      import_job_id        : jobId,
      createdAt            : FieldValue.serverTimestamp(),
      updatedAt            : FieldValue.serverTimestamp(),
      created_by           : userId,
      updated_by           : userId
    })
    batch.update(row._ref, { commit_status: COMMIT_STATUS.COMMITTED, committed_at: FieldValue.serverTimestamp() })
    return 'inserted'
  }
  if (row.validation_status === VALIDATION_STATUS.CONFLICT &&
      row.user_decision === USER_DECISION.UPDATE && row.conflict_with) {
    batch.update(row._ref, { commit_status: COMMIT_STATUS.PROCESSING })
    const f = row.fields || {}
    batch.update(db.collection('customerShipTos').doc(row.conflict_with), {
      shipToName           : f.shipToName,
      address              : f.address  || '',
      city                 : f.city     || '',
      province             : f.province || '',
      island               : f.island   || '',
      import_job_id        : jobId,
      updatedAt            : FieldValue.serverTimestamp(),
      updated_by           : userId
    })
    batch.update(row._ref, { commit_status: COMMIT_STATUS.COMMITTED, committed_at: FieldValue.serverTimestamp() })
    return 'updated'
  }
  return 'error_skipped'
}

// createImportJob
exports.createImportJob = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { file_name, file_type, total_rows } = req.body
    if (!file_name) return res.status(400).json({ error: 'file_name is required' })
    if (!IMPORT_FILE_TYPE[file_type])
      return res.status(400).json({ error: `Invalid file_type. Must be: ${Object.keys(IMPORT_FILE_TYPE).join(', ')}` })
    if (!total_rows || total_rows < 1)
      return res.status(400).json({ error: 'total_rows must be >= 1' })
    try {
      const job_id = await nextId('import_jobs', 'IMP-', 6)
      await db.collection('import_jobs').doc(job_id).set({
        job_id,
        status          : IMPORT_JOB_STATUS.PENDING,
        file_name,
        file_type,
        module          : IMPORT_MODULE_NAME[file_type] || file_type,
        import_source   : file_type,
        total_rows,
        valid_rows      : 0,
        conflict_rows   : 0,
        error_rows      : 0,
        staged_rows     : 0,
        created_by      : req.user.uid,
        created_by_name : req.user.name || req.user.email || req.user.uid,
        created_at      : FieldValue.serverTimestamp(),
        updated_at      : FieldValue.serverTimestamp(),
        committed_at    : null,
        committed_by    : null
      })
      await writeAudit(AUDIT.IMPORT_JOB_CREATED, req.user.uid, job_id, { file_name, file_type, total_rows })
      return res.status(201).json({ ok: true, job_id })
    } catch (err) {
      console.error('[import] createImportJob:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// submitImportRows
exports.submitImportRows = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { job_id, rows } = req.body
    if (!job_id) return res.status(400).json({ error: 'job_id is required' })
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows must be a non-empty array' })
    if (rows.length > 300) return res.status(400).json({ error: 'Max 300 rows per chunk' })
    try {
      const jobSnap = await db.collection('import_jobs').doc(job_id).get()
      if (!jobSnap.exists) return res.status(404).json({ error: 'Import job not found' })
      const job = jobSnap.data()
      if (job.status !== IMPORT_JOB_STATUS.PENDING && job.status !== IMPORT_JOB_STATUS.STAGED)
        return res.status(400).json({ error: `Cannot submit rows to a job with status: ${job.status}` })
      if (job.created_by !== req.user.uid) return res.status(403).json({ error: 'You do not own this import job' })
      const stagingIds = await reserveIds('import_staging', 'STG-', 8, rows.length)
      const expiry = expiresAt()
      const batch  = db.batch()
      rows.forEach((row, i) => {
        const { primary_key, fields } = extractFields(job.file_type, row)
        const primary_key_field = IMPORT_PRIMARY_KEY_FIELD[job.file_type] || 'primary_key'
        const ref = db.collection('import_staging').doc(stagingIds[i])
        batch.set(ref, {
          staging_id           : stagingIds[i],
          job_id,
          row_number           : row.row_number || 0,
          raw_row              : row.raw_row || {},
          primary_key,
          primary_key_field,
          fields,
          ...(job.file_type === IMPORT_FILE_TYPE.PRODUCT ? {
            product_code : fields.product_code,
            product_name : fields.product_name,
            sku          : fields.sku
          } : {}),
          validation_status    : VALIDATION_STATUS.OK,
          validation_errors    : [],
          conflict_type        : null,
          conflict_with        : null,
          similar_name_warning : false,
          user_decision        : null,
          decided_at           : null,
          decided_by           : null,
          commit_status        : COMMIT_STATUS.PENDING,
          committed_at         : null,
          cleanup_status       : CLEANUP_STATUS.ACTIVE,
          expires_at           : expiry,
          created_at           : FieldValue.serverTimestamp()
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

// validateImportJob
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
      if (job.created_by !== req.user.uid) return res.status(403).json({ error: 'You do not own this import job' })
      if (job.status !== IMPORT_JOB_STATUS.STAGED)
        return res.status(400).json({ error: `Job must be STAGED to validate. Current: ${job.status}` })
      const stagingSnap = await db.collection('import_staging')
        .where('job_id', '==', job_id).orderBy('row_number').get()
      const stagingRows = stagingSnap.docs.map(d => ({ _ref: d.ref, ...d.data() }))
      let validationResult
      if (job.file_type === IMPORT_FILE_TYPE.PRODUCT) {
        validationResult = await validateProduct(stagingRows, db)
      } else if (job.file_type === IMPORT_FILE_TYPE.CUSTOMER) {
        validationResult = await validateCustomer(stagingRows, db)
      } else if (job.file_type === IMPORT_FILE_TYPE.SHIP_TO) {
        validationResult = await validateShipTo(stagingRows, db)
      } else {
        return res.status(400).json({ error: `Unknown file_type: ${job.file_type}` })
      }
      const { results, valid_rows, conflict_rows, error_rows } = validationResult
      const BATCH_SIZE = 400
      let currentBatch = db.batch(), batchCount = 0
      const flushBatch = async () => {
        if (batchCount > 0) { await currentBatch.commit(); currentBatch = db.batch(); batchCount = 0 }
      }
      for (const result of results) {
        currentBatch.update(result._ref, {
          validation_status    : result.validation_status,
          validation_errors    : result.validation_errors,
          conflict_type        : result.conflict_type,
          conflict_with        : result.conflict_with,
          similar_name_warning : result.similar_name_warning || false,
          user_decision        : null,
          decided_at           : null,
          decided_by           : null,
          commit_status        : COMMIT_STATUS.PENDING,
          committed_at         : null
        })
        batchCount++
        if (batchCount >= BATCH_SIZE) await flushBatch()
      }
      await flushBatch()
      await db.collection('import_jobs').doc(job_id).update({
        status       : IMPORT_JOB_STATUS.VALIDATED,
        valid_rows,
        conflict_rows,
        error_rows,
        validated_at : FieldValue.serverTimestamp(),
        updated_at   : FieldValue.serverTimestamp()
      })
      return res.status(200).json({ ok: true, summary: { total: stagingRows.length, valid_rows, conflict_rows, error_rows } })
    } catch (err) {
      console.error('[import] validateImportJob:', err)
      try {
        await db.collection('import_jobs').doc(job_id).update({
          status        : IMPORT_JOB_STATUS.FAILED,
          failed_at     : FieldValue.serverTimestamp(),
          failed_reason : err.message || 'Unknown error during validation',
          updated_at    : FieldValue.serverTimestamp()
        })
      } catch (_) {}
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// getImportJob
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
        .where('job_id', '==', job_id).orderBy('row_number').get()
      const rows = stagingSnap.docs.map(d => d.data())
      return res.status(200).json({ job: { job_id: jobSnap.id, ...jobSnap.data() }, rows })
    } catch (err) {
      console.error('[import] getImportJob:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// listImportJobs
exports.listImportJobs = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    try {
      const limit     = Math.min(parseInt(req.query.limit || '50', 10), 100)
      const file_type = req.query.file_type || null
      let q = db.collection('import_jobs').orderBy('created_at', 'desc')
      if (file_type) {
        if (!IMPORT_FILE_TYPE[file_type]) return res.status(400).json({ error: `Invalid file_type: ${file_type}` })
        q = q.where('file_type', '==', file_type)
      }
      q = q.limit(limit)
      const snap = await q.get()
      return res.status(200).json({ jobs: snap.docs.map(d => ({ job_id: d.id, ...d.data() })) })
    } catch (err) {
      console.error('[import] listImportJobs:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// setRowDecision
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
      await ref.update({ user_decision: decision, decided_at: FieldValue.serverTimestamp(), decided_by: req.user.uid })
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[import] setRowDecision:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// commitImportJob
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
      if (job.created_by !== req.user.uid) return res.status(403).json({ error: 'You do not own this import job' })
      if (![IMPORT_JOB_STATUS.VALIDATED, IMPORT_JOB_STATUS.PARTIALLY_COMMITTED].includes(job.status))
        return res.status(400).json({ error: `Job must be VALIDATED to commit. Current: ${job.status}` })
      const stagingSnap = await db.collection('import_staging')
        .where('job_id', '==', job_id).orderBy('row_number').get()
      const allRows = stagingSnap.docs.map(d => ({ _ref: d.ref, ...d.data() }))
      const pendingRows = allRows.filter(r =>
        r.commit_status === COMMIT_STATUS.PENDING || r.commit_status === COMMIT_STATUS.PROCESSING)
      const unresolved = pendingRows.filter(r =>
        r.validation_status === VALIDATION_STATUS.CONFLICT && !r.user_decision)
      if (unresolved.length > 0)
        return res.status(400).json({ error: 'Unresolved conflicts exist.', unresolved_count: unresolved.length })
      const insertRows = pendingRows.filter(r => r.validation_status === VALIDATION_STATUS.OK)
      let reservedIds = []
      if (insertRows.length > 0 && job.file_type === IMPORT_FILE_TYPE.PRODUCT)
        reservedIds = await reserveIds('products', 'PRD-', 6, insertRows.length)
      let idIndex = 0
      let inserted = 0, updated = 0, skipped = 0, manual_review = 0, errors_skipped = 0
      const BATCH_SIZE = 400
      let currentBatch = db.batch(), batchCount = 0
      const flushBatch = async () => {
        if (batchCount > 0) { await currentBatch.commit(); currentBatch = db.batch(); batchCount = 0 }
      }
      for (const row of pendingRows) {
        const reservedId = (row.validation_status === VALIDATION_STATUS.OK) ? reservedIds[idIndex++] : null
        let outcome
        if (job.file_type === IMPORT_FILE_TYPE.PRODUCT) {
          outcome = await commitProduct(row, currentBatch, reservedId, req.user.uid, job_id)
        } else if (job.file_type === IMPORT_FILE_TYPE.CUSTOMER) {
          outcome = await commitCustomer(row, currentBatch, reservedId, req.user.uid, job_id)
        } else if (job.file_type === IMPORT_FILE_TYPE.SHIP_TO) {
          outcome = await commitShipTo(row, currentBatch, reservedId, req.user.uid, job_id)
        } else {
          return res.status(400).json({ error: `Unknown file_type: ${job.file_type}` })
        }
        if      (outcome === 'inserted')      inserted++
        else if (outcome === 'updated')       updated++
        else if (outcome === 'skipped')       skipped++
        else if (outcome === 'manual_review') manual_review++
        else if (outcome === 'error_skipped') errors_skipped++
        batchCount += 3
        if (batchCount >= BATCH_SIZE) await flushBatch()
      }
      await flushBatch()
      const remainingManual = allRows.filter(r =>
        r.commit_status === COMMIT_STATUS.PENDING && r.user_decision === USER_DECISION.MANUAL_REVIEW
      ).length + manual_review
      const finalStatus = remainingManual > 0 ? IMPORT_JOB_STATUS.PARTIALLY_COMMITTED : IMPORT_JOB_STATUS.COMMITTED
      await db.collection('import_jobs').doc(job_id).update({
        status         : finalStatus,
        committed_at   : FieldValue.serverTimestamp(),
        committed_by   : req.user.uid,
        committed_rows : inserted + updated,
        skipped_rows   : skipped,
        updated_at     : FieldValue.serverTimestamp()
      })
      await writeAudit(AUDIT.IMPORT_JOB_COMMITTED, req.user.uid, job_id,
        { file_type: job.file_type, inserted, updated, skipped, manual_review, errors_skipped })
      return res.status(200).json({ ok: true, status: finalStatus,
        summary: { inserted, updated, skipped, manual_review, errors_skipped } })
    } catch (err) {
      console.error('[import] commitImportJob:', err)
      try {
        await db.collection('import_jobs').doc(job_id).update({
          status        : IMPORT_JOB_STATUS.FAILED,
          failed_at     : FieldValue.serverTimestamp(),
          failed_reason : err.message || 'Unknown error during commit',
          updated_at    : FieldValue.serverTimestamp()
        })
      } catch (_) {}
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// cancelImportJob
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
      if (job.created_by !== req.user.uid) return res.status(403).json({ error: 'You do not own this import job' })
      if ([IMPORT_JOB_STATUS.COMMITTED, IMPORT_JOB_STATUS.CANCELLED].includes(job.status))
        return res.status(400).json({ error: `Cannot cancel a job with status: ${job.status}` })
      await db.collection('import_jobs').doc(job_id).update({
        status       : IMPORT_JOB_STATUS.CANCELLED,
        cancelled_at : FieldValue.serverTimestamp(),
        cancelled_by : req.user.uid,
        updated_at   : FieldValue.serverTimestamp()
      })
      await writeAudit(AUDIT.IMPORT_JOB_CANCELLED, req.user.uid, job_id, {})
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[import] cancelImportJob:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)
