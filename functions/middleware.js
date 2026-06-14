'use strict'
const { admin, db } = require('./db')
const { STATUS }    = require('./constants')

const ALLOWED_ORIGINS = [
  'https://fcos-production.web.app',
  'https://fcos-production.firebaseapp.com',
  'http://localhost:5000',
  'http://127.0.0.1:5000'
]

// Portal origins — SEPARATE allowlist for external PO Portal
const PORTAL_ALLOWED_ORIGINS = [
  'https://po.fuchs.co.id',
  'https://po-portal-fcos.web.app',
  'https://po-portal-fcos.firebaseapp.com',
  'http://localhost:5001',
  'http://127.0.0.1:5001'
]

function setPortalCors(req, res) {
  const origin = req.headers.origin || ''
  if (PORTAL_ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.set('Access-Control-Max-Age', '3600')
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.set('Access-Control-Max-Age', '3600')
}

async function requireAuth(req, res, next) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).send('')

  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return res.status(401).json({ error: 'Unauthorized', message: 'Missing token' })
    let decoded
    try { decoded = await admin.auth().verifyIdToken(token) }
    catch (err) { return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' }) }
    const snap = await db.collection('users').doc(decoded.uid).get()
    if (!snap.exists) return res.status(403).json({ error: 'Forbidden', message: 'User not found' })
    const user = snap.data()
    if (user.status === STATUS.INACTIVE) return res.status(403).json({ error: 'INACTIVE', message: 'Account is deactivated' })
    req.user = { uid: decoded.uid, ...user }
    next()
  } catch (err) {
    console.error('[middleware] requireAuth error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}

function requireActive(req, res, next) {
  if (req.user.status !== STATUS.ACTIVE) {
    return res.status(403).json({ error: 'PENDING', message: 'Account is awaiting approval' })
  }
  next()
}

function requireRole(...requiredRoles) {
  return (req, res, next) => {
    const userRoles = req.user.roles || []
    const hasRole   = requiredRoles.some(r => userRoles.includes(r))
    if (!hasRole) return res.status(403).json({ error: 'Forbidden', message: `Required role: ${requiredRoles.join(' or ')}` })
    next()
  }
}

// ── requirePortalAuth ────────────────────────────────────────
// ISOLATED external-portal auth. Loads ONLY customer_users/{uid}.
// NEVER touches the users collection or FCOS roles.
async function requirePortalAuth(req, res, next) {
  setPortalCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).send('')

  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return res.status(401).json({ error: 'Unauthorized', message: 'Missing token' })

    let decoded
    try { decoded = await admin.auth().verifyIdToken(token) }
    catch (err) { return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' }) }

    const snap = await db.collection('customer_users').doc(decoded.uid).get()
    if (!snap.exists) return res.status(403).json({ error: 'Forbidden', message: 'Portal user not found' })

    const pu = snap.data()
    if (pu.status !== 'ACTIVE') return res.status(403).json({ error: 'Forbidden', message: 'Portal account is not active' })

    if (!pu.customer_code) return res.status(403).json({ error: 'Forbidden', message: 'Portal account is not bound to a customer' })

    // Minimal identity surface — NO roles, NO FCOS fields
    req.portalUser = {
      uid           : decoded.uid,
      email         : pu.email || decoded.email || null,
      customer_code : pu.customer_code
    }
    next()
  } catch (err) {
    console.error('[middleware] requirePortalAuth error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}

module.exports = { requireAuth, requireActive, requireRole, setCors, requirePortalAuth, setPortalCors }
