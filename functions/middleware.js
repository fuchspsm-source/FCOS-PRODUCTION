'use strict'
const { admin, db } = require('./db')
const { STATUS }    = require('./constants')

const ALLOWED_ORIGINS = [
  'https://fcos-production.web.app',
  'https://fcos-production.firebaseapp.com',
  'http://localhost:5000',
  'http://127.0.0.1:5000'
]

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

module.exports = { requireAuth, requireActive, requireRole, setCors }
