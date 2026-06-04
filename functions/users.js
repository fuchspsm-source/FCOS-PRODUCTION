'use strict'

const { onRequest } = require('firebase-functions/v2/https')
const { db, admin } = require('./db')
const { requireAuth, requireActive, requireRole, setCors } = require("./middleware")
const { writeAudit } = require('./audit')
const { VALID_ROLES, VALID_POSITIONS, MAX_ROLES, STATUS, AUDIT } = require('./constants')

const FieldValue = admin.firestore.FieldValue

// ── Validators ───────────────────────────────────────────────

function validateRoles(roles) {
  if (!Array.isArray(roles))               return 'roles must be an array'
  if (roles.length < 1)                    return 'minimum 1 role required'
  if (roles.length > MAX_ROLES)            return `maximum ${MAX_ROLES} roles allowed`
  const invalid = roles.filter(r => !VALID_ROLES.includes(r))
  if (invalid.length)                      return `invalid roles: ${invalid.join(', ')}`
  return null
}

function validatePosition(position_id) {
  if (!position_id)                        return 'position_id is required'
  if (!VALID_POSITIONS.includes(position_id)) return `invalid position_id: ${position_id}`
  return null
}

// ── Middleware runner ────────────────────────────────────────

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

// ── register ─────────────────────────────────────────────────

exports.register = onRequest(async (req, res) => {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).send('')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { uid, name, email } = req.body
  if (!uid || !name || !email) return res.status(400).json({ error: 'uid, name, and email are required' })
  try {
    const existing = await db.collection('users').doc(uid).get()
    if (existing.exists) return res.status(409).json({ error: 'User already registered' })
    await db.collection('users').doc(uid).set({
      name,
      email,
      status          : STATUS.PENDING,
      position_id     : null,
      roles           : [],
      manager_user_id : null,
      created_at      : FieldValue.serverTimestamp(),
      updated_at      : FieldValue.serverTimestamp(),
      approved_at     : null,
      approved_by     : null,
    })
    await writeAudit(AUDIT.USER_REGISTERED, uid, uid, { email })
    return res.status(201).json({ ok: true })
  } catch (err) {
    console.error('[users] register error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

// ── getMe ────────────────────────────────────────────────────

exports.getMe = run([requireAuth], async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const { uid, ...userData } = req.user
  return res.status(200).json({ uid, ...userData })
})

// ── listUsers ────────────────────────────────────────────────

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
  } catch (err) {
    console.error('[users] listUsers error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

// ── getUser ──────────────────────────────────────────────────

exports.getUser = run([requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')], async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const { uid } = req.query
  if (!uid) return res.status(400).json({ error: 'uid is required' })
  try {
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })
    return res.status(200).json({ uid: snap.id, ...snap.data() })
  } catch (err) {
    console.error('[users] getUser error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

// ── approveUser ──────────────────────────────────────────────

exports.approveUser = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { uid, position_id, roles, manager_user_id } = req.body

  if (!uid) return res.status(400).json({ error: 'uid is required' })

  const posError = validatePosition(position_id)
  if (posError) return res.status(400).json({ error: posError })

  const roleError = validateRoles(roles)
  if (roleError) return res.status(400).json({ error: roleError })

  // Validate manager if provided
  if (manager_user_id) {
    if (manager_user_id === uid) {
      return res.status(400).json({ error: 'manager_user_id cannot be the same as uid' })
    }
    try {
      const managerSnap = await db.collection('users').doc(manager_user_id).get()
      if (!managerSnap.exists) return res.status(400).json({ error: 'manager_user_id: user not found' })
      if (managerSnap.data().status !== STATUS.ACTIVE) {
        return res.status(400).json({ error: 'manager_user_id: manager must be ACTIVE' })
      }
    } catch (err) {
      console.error('[users] approveUser manager lookup error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }

  try {
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })
    if (snap.data().status !== STATUS.PENDING) {
      return res.status(400).json({ error: 'User is not in PENDING status' })
    }

    await db.collection('users').doc(uid).update({
      status          : STATUS.ACTIVE,
      position_id,
      roles,
      manager_user_id : manager_user_id || null,
      approved_at     : FieldValue.serverTimestamp(),
      approved_by     : req.user.uid,
      updated_at      : FieldValue.serverTimestamp(),
    })

    await writeAudit(AUDIT.USER_APPROVED, req.user.uid, uid, {
      position_id,
      roles,
      manager_user_id: manager_user_id || null,
    })

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[users] approveUser error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

// ── updateUserRoles ──────────────────────────────────────────

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
    await db.collection('users').doc(uid).update({
      roles,
      updated_at: FieldValue.serverTimestamp(),
    })
    await writeAudit(AUDIT.USER_ROLES_UPDATED, req.user.uid, uid, { before, after: roles })
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[users] updateUserRoles error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

// ── updateUserPosition ───────────────────────────────────────

exports.updateUserPosition = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { uid, position_id } = req.body
  if (!uid) return res.status(400).json({ error: 'uid is required' })
  const posError = validatePosition(position_id)
  if (posError) return res.status(400).json({ error: posError })
  try {
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })
    const before = snap.data().position_id
    await db.collection('users').doc(uid).update({
      position_id,
      updated_at: FieldValue.serverTimestamp(),
    })
    await writeAudit(AUDIT.USER_POSITION_UPDATED, req.user.uid, uid, { before, after: position_id })
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[users] updateUserPosition error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

// ── updateUserManager ────────────────────────────────────────

exports.updateUserManager = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { uid, manager_user_id } = req.body
  if (!uid) return res.status(400).json({ error: 'uid is required' })

  // manager_user_id is nullable — allow null/empty to clear manager
  const newManager = manager_user_id || null

  if (newManager) {
    if (newManager === uid) {
      return res.status(400).json({ error: 'manager_user_id cannot be the same as uid' })
    }
    try {
      const managerSnap = await db.collection('users').doc(newManager).get()
      if (!managerSnap.exists) return res.status(400).json({ error: 'manager_user_id: user not found' })
      if (managerSnap.data().status !== STATUS.ACTIVE) {
        return res.status(400).json({ error: 'manager_user_id: manager must be ACTIVE' })
      }
    } catch (err) {
      console.error('[users] updateUserManager manager lookup error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }

  try {
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })
    const before = snap.data().manager_user_id
    await db.collection('users').doc(uid).update({
      manager_user_id : newManager,
      updated_at      : FieldValue.serverTimestamp(),
    })
    await writeAudit(AUDIT.USER_MANAGER_UPDATED, req.user.uid, uid, { before, after: newManager })
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[users] updateUserManager error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

// ── deactivateUser ───────────────────────────────────────────

exports.deactivateUser = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { uid } = req.body
  if (!uid) return res.status(400).json({ error: 'uid is required' })
  if (uid === req.user.uid) return res.status(400).json({ error: 'Cannot deactivate your own account' })
  try {
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })
    if (snap.data().status === STATUS.INACTIVE) return res.status(400).json({ error: 'User is already INACTIVE' })
    await db.collection('users').doc(uid).update({
      status     : STATUS.INACTIVE,
      updated_at : FieldValue.serverTimestamp(),
    })
    await writeAudit(AUDIT.USER_DEACTIVATED, req.user.uid, uid, {})
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[users] deactivateUser error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

// ── reactivateUser ───────────────────────────────────────────

exports.reactivateUser = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { uid } = req.body
  if (!uid) return res.status(400).json({ error: 'uid is required' })
  try {
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })
    if (snap.data().status !== STATUS.INACTIVE) return res.status(400).json({ error: 'User is not INACTIVE' })
    await db.collection('users').doc(uid).update({
      status     : STATUS.ACTIVE,
      updated_at : FieldValue.serverTimestamp(),
    })
    await writeAudit(AUDIT.USER_REACTIVATED, req.user.uid, uid, {})
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[users] reactivateUser error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})
