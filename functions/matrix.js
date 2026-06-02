'use strict'

const { onRequest }  = require('firebase-functions/v2/https')
const { db, admin }  = require('./db')
const { requireAuth, requireActive, requireRole } = require('./middleware')
const { writeAudit } = require('./audit')
const { STATUS, MATRIX_ROLE_MAP, MATRIX_SLOTS, AUDIT } = require('./constants')

const FieldValue = admin.firestore.FieldValue

function run(middlewares, handler) {
  return onRequest(async (req, res) => {
    let idx = 0
    const next = async () => {
      const mw = middlewares[idx++]
      if (mw) {
        const mwResult = mw(req, res, next)
        if (mwResult && typeof mwResult.then === 'function') await mwResult
      } else {
        await handler(req, res)
      }
    }
    await next()
  })
}

async function validateMatrixUsers(body) {
  for (const slot of MATRIX_SLOTS) {
    const uid = body[slot]
    if (!uid) return `${slot} is required`
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return `${slot}: user not found (uid: ${uid})`
    const user = snap.data()
    if (user.status !== STATUS.ACTIVE) return `${slot}: user is not ACTIVE (uid: ${uid})`
    const requiredRole = MATRIX_ROLE_MAP[slot]
    if (!user.roles || !user.roles.includes(requiredRole)) return `${slot}: user must have role ${requiredRole} (uid: ${uid})`
  }
  return null
}

async function closeExistingMatrix(salesOwnerId, closedBy) {
  const snap = await db.collection('approval_matrix').where('sales_owner_id', '==', salesOwnerId).where('is_active', '==', true).get()
  if (snap.empty) return
  const batch = db.batch()
  snap.docs.forEach(doc => { batch.update(doc.ref, { is_active: false, effective_to: FieldValue.serverTimestamp() }) })
  await batch.commit()
  for (const doc of snap.docs) { await writeAudit(AUDIT.MATRIX_CLOSED, closedBy, doc.id, { reason: 'superseded by new matrix row' }) }
}

exports.listMatrix = run([requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')], async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  try {
    const activeOnly = req.query.active !== 'false'
    let query = db.collection('approval_matrix').orderBy('created_at', 'desc')
    if (activeOnly) query = query.where('is_active', '==', true)
    const snap = await query.get()
    return res.status(200).json({ matrix: snap.docs.map(d => ({ id: d.id, ...d.data() })) })
  } catch (err) { console.error('[matrix] listMatrix error:', err); return res.status(500).json({ error: 'Internal error' }) }
})

exports.getMatrix = run([requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')], async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const { id } = req.query
  if (!id) return res.status(400).json({ error: 'id is required' })
  try {
    const snap = await db.collection('approval_matrix').doc(id).get()
    if (!snap.exists) return res.status(404).json({ error: 'Matrix row not found' })
    return res.status(200).json({ id: snap.id, ...snap.data() })
  } catch (err) { console.error('[matrix] getMatrix error:', err); return res.status(500).json({ error: 'Internal error' }) }
})

exports.createMatrix = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { sales_owner_id, rm_id, dm_id, sd_id, md_id, effective_from } = req.body
  if (!effective_from) return res.status(400).json({ error: 'effective_from is required' })
  const effectiveFromDate = new Date(effective_from)
  if (isNaN(effectiveFromDate.getTime())) return res.status(400).json({ error: 'effective_from must be a valid date' })
  try {
    const validationError = await validateMatrixUsers(req.body)
    if (validationError) return res.status(400).json({ error: validationError })
    await closeExistingMatrix(sales_owner_id, req.user.uid)
    const ref = await db.collection('approval_matrix').add({ sales_owner_id, rm_id, dm_id, sd_id, md_id, effective_from: admin.firestore.Timestamp.fromDate(effectiveFromDate), effective_to: null, is_active: true, created_by: req.user.uid, created_at: FieldValue.serverTimestamp() })
    await writeAudit(AUDIT.MATRIX_CREATED, req.user.uid, ref.id, { sales_owner_id, rm_id, dm_id, sd_id, md_id })
    return res.status(201).json({ ok: true, id: ref.id })
  } catch (err) { console.error('[matrix] createMatrix error:', err); return res.status(500).json({ error: 'Internal error' }) }
})

exports.closeMatrix = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { id } = req.body
  if (!id) return res.status(400).json({ error: 'id is required' })
  try {
    const snap = await db.collection('approval_matrix').doc(id).get()
    if (!snap.exists) return res.status(404).json({ error: 'Matrix row not found' })
    if (!snap.data().is_active) return res.status(400).json({ error: 'Matrix row is already closed' })
    await db.collection('approval_matrix').doc(id).update({ is_active: false, effective_to: FieldValue.serverTimestamp() })
    await writeAudit(AUDIT.MATRIX_CLOSED, req.user.uid, id, {})
    return res.status(200).json({ ok: true })
  } catch (err) { console.error('[matrix] closeMatrix error:', err); return res.status(500).json({ error: 'Internal error' }) }
})
