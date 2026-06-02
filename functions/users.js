'use strict'

const { onRequest } = require('firebase-functions/v2/https')
const { db, admin } = require('./db')
const { requireAuth, requireActive, requireRole } = require('./middleware')
const { writeAudit } = require('./audit')
const { VALID_ROLES, MAX_ROLES, STATUS, AUDIT } = require('./constants')

const FieldValue = admin.firestore.FieldValue

function validateRoles(roles) {
  if (!Array.isArray(roles))          return 'roles must be an array'
  if (roles.length < 1)              return 'minimum 1 role required'
  if (roles.length > MAX_ROLES)      return `maximum ${MAX_ROLES} roles allowed`
  const invalid = roles.filter(r => !VALID_ROLES.includes(r))
  if (invalid.length)                return `invalid roles: ${invalid.join(', ')}`
  return null
}

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

exports.register = onRequest(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { uid, name, email } = req.body
  if (!uid || !name || !email) return res.status(400).json({ error: 'uid, name, and email are required' })
  try {
    const existing = await db.collection('users').doc(uid).get()
    if (existing.exists) return res.status(409).json({ error: 'User already registered' })
    await db.collection('users').doc(uid).set({ name, email, status: STATUS.PENDING, roles: [], created_at: FieldValue.serverTimestamp(), approved_at: null, approved_by: null })
    await writeAudit(AUDIT.USER_REGISTERED, uid, uid, { email })
    return res.status(201).json({ ok: true })
  } catch (err) { console.error('[users] register error:', err); return res.status(500).json({ error: 'Internal error' }) }
})

exports.getMe = run([requireAuth], async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const { uid, ...userData } = req.user
  return res.status(200).json({ uid, ...userData })
})

exports.listUsers = run([requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')], async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  try {
    const { status } = req.query
    const validStatuses = Object.values(STATUS)
    let query = db.collection('users').orderBy('created_at', 'desc')
    if (status) {
      if (!validStatuses.includes(status)) return res.status(400).json({ error: `Invalid status filter: ${status}` })
      query = query.where('status', '==', status)
    }
    const snap = await query.get()
    return res.status(200).json({ users: snap.docs.map(d => ({ uid: d.id, ...d.data() })) })
  } catch (err) { console.error('[users] listUsers error:', err); return res.status(500).json({ error: 'Internal error' }) }
})

exports.getUser = run([requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')], async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const { uid } = req.query
  if (!uid) return res.status(400).json({ error: 'uid is required' })
  try {
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })
    return res.status(200).json({ uid: snap.id, ...snap.data() })
  } catch (err) { console.error('[users] getUser error:', err); return res.status(500).json({ error: 'Internal error' }) }
})

exports.approveUser = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { uid, roles } = req.body
  if (!uid) return res.status(400).json({ error: 'uid is required' })
  const roleError = validateRoles(roles)
  if (roleError) return res.status(400).json({ error: roleError })
  try {
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })
    if (snap.data().status !== STATUS.PENDING) return res.status(400).json({ error: 'User is not in PENDING status' })
    await db.collection('users').doc(uid).update({ status: STATUS.ACTIVE, roles, approved_at: FieldValue.serverTimestamp(), approved_by: req.user.uid })
    await writeAudit(AUDIT.USER_APPROVED, req.user.uid, uid, { roles })
    return res.status(200).json({ ok: true })
  } catch (err) { console.error('[users] approveUser error:', err); return res.status(500).json({ error: 'Internal error' }) }
})

exports.updateUserRoles = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { uid, roles } = req.body
  if (!uid) return res.status(400).json({ error: 'uid is required' })
  const roleError = validateRoles(roles)
  if (roleError) return res.status(400).json({ error: roleError })
  try {
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })
    const before = snap.data().roles
    await db.collection('users').doc(uid).update({ roles })
    await writeAudit(AUDIT.USER_ROLES_UPDATED, req.user.uid, uid, { before, after: roles })
    return res.status(200).json({ ok: true })
  } catch (err) { console.error('[users] updateUserRoles error:', err); return res.status(500).json({ error: 'Internal error' }) }
})

exports.deactivateUser = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { uid } = req.body
  if (!uid) return res.status(400).json({ error: 'uid is required' })
  if (uid === req.user.uid) return res.status(400).json({ error: 'Cannot deactivate your own account' })
  try {
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })
    if (snap.data().status === STATUS.INACTIVE) return res.status(400).json({ error: 'User is already INACTIVE' })
    await db.collection('users').doc(uid).update({ status: STATUS.INACTIVE })
    await writeAudit(AUDIT.USER_DEACTIVATED, req.user.uid, uid, {})
    return res.status(200).json({ ok: true })
  } catch (err) { console.error('[users] deactivateUser error:', err); return res.status(500).json({ error: 'Internal error' }) }
})

exports.reactivateUser = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { uid } = req.body
  if (!uid) return res.status(400).json({ error: 'uid is required' })
  try {
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })
    if (snap.data().status !== STATUS.INACTIVE) return res.status(400).json({ error: 'User is not INACTIVE' })
    await db.collection('users').doc(uid).update({ status: STATUS.ACTIVE })
    await writeAudit(AUDIT.USER_REACTIVATED, req.user.uid, uid, {})
    return res.status(200).json({ ok: true })
  } catch (err) { console.error('[users] reactivateUser error:', err); return res.status(500).json({ error: 'Internal error' }) }
})
