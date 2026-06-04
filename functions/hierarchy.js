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
// ORDO (Brand)
// ============================================================

exports.listOrdos = onRequest(run(
  [requireAuth, requireActive],
  async (req, res) => {
    try {
      const { activeOnly, search } = req.query
      let query = db.collection('productOrdos').orderBy('code')
      if (activeOnly === 'true') query = query.where('active', '==', true)
      const snap = await query.get()
      let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      if (search) {
        const s = search.toLowerCase()
        docs = docs.filter(d =>
          d.code?.toLowerCase().includes(s) ||
          d.name?.toLowerCase().includes(s)
        )
      }
      return res.json({ ordos: docs })
    } catch (err) {
      console.error('[listOrdos]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

exports.createOrdo = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { code, name } = req.body || {}
      if (!code?.trim()) return res.status(400).json({ error: 'Brand Code is required.' })
      if (!name?.trim()) return res.status(400).json({ error: 'Brand Name is required.' })

      const existing = await db.collection('productOrdos')
        .where('code', '==', code.trim().toUpperCase()).get()
      if (!existing.empty) return res.status(409).json({ error: 'Brand Code already exists.' })

      const now = FieldValue.serverTimestamp()
      const ref = await db.collection('productOrdos').add({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      return res.json({ id: ref.id })
    } catch (err) {
      console.error('[createOrdo]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

exports.updateOrdo = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { id, name, active } = req.body || {}
      if (!id) return res.status(400).json({ error: 'ID is required.' })

      const ref = db.collection('productOrdos').doc(id)
      const snap = await ref.get()
      if (!snap.exists) return res.status(404).json({ error: 'Brand not found.' })

      const updates = { updatedAt: FieldValue.serverTimestamp() }
      if (name !== undefined) {
        if (!name.trim()) return res.status(400).json({ error: 'Brand Name cannot be empty.' })
        updates.name = name.trim()
      }
      if (active !== undefined) updates.active = active

      await ref.update(updates)
      return res.json({ success: true })
    } catch (err) {
      console.error('[updateOrdo]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

exports.deleteOrdo = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { id } = req.body || {}
      if (!id) return res.status(400).json({ error: 'ID is required.' })

      const children = await db.collection('productFamilies')
        .where('ordoId', '==', id).limit(1).get()
      if (!children.empty) return res.status(409).json({ error: 'Cannot delete Brand: Families exist under this Brand.' })

      await db.collection('productOrdos').doc(id).delete()
      return res.json({ success: true })
    } catch (err) {
      console.error('[deleteOrdo]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

// ============================================================
// FAMILY
// ============================================================

exports.listFamilies3C = onRequest(run(
  [requireAuth, requireActive],
  async (req, res) => {
    try {
      const { ordoId, activeOnly, search } = req.query
      let query = db.collection('productFamilies').orderBy('code')
      if (ordoId) query = query.where('ordoId', '==', ordoId)
      if (activeOnly === 'true') query = query.where('active', '==', true)
      const snap = await query.get()
      let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      if (search) {
        const s = search.toLowerCase()
        docs = docs.filter(d =>
          d.code?.toLowerCase().includes(s) ||
          d.name?.toLowerCase().includes(s)
        )
      }
      return res.json({ families: docs })
    } catch (err) {
      console.error('[listFamilies3C]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

exports.createFamily3C = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { ordoId, code, name } = req.body || {}
      if (!ordoId) return res.status(400).json({ error: 'Brand (Ordo) is required.' })
      if (!code?.trim()) return res.status(400).json({ error: 'Family Code is required.' })
      if (!name?.trim()) return res.status(400).json({ error: 'Family Name is required.' })

      const ordoSnap = await db.collection('productOrdos').doc(ordoId).get()
      if (!ordoSnap.exists) return res.status(404).json({ error: 'Brand not found.' })

      const existing = await db.collection('productFamilies')
        .where('ordoId', '==', ordoId)
        .where('code', '==', code.trim().toUpperCase()).get()
      if (!existing.empty) return res.status(409).json({ error: 'Family Code already exists under this Brand.' })

      const now = FieldValue.serverTimestamp()
      const ref = await db.collection('productFamilies').add({
        ordoId,
        code: code.trim().toUpperCase(),
        name: name.trim(),
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      return res.json({ id: ref.id })
    } catch (err) {
      console.error('[createFamily3C]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

exports.updateFamily3C = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { id, name, active } = req.body || {}
      if (!id) return res.status(400).json({ error: 'ID is required.' })

      const ref = db.collection('productFamilies').doc(id)
      const snap = await ref.get()
      if (!snap.exists) return res.status(404).json({ error: 'Family not found.' })

      const updates = { updatedAt: FieldValue.serverTimestamp() }
      if (name !== undefined) {
        if (!name.trim()) return res.status(400).json({ error: 'Family Name cannot be empty.' })
        updates.name = name.trim()
      }
      if (active !== undefined) updates.active = active

      await ref.update(updates)
      return res.json({ success: true })
    } catch (err) {
      console.error('[updateFamily3C]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

exports.deleteFamily3C = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { id } = req.body || {}
      if (!id) return res.status(400).json({ error: 'ID is required.' })

      const children = await db.collection('productGenus')
        .where('familyId', '==', id).limit(1).get()
      if (!children.empty) return res.status(409).json({ error: 'Cannot delete Family: Genus records exist under this Family.' })

      await db.collection('productFamilies').doc(id).delete()
      return res.json({ success: true })
    } catch (err) {
      console.error('[deleteFamily3C]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

// ============================================================
// GENUS (Master SKU)
// ============================================================

exports.listGenus = onRequest(run(
  [requireAuth, requireActive],
  async (req, res) => {
    try {
      const { familyId, activeOnly, search } = req.query
      let query = db.collection('productGenus').orderBy('code')
      if (familyId) query = query.where('familyId', '==', familyId)
      if (activeOnly === 'true') query = query.where('active', '==', true)
      const snap = await query.get()
      let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      if (search) {
        const s = search.toLowerCase()
        docs = docs.filter(d =>
          d.code?.toLowerCase().includes(s) ||
          d.name?.toLowerCase().includes(s)
        )
      }
      return res.json({ genus: docs })
    } catch (err) {
      console.error('[listGenus]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

exports.createGenus = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { familyId, code, name } = req.body || {}
      if (!familyId) return res.status(400).json({ error: 'Family is required.' })
      if (!code?.trim()) return res.status(400).json({ error: 'Genus Code is required.' })
      if (!name?.trim()) return res.status(400).json({ error: 'Genus Name is required.' })

      const familySnap = await db.collection('productFamilies').doc(familyId).get()
      if (!familySnap.exists) return res.status(404).json({ error: 'Family not found.' })

      const existing = await db.collection('productGenus')
        .where('familyId', '==', familyId)
        .where('code', '==', code.trim().toUpperCase()).get()
      if (!existing.empty) return res.status(409).json({ error: 'Genus Code already exists under this Family.' })

      const now = FieldValue.serverTimestamp()
      const ref = await db.collection('productGenus').add({
        familyId,
        code: code.trim().toUpperCase(),
        name: name.trim(),
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      return res.json({ id: ref.id })
    } catch (err) {
      console.error('[createGenus]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

exports.updateGenus = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { id, name, active } = req.body || {}
      if (!id) return res.status(400).json({ error: 'ID is required.' })

      const ref = db.collection('productGenus').doc(id)
      const snap = await ref.get()
      if (!snap.exists) return res.status(404).json({ error: 'Genus not found.' })

      const updates = { updatedAt: FieldValue.serverTimestamp() }
      if (name !== undefined) {
        if (!name.trim()) return res.status(400).json({ error: 'Genus Name cannot be empty.' })
        updates.name = name.trim()
      }
      if (active !== undefined) updates.active = active

      await ref.update(updates)
      return res.json({ success: true })
    } catch (err) {
      console.error('[updateGenus]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

exports.deleteGenus = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { id } = req.body || {}
      if (!id) return res.status(400).json({ error: 'ID is required.' })

      const children = await db.collection('productCodes')
        .where('genusId', '==', id).limit(1).get()
      if (!children.empty) return res.status(409).json({ error: 'Cannot delete Genus: Product Codes exist under this Genus.' })

      await db.collection('productGenus').doc(id).delete()
      return res.json({ success: true })
    } catch (err) {
      console.error('[deleteGenus]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

// ============================================================
// PRODUCT CODES
// ============================================================

exports.listProductCodes = onRequest(run(
  [requireAuth, requireActive],
  async (req, res) => {
    try {
      const { genusId, activeOnly, search } = req.query
      let query = db.collection('productCodes').orderBy('productCode')
      if (genusId) query = query.where('genusId', '==', genusId)
      if (activeOnly === 'true') query = query.where('active', '==', true)
      const snap = await query.get()
      let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      if (search) {
        const s = search.toLowerCase()
        docs = docs.filter(d =>
          d.productCode?.toLowerCase().includes(s) ||
          d.description?.toLowerCase().includes(s)
        )
      }
      return res.json({ productCodes: docs })
    } catch (err) {
      console.error('[listProductCodes]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

exports.createProductCode = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { genusId, productCode, description } = req.body || {}
      if (!genusId) return res.status(400).json({ error: 'Master SKU (Genus) is required.' })
      if (!productCode?.trim()) return res.status(400).json({ error: 'Product Code is required.' })

      const genusSnap = await db.collection('productGenus').doc(genusId).get()
      if (!genusSnap.exists) return res.status(404).json({ error: 'Master SKU not found.' })

      const existing = await db.collection('productCodes')
        .where('productCode', '==', productCode.trim().toUpperCase()).get()
      if (!existing.empty) return res.status(409).json({ error: 'Product Code already exists.' })

      const now = FieldValue.serverTimestamp()
      const ref = await db.collection('productCodes').add({
        genusId,
        productCode: productCode.trim().toUpperCase(),
        description: description ? description.trim() : '',
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      return res.json({ id: ref.id })
    } catch (err) {
      console.error('[createProductCode]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

exports.updateProductCode = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { id, description, active } = req.body || {}
      if (!id) return res.status(400).json({ error: 'ID is required.' })

      const ref = db.collection('productCodes').doc(id)
      const snap = await ref.get()
      if (!snap.exists) return res.status(404).json({ error: 'Product Code not found.' })

      const updates = { updatedAt: FieldValue.serverTimestamp() }
      if (description !== undefined) updates.description = description.trim()
      if (active !== undefined) updates.active = active

      await ref.update(updates)
      return res.json({ success: true })
    } catch (err) {
      console.error('[updateProductCode]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))

exports.deleteProductCode = onRequest(run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    try {
      const { id } = req.body || {}
      if (!id) return res.status(400).json({ error: 'ID is required.' })
      await db.collection('productCodes').doc(id).delete()
      return res.json({ success: true })
    } catch (err) {
      console.error('[deleteProductCode]', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))