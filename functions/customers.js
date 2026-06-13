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
  // listCustomers
  // ============================================================
  exports.listCustomers = onRequest(run(
    [requireAuth, requireActive],
    async (req, res) => {
      try {
        const { activeOnly, search } = req.query
        let query = db.collection('customers').orderBy('customerCode')
        if (activeOnly === 'true') query = query.where('active', '==', true)
        const snap = await query.get()
        let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        if (search) {
          const s = search.toLowerCase()
          docs = docs.filter(d =>
            d.customerCode?.toLowerCase().includes(s) ||
            d.customerName?.toLowerCase().includes(s)
          )
        }
        return res.json({ customers: docs })
      } catch (err) {
        console.error('[listCustomers]', err)
        return res.status(500).json({ error: 'Internal error' })
      }
    }
  ))

  // ============================================================
  // createCustomer
  // ============================================================
  exports.createCustomer = onRequest(run(
    [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
    async (req, res) => {
      try {
        const { customerCode, customerName, customerType, parentCustomerId,
                address, city, province, island } = req.body || {}

        if (!customerCode?.trim())
          return res.status(400).json({ error: 'Customer Code is required.' })
        if (!customerName?.trim())
          return res.status(400).json({ error: 'Customer Name is required.' })

        const type = customerType || 'SOLD_TO'
        if (!['SOLD_TO', 'SHIP_TO'].includes(type))
          return res.status(400).json({ error: 'Customer Type must be SOLD_TO or SHIP_TO.' })

        if (type === 'SOLD_TO' && parentCustomerId)
          return res.status(400).json({ error: 'SOLD_TO customer must not have a parent.' })

        if (type === 'SHIP_TO' && !parentCustomerId)
          return res.status(400).json({ error: 'SHIP_TO customer requires a Parent Customer.' })

        // Validate parent + fetch parentCustomerCode
        let parentCustomerCode = null
        if (type === 'SHIP_TO') {
          const parentSnap = await db.collection('customers').doc(parentCustomerId).get()
          if (!parentSnap.exists)
            return res.status(404).json({ error: 'Parent Customer not found.' })
          const parentData = parentSnap.data()
          if (parentData.customerType === 'SHIP_TO')
            return res.status(400).json({ error: 'SHIP_TO cannot reference another SHIP_TO as parent.' })
          parentCustomerCode = parentData.customerCode
        }

        // Uniqueness check
        const existing = await db.collection('customers')
          .where('customerCode', '==', customerCode.trim().toUpperCase())
          .get()
        if (!existing.empty)
          return res.status(409).json({ error: 'Customer Code already exists.' })

        const now = FieldValue.serverTimestamp()
        const ref = await db.collection('customers').add({
          customerCode:      customerCode.trim().toUpperCase(),
          customerName:      customerName.trim(),
          customerType:      type,
          parentCustomerId:  type === 'SHIP_TO' ? parentCustomerId    : null,
          parentCustomerCode: type === 'SHIP_TO' ? parentCustomerCode : null,
          address:           address  ? address.trim()  : '',
          city:              city     ? city.trim()     : '',
          province:          province ? province.trim() : '',
          island:            island   ? island.trim()   : '',
          active:            true,
          createdAt:         now,
          updatedAt:         now,
        })
        return res.json({ id: ref.id })
      } catch (err) {
        console.error('[createCustomer]', err)
        return res.status(500).json({ error: 'Internal error' })
      }
    }
  ))

  // ============================================================
  // updateCustomer
  // ============================================================
  exports.updateCustomer = onRequest(run(
    [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
    async (req, res) => {
      try {
        const { id, customerName, customerType, parentCustomerId,
                address, city, province, island } = req.body || {}

        if (!id)
          return res.status(400).json({ error: 'ID is required.' })

        const ref  = db.collection('customers').doc(id)
        const snap = await ref.get()
        if (!snap.exists)
          return res.status(404).json({ error: 'Customer not found.' })

        const current  = snap.data()
        const isSuperAdmin = req.user.roles?.includes('SUPER_ADMIN')
        const updates  = { updatedAt: FieldValue.serverTimestamp() }

        // customerName
        if (customerName !== undefined) {
          if (!customerName.trim())
            return res.status(400).json({ error: 'Customer Name cannot be empty.' })
          updates.customerName = customerName.trim()
        }

        // CR#1: customerType editable by SUPER_ADMIN only
        let effectiveType = current.customerType
        if (customerType !== undefined) {
          if (!isSuperAdmin)
            return res.status(403).json({ error: 'Only SUPER_ADMIN can change Customer Type.' })
          if (!['SOLD_TO', 'SHIP_TO'].includes(customerType))
            return res.status(400).json({ error: 'Customer Type must be SOLD_TO or SHIP_TO.' })
          updates.customerType = customerType
          effectiveType = customerType
        }

        // parentCustomerId + parentCustomerCode
        if (parentCustomerId !== undefined) {
          if (effectiveType === 'SOLD_TO') {
            // Changing to SOLD_TO — clear parent
            updates.parentCustomerId   = null
            updates.parentCustomerCode = null
          } else {
            // SHIP_TO — validate parent
            if (!parentCustomerId)
              return res.status(400).json({ error: 'SHIP_TO customer requires a Parent Customer.' })
            if (parentCustomerId === id)
              return res.status(400).json({ error: 'Customer cannot reference itself as parent.' })
            const parentSnap = await db.collection('customers').doc(parentCustomerId).get()
            if (!parentSnap.exists)
              return res.status(404).json({ error: 'Parent Customer not found.' })
            const parentData = parentSnap.data()
            if (parentData.customerType === 'SHIP_TO')
              return res.status(400).json({ error: 'SHIP_TO cannot reference another SHIP_TO as parent.' })
            updates.parentCustomerId   = parentCustomerId
            updates.parentCustomerCode = parentData.customerCode
          }
        } else if (customerType === 'SOLD_TO' && current.customerType === 'SHIP_TO') {
          // Type changed to SOLD_TO — auto-clear parent
          updates.parentCustomerId   = null
          updates.parentCustomerCode = null
        }

        if (address  !== undefined) updates.address  = address.trim()
        if (city     !== undefined) updates.city     = city.trim()
        if (province !== undefined) updates.province = province.trim()
        if (island   !== undefined) updates.island   = island.trim()

        await ref.update(updates)
        return res.json({ success: true })
      } catch (err) {
        console.error('[updateCustomer]', err)
        return res.status(500).json({ error: 'Internal error' })
      }
    }
  ))

  // ============================================================
  // activateCustomer
  // ============================================================
  exports.activateCustomer = onRequest(run(
    [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
    async (req, res) => {
      try {
        const { id } = req.body || {}
        if (!id) return res.status(400).json({ error: 'ID is required.' })
        const ref  = db.collection('customers').doc(id)
        const snap = await ref.get()
        if (!snap.exists) return res.status(404).json({ error: 'Customer not found.' })
        await ref.update({ active: true, updatedAt: FieldValue.serverTimestamp() })
        return res.json({ success: true })
      } catch (err) {
        console.error('[activateCustomer]', err)
        return res.status(500).json({ error: 'Internal error' })
      }
    }
  ))

  // ============================================================
  // deactivateCustomer
  // ============================================================
  exports.deactivateCustomer = onRequest(run(
    [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
    async (req, res) => {
      try {
        const { id } = req.body || {}
        if (!id)
          return res.status(400).json({ error: 'ID is required.' })

        const ref  = db.collection('customers').doc(id)
        const snap = await ref.get()
        if (!snap.exists)
          return res.status(404).json({ error: 'Customer not found.' })

        // Cascade inactive: deactivate all child Ship-Tos
        const shipTosSnap = await db.collection('customerShipTos')
          .where('soldToId', '==', id)
          .where('active', '==', true)
          .get()

        const now = FieldValue.serverTimestamp()

        // Chunk batch writes (max 500 per batch)
        const CHUNK_SIZE = 400
        const docs = shipTosSnap.docs
        for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
          const batch = db.batch()
          docs.slice(i, i + CHUNK_SIZE).forEach(d => {
            batch.update(d.ref, { active: false, updatedAt: now })
          })
          await batch.commit()
        }

        // Deactivate the Sold-To itself
        await ref.update({ active: false, updatedAt: now })

        return res.json({ success: true, cascadedShipTos: docs.length })
      } catch (err) {
        console.error('[deactivateCustomer]', err)
        return res.status(500).json({ error: 'Internal error' })
      }
    }
  ))