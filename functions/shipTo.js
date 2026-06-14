'use strict'
const { onRequest } = require('firebase-functions/v2/https')
const { db, admin } = require('./db')
const { requireAuth, requireActive, requireRole, setCors } = require('./middleware')

const FieldValue = admin.firestore.FieldValue

function run(middlewares, handler) {
  return async (req, res) => {
    let idx = 0
    const next = async () => {
      if (idx < middlewares.length) {
        await middlewares[idx++](req, res, next)
      } else {
        await handler(req, res)
      }
    }
    await next()
  }
}

// ============================================================
// listShipTos
// ============================================================
exports.listShipTos = onRequest(run(
  [requireAuth, requireActive],
  async (req, res) => {
    try {
      const { soldToId, activeOnly, search } = req.query
      let query = db.collection('customerShipTos').orderBy('shipToCode')
      if (soldToId)          query = query.where('soldToId', '==', soldToId)
      if (activeOnly === 'true') query = query.where('active', '==', true)
      const snap = await query.get()
      let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      if (search) {
        const s = search.toLowerCase()
        docs = docs.filter(d =>
          d.shipToCode?.toLowerCase().includes(s) ||
          d.shipToName?.toLowerCase().includes(s) ||
          d.soldToCode?.toLowerCase().includes(s) ||
          d.soldToName?.toLowerCase().includes(s)
        )
      }
      return res.json({ shipTos: docs })
    } catch (err) {
      console.error('[listShipTos]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

// ============================================================
// createShipTo
// ============================================================
exports.createShipTo = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    try {
      const { shipToCode, shipToName, soldToId,
              address, city, province, island } = req.body || {}

      // Required fields
      if (!shipToCode?.trim())
        return res.status(400).json({ error: 'Ship-To Code is required.' })
      if (!shipToName?.trim())
        return res.status(400).json({ error: 'Ship-To Name is required.' })
      if (!soldToId)
        return res.status(400).json({ error: 'Parent Sold-To is required.' })

      // Validate parent Sold-To exists and is active
      const soldToSnap = await db.collection('customers').doc(soldToId).get()
      if (!soldToSnap.exists)
        return res.status(404).json({ error: 'Parent Sold-To not found.' })
      const soldToData = soldToSnap.data()
      if (!soldToData.active)
        return res.status(400).json({ error: 'Cannot create Ship-To under an inactive Sold-To.' })

      // Global uniqueness check on shipToCode
      const existing = await db.collection('customerShipTos')
        .where('shipToCode', '==', shipToCode.trim().toUpperCase())
        .get()
      if (!existing.empty)
        return res.status(409).json({ error: 'Ship-To Code already exists.' })

      const now = FieldValue.serverTimestamp()
      const ref = await db.collection('customerShipTos').add({
        shipToCode: shipToCode.trim().toUpperCase(),
        shipToName: shipToName.trim(),
        soldToId,
        soldToCode: soldToData.customerCode,
        soldToName: soldToData.customerName,
        address:    address  ? address.trim()  : '',
        city:       city     ? city.trim()     : '',
        province:   province ? province.trim() : '',
        island:     island   ? island.trim()   : '',
        active:     true,
        createdAt:  now,
        updatedAt:  now,
      })
      return res.json({ id: ref.id })
    } catch (err) {
      console.error('[createShipTo]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

// ============================================================
// updateShipTo
// ============================================================
exports.updateShipTo = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    try {
      const { id, shipToName, address, city, province, island } = req.body || {}

      if (!id)
        return res.status(400).json({ error: 'ID is required.' })

      const ref  = db.collection('customerShipTos').doc(id)
      const snap = await ref.get()
      if (!snap.exists)
        return res.status(404).json({ error: 'Ship-To not found.' })

      // shipToCode is IMMUTABLE — never update
      // soldToId is IMMUTABLE — never update
      const updates = { updatedAt: FieldValue.serverTimestamp() }

      if (shipToName !== undefined) {
        if (!shipToName.trim())
          return res.status(400).json({ error: 'Ship-To Name cannot be empty.' })
        updates.shipToName = shipToName.trim()
      }
      if (address  !== undefined) updates.address  = address.trim()
      if (city     !== undefined) updates.city     = city.trim()
      if (province !== undefined) updates.province = province.trim()
      if (island   !== undefined) updates.island   = island.trim()

      await ref.update(updates)
      return res.json({ success: true })
    } catch (err) {
      console.error('[updateShipTo]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

// ============================================================
// activateShipTo
// ============================================================
exports.activateShipTo = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { id } = req.body || {}
      if (!id)
        return res.status(400).json({ error: 'ID is required.' })

      const ref  = db.collection('customerShipTos').doc(id)
      const snap = await ref.get()
      if (!snap.exists)
        return res.status(404).json({ error: 'Ship-To not found.' })

      // Check parent Sold-To is active before activating Ship-To
      const data = snap.data()
      const soldToSnap = await db.collection('customers').doc(data.soldToId).get()
      if (soldToSnap.exists && !soldToSnap.data().active)
        return res.status(400).json({ error: 'Cannot activate Ship-To: Parent Sold-To is inactive.' })

      await ref.update({ active: true, updatedAt: FieldValue.serverTimestamp() })
      return res.json({ success: true })
    } catch (err) {
      console.error('[activateShipTo]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

// ============================================================
// deactivateShipTo
// ============================================================
exports.deactivateShipTo = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { id } = req.body || {}
      if (!id)
        return res.status(400).json({ error: 'ID is required.' })

      const ref  = db.collection('customerShipTos').doc(id)
      const snap = await ref.get()
      if (!snap.exists)
        return res.status(404).json({ error: 'Ship-To not found.' })

      await ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() })
      return res.json({ success: true })
    } catch (err) {
      console.error('[deactivateShipTo]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
// ============================================================
// getShipTosByCustomer
// GET ?customer_code=<code>
// Returns active Ship-Tos belonging to the given customer_code
// sorted by shipToName ASC
// ============================================================
exports.getShipTosByCustomer = onRequest(run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    const { customer_code } = req.query
    if (!customer_code?.trim())
      return res.status(400).json({ error: 'customer_code is required' })
    try {
      const snap = await db.collection('customerShipTos')
        .where('soldToCode', '==', customer_code.trim().toUpperCase())
        .where('active', '==', true)
        .orderBy('shipToName')
        .get()
      const shipTos = snap.docs.map(d => ({
        shipto_code : d.data().shipToCode,
        shipto_name : d.data().shipToName,
        address     : d.data().address || ''
      }))
      return res.status(200).json({ shipTos })
    } catch (err) {
      console.error('[shipTo] getShipTosByCustomer:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
