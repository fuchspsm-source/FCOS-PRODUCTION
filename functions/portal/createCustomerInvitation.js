'use strict'

const { onRequest }                  = require('firebase-functions/v2/https')
const { db, admin }                  = require('../db')
const { requireAuth, requireActive, requireRole } = require('../middleware')
const { writeAudit }                 = require('../audit')
const { INVITATION_STATUS, PORTAL_AUDIT } = require('./constants')

const FieldValue = admin.firestore.FieldValue
const REGION     = 'us-central1'
const EXPIRY_DAYS = 7

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

async function nextInvitationId() {
  const ref = db.collection('_sequences').doc('customer_invitations')
  const id  = await db.runTransaction(async tx => {
    const snap = await tx.get(ref)
    const next = snap.exists ? (snap.data().current + 1) : 1
    tx.set(ref, { current: next })
    return next
  })
  return 'INV-' + String(id).padStart(6, '0')
}

exports.createCustomerInvitation = onRequest({ region: REGION }, run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const { email, name, customer_code } = req.body || {}

    if (!email?.trim())         return res.status(400).json({ error: 'email is required' })
    if (!customer_code?.trim()) return res.status(400).json({ error: 'customer_code is required' })

    const emailNorm = email.trim().toLowerCase()
    const code      = customer_code.trim().toUpperCase()

    try {
      // V1: Customer must exist and be active
      const custSnap = await db.collection('customers')
        .where('customerCode', '==', code)
        .limit(1)
        .get()

      if (custSnap.empty)
        return res.status(404).json({ error: `Customer not found: ${code}` })

      const cust = custSnap.docs[0].data()
      if (cust.active === false)
        return res.status(400).json({ error: `Customer is not active: ${code}` })

      // Generate invitation
      const invitation_id = await nextInvitationId()
      const now           = new Date()
      const expires       = new Date(now.getTime() + EXPIRY_DAYS * 24 * 60 * 60 * 1000)

      await db.collection('customer_invitations').doc(invitation_id).set({
        invitation_id,
        email      : emailNorm,
        name       : (name || '').trim(),
        customer_code : code,
        status     : INVITATION_STATUS.PENDING,
        invited_by : req.user.uid,
        invited_at : FieldValue.serverTimestamp(),
        expires_at : admin.firestore.Timestamp.fromDate(expires)
      })

      await writeAudit(PORTAL_AUDIT.CUSTOMER_INVITATION_CREATED, req.user.uid, invitation_id, {
        invitation_id, email: emailNorm, customer_code: code
      })

      return res.status(201).json({ invitation_id, status: INVITATION_STATUS.PENDING })

    } catch (err) {
      console.error('[portal] createCustomerInvitation:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
