'use strict'

const { onRequest } = require('firebase-functions/v2/https')
const { db, admin } = require('./db')
const { requireAuth, requireActive, requireRole, setCors } = require("./middleware")
const { writeAudit } = require('./audit')
const { VALID_ROLES, VALID_POSITIONS, MAX_ROLES, STATUS, AUDIT, VALID_AUTHORITY_RANKS, AUTHORITY_RANK, ROLES } = require('./constants')

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

  let manager_name = null
  if (userData.manager_user_id) {
    const mgrSnap = await db.collection('users').doc(userData.manager_user_id).get()
    if (mgrSnap.exists) manager_name = mgrSnap.data().name || null
  }

  let position_label = null
  if (userData.position_id) {
    const posSnap = await db.collection('positions').doc(userData.position_id).get()
    if (posSnap.exists) position_label = posSnap.data().label || null
  }

  return res.status(200).json({ uid, ...userData, manager_name, position_label })
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
// Activation gate only. Reads all org fields from Firestore.
// Accepts uid only. Writes: status, approved_at, approved_by, updated_at.
// Must not modify: roles, position_id, authority_rank, manager_user_id.

exports.approveUser = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { uid } = req.body
  if (!uid) return res.status(400).json({ error: 'uid is required' })

  try {
    // Target user exists
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })

    const user = snap.data()

    // Must be PENDING
    if (user.status === STATUS.ACTIVE)   return res.status(400).json({ error: 'User is already ACTIVE' })
    if (user.status === STATUS.INACTIVE) return res.status(400).json({ error: 'Cannot approve an INACTIVE user. Use reactivateUser.' })

    // Step 5 — position_id
    if (!user.position_id) {
      return res.status(400).json({ error: 'Cannot activate: position_id is not assigned. Use updateUserPosition first.' })
    }
    const posSnap = await db.collection('positions').doc(user.position_id).get()
    if (!posSnap.exists) {
      return res.status(400).json({ error: 'Cannot activate: assigned position does not exist. Use updateUserPosition to reassign.' })
    }
    if (!posSnap.data().is_active) {
      return res.status(400).json({ error: 'Cannot activate: assigned position is inactive. Use updateUserPosition to reassign.' })
    }

    // Step 6 — authority_rank
    if (!user.authority_rank) {
      return res.status(400).json({ error: 'Cannot activate: authority_rank is not assigned. Use updateUserAuthorityRank first.' })
    }
    if (!VALID_AUTHORITY_RANKS.includes(user.authority_rank)) {
      return res.status(400).json({ error: 'Cannot activate: authority_rank value is invalid. Use updateUserAuthorityRank to correct it.' })
    }

     // Step 7 — manager_user_id (optional — can be set after activation)
     if (user.manager_user_id) {
       const managerSnap = await db.collection('users').doc(user.manager_user_id).get()
       if (!managerSnap.exists) {
         return res.status(400).json({ error: 'Cannot activate: assigned manager does not exist. Use updateUserManager to reassign.' })
       }
       const managerStatus = managerSnap.data().status
       if (managerStatus === STATUS.INACTIVE) {
         return res.status(400).json({ error: 'Cannot activate: assigned manager is INACTIVE. Use updateUserManager to reassign.' })
       }
       if (managerStatus === STATUS.PENDING) {
         return res.status(400).json({ error: 'Cannot activate: assigned manager is still PENDING. Manager must be ACTIVE first.' })
       }
     }

    // Step 8 — roles[]
    const roles = user.roles || []
    if (!Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({ error: 'Cannot activate: roles are not assigned. Use updateUserRoles first.' })
    }
    const invalidRoles = roles.filter(r => !VALID_ROLES.includes(r))
    if (invalidRoles.length > 0) {
      return res.status(400).json({ error: 'Cannot activate: roles contain invalid values. Use updateUserRoles to correct.' })
    }

    // Write — activation state only
    await db.collection('users').doc(uid).update({
      status      : STATUS.ACTIVE,
      approved_at : FieldValue.serverTimestamp(),
      approved_by : req.user.uid,
      updated_at  : FieldValue.serverTimestamp()
    })

    await writeAudit(AUDIT.USER_APPROVED, req.user.uid, uid, {})

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
// Activation gate + status restore. INACTIVE → ACTIVE.
// Same gate as approveUser. Reads all org fields from Firestore.
// Writes: status, updated_at only.

exports.reactivateUser = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { uid } = req.body
  if (!uid) return res.status(400).json({ error: 'uid is required' })

  try {
    // Target user exists
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })

    const user = snap.data()

    // Must be INACTIVE
    if (user.status === STATUS.ACTIVE)  return res.status(400).json({ error: 'User is not INACTIVE' })
    if (user.status === STATUS.PENDING) return res.status(400).json({ error: 'Cannot reactivate a PENDING user. Use approveUser.' })

    // Step 5 — position_id
    if (!user.position_id) {
      return res.status(400).json({ error: 'Cannot activate: position_id is not assigned. Use updateUserPosition first.' })
    }
    const posSnap = await db.collection('positions').doc(user.position_id).get()
    if (!posSnap.exists) {
      return res.status(400).json({ error: 'Cannot activate: assigned position does not exist. Use updateUserPosition to reassign.' })
    }
    if (!posSnap.data().is_active) {
      return res.status(400).json({ error: 'Cannot activate: assigned position is inactive. Use updateUserPosition to reassign.' })
    }

    // Step 6 — authority_rank
    if (!user.authority_rank) {
      return res.status(400).json({ error: 'Cannot activate: authority_rank is not assigned. Use updateUserAuthorityRank first.' })
    }
    if (!VALID_AUTHORITY_RANKS.includes(user.authority_rank)) {
      return res.status(400).json({ error: 'Cannot activate: authority_rank value is invalid. Use updateUserAuthorityRank to correct it.' })
    }

    // Step 7 — manager_user_id
    if (user.authority_rank !== AUTHORITY_RANK.MANAGING_DIRECTOR) {
      if (!user.manager_user_id) {
        return res.status(400).json({ error: 'Cannot activate: manager_user_id is not assigned. Use updateUserManager first.' })
      }
      const managerSnap = await db.collection('users').doc(user.manager_user_id).get()
      if (!managerSnap.exists) {
        return res.status(400).json({ error: 'Cannot activate: assigned manager does not exist. Use updateUserManager to reassign.' })
      }
      const managerStatus = managerSnap.data().status
      if (managerStatus === STATUS.INACTIVE) {
        return res.status(400).json({ error: 'Cannot activate: assigned manager is INACTIVE. Use updateUserManager to reassign.' })
      }
      if (managerStatus === STATUS.PENDING) {
        return res.status(400).json({ error: 'Cannot activate: assigned manager is still PENDING. Manager must be ACTIVE first.' })
      }
    }

    // Step 8 — roles[]
    const roles = user.roles || []
    if (!Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({ error: 'Cannot activate: roles are not assigned. Use updateUserRoles first.' })
    }
    const invalidRoles = roles.filter(r => !VALID_ROLES.includes(r))
    if (invalidRoles.length > 0) {
      return res.status(400).json({ error: 'Cannot activate: roles contain invalid values. Use updateUserRoles to correct.' })
    }

    // Write — status only
    await db.collection('users').doc(uid).update({
      status     : STATUS.ACTIVE,
      updated_at : FieldValue.serverTimestamp()
    })

    await writeAudit(AUDIT.USER_REACTIVATED, req.user.uid, uid, {})

    return res.status(200).json({ ok: true })

  } catch (err) {
    console.error('[users] reactivateUser error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

exports.updateUserAuthorityRank = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { uid, authority_rank } = req.body

  // Input presence
  if (!uid)            return res.status(400).json({ error: 'uid is required' })
  if (!authority_rank) return res.status(400).json({ error: 'authority_rank is required' })

  // Enum check
  if (!VALID_AUTHORITY_RANKS.includes(authority_rank)) {
    return res.status(400).json({
      error: `Invalid authority_rank. Allowed: ${VALID_AUTHORITY_RANKS.join(', ')}`
    })
  }

  try {
    // Target user exists
    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return res.status(404).json({ error: 'User not found' })

    const user = snap.data()

    // Status check — INACTIVE rejected
    if (user.status === STATUS.INACTIVE) {
      return res.status(400).json({ error: 'Cannot update authority_rank on an INACTIVE user' })
    }

    // No-op guard
    if (user.authority_rank === authority_rank) {
      return res.status(400).json({ error: 'authority_rank is already set to this value' })
    }

    // MD downgrade guard — ACTIVE users only
    if (
      user.status === STATUS.ACTIVE &&
      user.authority_rank === AUTHORITY_RANK.MANAGING_DIRECTOR &&
      authority_rank !== AUTHORITY_RANK.MANAGING_DIRECTOR
    ) {
      if (!user.manager_user_id) {
        return res.status(409).json({
          error: 'Cannot downgrade from Managing Director while manager_user_id is null. Assign a manager first.'
        })
      }
    }

    // Write
    await db.collection('users').doc(uid).update({
      authority_rank,
      updated_by : req.user.uid,
      updated_at : FieldValue.serverTimestamp()
    })

    return res.status(200).json({ ok: true, uid, authority_rank })

  } catch (err) {
    console.error('[users] updateUserAuthorityRank error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

// ── updateUserPosition ───────────────────────────────────────
// Updates position_id on a user document. Super Admin only.
// position_id must reference an active document in positions collection.
// Non-retroactive: change applies forward only. No historical backfill.

exports.updateUserPosition = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { uid, position_id } = req.body

  // Input presence
  if (!uid)         return res.status(400).json({ error: 'uid is required' })
  if (!position_id) return res.status(400).json({ error: 'position_id is required' })

  try {
    // Target user exists
    const userSnap = await db.collection('users').doc(uid).get()
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' })

    const user = userSnap.data()

    // Status check — INACTIVE rejected
    if (user.status === STATUS.INACTIVE) {
      return res.status(400).json({ error: 'Cannot update position_id on an INACTIVE user' })
    }

    // No-op guard
    if (user.position_id === position_id) {
      return res.status(400).json({ error: 'position_id is already set to this value' })
    }

    // Position exists in positions collection
    const posSnap = await db.collection('positions').doc(position_id).get()
    if (!posSnap.exists) {
      return res.status(404).json({ error: 'Position not found' })
    }

    // Position must be active
    if (!posSnap.data().is_active) {
      return res.status(400).json({ error: 'Cannot assign an inactive position' })
    }

    // Write — non-retroactive, forward only
    await db.collection('users').doc(uid).update({
      position_id,
      updated_by : req.user.uid,
      updated_at : FieldValue.serverTimestamp()
    })

    return res.status(200).json({ ok: true, uid, position_id })

  } catch (err) {
    console.error('[users] updateUserPosition error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

  // ── updateUserManager ────────────────────────────────────────
// Updates manager_user_id on a user document. Super Admin only.
// Full cycle detection at write time. Non-retroactive.
// Body: { uid: string, manager_user_id: string | null }

const MAX_TRAVERSAL_DEPTH = 200

exports.updateUserManager = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { uid } = req.body

  // Input presence — uid
  if (!uid) return res.status(400).json({ error: 'uid is required' })

  // manager_user_id key must be explicitly present
  if (!Object.prototype.hasOwnProperty.call(req.body, 'manager_user_id')) {
    return res.status(400).json({ error: 'manager_user_id is required (use null to clear)' })
  }

  const { manager_user_id } = req.body

  // Empty string rejected
  if (manager_user_id === '') {
    return res.status(400).json({ error: 'manager_user_id cannot be an empty string. Use null to clear.' })
  }

  try {
    // Target user exists
    const userSnap = await db.collection('users').doc(uid).get()
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' })

    const user = userSnap.data()

    // Status check — INACTIVE rejected
    if (user.status === STATUS.INACTIVE) {
      return res.status(400).json({ error: 'Cannot update manager on an INACTIVE user' })
    }

    // No-op guard — covers null === null and string === string
    const currentManager = user.manager_user_id ?? null
    const incomingManager = manager_user_id ?? null
    if (currentManager === incomingManager) {
      return res.status(400).json({ error: 'manager_user_id is already set to this value' })
    }

    // Null assignment rules
    if (incomingManager === null) {
      if (user.status === STATUS.PENDING) {
        // PENDING — allowed, hierarchy not committed yet
      } else if (user.status === STATUS.ACTIVE) {
        if (!user.authority_rank) {
          return res.status(400).json({ error: 'Cannot clear manager_user_id: authority_rank must be assigned first' })
        }
        if (user.authority_rank !== AUTHORITY_RANK.MANAGING_DIRECTOR) {
          return res.status(400).json({ error: 'Cannot clear manager_user_id: user is ACTIVE and authority_rank is not Managing Director' })
        }
        // MD + ACTIVE + null → allowed
      }
    } else {
      // Non-null: self-reference guard
      if (manager_user_id === uid) {
        return res.status(400).json({ error: 'A user cannot be their own manager' })
      }

      // Manager target validation
      const managerSnap = await db.collection('users').doc(manager_user_id).get()
      if (!managerSnap.exists) {
        return res.status(404).json({ error: 'Manager user not found' })
      }
      const managerData = managerSnap.data()
      if (managerData.status === STATUS.INACTIVE) {
        return res.status(400).json({ error: 'Cannot assign an INACTIVE user as manager' })
      }
      if (managerData.status === STATUS.PENDING) {
        return res.status(400).json({ error: 'Cannot assign a PENDING user as manager' })
      }

      // Full cycle detection — traverse upward from proposed manager
      let current = managerData.manager_user_id ?? null
      let depth = 0
      while (current !== null) {
        if (depth >= MAX_TRAVERSAL_DEPTH) {
          console.error(`[users] updateUserManager cycle traversal exceeded MAX_TRAVERSAL_DEPTH for uid=${uid}`)
          return res.status(500).json({ error: 'Internal error' })
        }
        if (current === uid) {
          return res.status(409).json({ error: 'Hierarchy cycle detected' })
        }
        const hopSnap = await db.collection('users').doc(current).get()
        if (!hopSnap.exists) break // broken pointer — treat as chain end, not a cycle
        current = hopSnap.data().manager_user_id ?? null
        depth++
      }
    }

    // Write — non-retroactive, forward only
    await db.collection('users').doc(uid).update({
      manager_user_id: incomingManager,
      updated_by:      req.user.uid,
      updated_at:      FieldValue.serverTimestamp()
    })

    return res.status(200).json({ ok: true, uid, manager_user_id: incomingManager })

  } catch (err) {
    console.error('[users] updateUserManager error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})

// ── updateUserRoles ──────────────────────────────────────────
// Replaces roles[] on a user document. Super Admin only.
// Order preserved. No deduplication. Duplicates rejected.
// Last SUPER_ADMIN protection via transaction.
// Non-retroactive — no historical records touched.
// Body: { uid: string, roles: string[] }

exports.updateUserRoles = run([requireAuth, requireActive, requireRole('SUPER_ADMIN')], async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { uid } = req.body

  // Input presence — uid
  if (!uid) return res.status(400).json({ error: 'uid is required' })

  // roles key must be explicitly present
  if (!Object.prototype.hasOwnProperty.call(req.body, 'roles')) {
    return res.status(400).json({ error: 'roles is required' })
  }

  const { roles } = req.body

  // Must be array
  if (!Array.isArray(roles)) {
    return res.status(400).json({ error: 'roles must be an array' })
  }

  // Minimum 1
  if (roles.length === 0) {
    return res.status(400).json({ error: 'minimum 1 role required' })
  }

  // Duplicate check — before value validation
  const seen = new Set()
  for (const r of roles) {
    if (seen.has(r)) {
      return res.status(400).json({ error: 'Duplicate roles detected' })
    }
    seen.add(r)
  }

  // Value validation
  const invalid = roles.filter(r => !VALID_ROLES.includes(r))
  if (invalid.length > 0) {
    return res.status(400).json({
      error: `invalid roles: ${invalid.join(', ')}. Allowed: ${VALID_ROLES.join(', ')}`
    })
  }

  try {
    // Run inside transaction for Last SUPER_ADMIN protection race-safety
    await db.runTransaction(async (txn) => {

      // Target user exists
      const userRef = db.collection('users').doc(uid)
      const userSnap = await txn.get(userRef)
      if (!userSnap.exists) {
        const err = new Error('User not found')
        err.code = 404
        throw err
      }

      const user = userSnap.data()

      // Status check
      if (user.status === STATUS.INACTIVE) {
        const err = new Error('Cannot update roles on an INACTIVE user')
        err.code = 400
        throw err
      }

      // No-op guard — order-sensitive comparison
      const current = user.roles || []
      if (
        current.length === roles.length &&
        current.every((r, i) => r === roles[i])
      ) {
        const err = new Error('roles are already set to this value')
        err.code = 400
        throw err
      }

      // Last SUPER_ADMIN protection
      const removingSuperAdmin = current.includes(ROLES.SUPER_ADMIN) && !roles.includes(ROLES.SUPER_ADMIN)
      if (removingSuperAdmin) {
        const otherSuperAdminsSnap = await txn.get(
          db.collection('users')
            .where('status', '==', STATUS.ACTIVE)
            .where('roles', 'array-contains', ROLES.SUPER_ADMIN)
        )
        // Count excluding target user
        const otherCount = otherSuperAdminsSnap.docs.filter(d => d.id !== uid).length
        if (otherCount === 0) {
          const err = new Error('Cannot remove SUPER_ADMIN: no other active Super Admin exists in the system')
          err.code = 409
          throw err
        }
      }

      // Write
      txn.update(userRef, {
        roles,
        updated_by: req.user.uid,
        updated_at: FieldValue.serverTimestamp()
      })
    })

    return res.status(200).json({ ok: true, uid, roles })

  } catch (err) {
    if (err.code === 404) return res.status(404).json({ error: err.message })
    if (err.code === 400) return res.status(400).json({ error: err.message })
    if (err.code === 409) return res.status(409).json({ error: err.message })
    console.error('[users] updateUserRoles error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
})
