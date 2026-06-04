'use strict'

const { onRequest }  = require('firebase-functions/v2/https')
const { db, admin }  = require('./db')
const { requireAuth, requireActive, requireRole } = require('./middleware')
const { writeAudit } = require('./audit')
const { PRODUCT_STATUS, MAPPING_SOURCE, AUDIT } = require('./constants')

const FieldValue = admin.firestore.FieldValue

// ─── run helper (same pattern as users.js) ───────────────
function run(middlewares, handler) {
  return onRequest(async (req, res) => {
    let idx = 0
    const next = async () => {
      const mw = middlewares[idx++]
      if (mw) {
        const r = mw(req, res, next)
        if (r && typeof r.then === 'function') await r
      } else {
        await handler(req, res)
      }
    }
    await next()
  })
}

// ─── ID generators ───────────────────────────────────────
// Sequences stored in collection `_sequences` doc `products` / `families` / `mappings`
async function nextId(seqName, prefix, padLen) {
  const ref = db.collection('_sequences').doc(seqName)
  const id  = await db.runTransaction(async tx => {
    const snap = await tx.get(ref)
    const next = snap.exists ? (snap.data().current + 1) : 1
    tx.set(ref, { current: next })
    return next
  })
  return prefix + String(id).padStart(padLen, '0')
}

// ═══════════════════════════════════════════════════════════
// PRODUCT REGISTRY
// ═══════════════════════════════════════════════════════════

// GET  listProducts   ?status=ACTIVE|INACTIVE
exports.listProducts = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN', 'PRICING')],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    try {
      const { status } = req.query
      let q = db.collection('product_registry').orderBy('created_at', 'desc')
      if (status) {
        if (!Object.values(PRODUCT_STATUS).includes(status))
          return res.status(400).json({ error: `Invalid status: ${status}` })
        q = q.where('status', '==', status)
      }
      const snap = await q.get()
      return res.status(200).json({ products: snap.docs.map(d => ({ product_id: d.id, ...d.data() })) })
    } catch (err) {
      console.error('[products] listProducts:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// GET  getProduct     ?product_id=PRD-000001
exports.getProduct = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN', 'PRICING')],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    const { product_id } = req.query
    if (!product_id) return res.status(400).json({ error: 'product_id is required' })
    try {
      const snap = await db.collection('product_registry').doc(product_id).get()
      if (!snap.exists) return res.status(404).json({ error: 'Product not found' })
      return res.status(200).json({ product_id: snap.id, ...snap.data() })
    } catch (err) {
      console.error('[products] getProduct:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// POST createProduct  { product_code, product_name, sku }
exports.createProduct = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { product_code, product_name, sku } = req.body
    if (!product_code || !product_name)
      return res.status(400).json({ error: 'product_code and product_name are required' })
    try {
      // Uniqueness check on product_code
      const dup = await db.collection('product_registry')
        .where('product_code', '==', product_code).limit(1).get()
      if (!dup.empty) return res.status(409).json({ error: 'product_code already exists' })

      const product_id = await nextId('products', 'PRD-', 6)
      await db.collection('product_registry').doc(product_id).set({
        product_id,
        product_code,
        product_name,
        product_name_lower : product_name.toLowerCase().trim(),
        sku         : sku || null,
        status      : PRODUCT_STATUS.ACTIVE,
        created_at  : FieldValue.serverTimestamp(),
        updated_at  : FieldValue.serverTimestamp(),
        created_by  : req.user.uid,
        updated_by  : req.user.uid
      })
      await writeAudit(AUDIT.PRODUCT_CREATED, req.user.uid, product_id, { product_code, product_name })
      return res.status(201).json({ ok: true, product_id })
    } catch (err) {
      console.error('[products] createProduct:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// POST updateProduct  { product_id, product_code, product_name, sku }
exports.updateProduct = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { product_id, product_code, product_name, sku } = req.body
    if (!product_id) return res.status(400).json({ error: 'product_id is required' })
    if (!product_code || !product_name)
      return res.status(400).json({ error: 'product_code and product_name are required' })
    try {
      const snap = await db.collection('product_registry').doc(product_id).get()
      if (!snap.exists) return res.status(404).json({ error: 'Product not found' })

      // Uniqueness check — exclude self
      const dup = await db.collection('product_registry')
        .where('product_code', '==', product_code).limit(2).get()
      const conflict = dup.docs.find(d => d.id !== product_id)
      if (conflict) return res.status(409).json({ error: 'product_code already used by another product' })

      await db.collection('product_registry').doc(product_id).update({
        product_code,
        product_name,
        product_name_lower : product_name.toLowerCase().trim(),
        sku        : sku || null,
        updated_at : FieldValue.serverTimestamp(),
        updated_by : req.user.uid
      })
      await writeAudit(AUDIT.PRODUCT_UPDATED, req.user.uid, product_id, { product_code, product_name })
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[products] updateProduct:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// POST deactivateProduct  { product_id }
exports.deactivateProduct = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { product_id } = req.body
    if (!product_id) return res.status(400).json({ error: 'product_id is required' })
    try {
      const snap = await db.collection('product_registry').doc(product_id).get()
      if (!snap.exists) return res.status(404).json({ error: 'Product not found' })
      if (snap.data().status === PRODUCT_STATUS.INACTIVE)
        return res.status(400).json({ error: 'Product is already INACTIVE' })
      await db.collection('product_registry').doc(product_id).update({
        status     : PRODUCT_STATUS.INACTIVE,
        updated_at : FieldValue.serverTimestamp(),
        updated_by : req.user.uid
      })
      await writeAudit(AUDIT.PRODUCT_DEACTIVATED, req.user.uid, product_id, {})
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[products] deactivateProduct:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// POST reactivateProduct  { product_id }
exports.reactivateProduct = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { product_id } = req.body
    if (!product_id) return res.status(400).json({ error: 'product_id is required' })
    try {
      const snap = await db.collection('product_registry').doc(product_id).get()
      if (!snap.exists) return res.status(404).json({ error: 'Product not found' })
      if (snap.data().status !== PRODUCT_STATUS.INACTIVE)
        return res.status(400).json({ error: 'Product is not INACTIVE' })
      await db.collection('product_registry').doc(product_id).update({
        status     : PRODUCT_STATUS.ACTIVE,
        updated_at : FieldValue.serverTimestamp(),
        updated_by : req.user.uid
      })
      await writeAudit(AUDIT.PRODUCT_REACTIVATED, req.user.uid, product_id, {})
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[products] reactivateProduct:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// ═══════════════════════════════════════════════════════════
// PRODUCT FAMILY REGISTRY
// ═══════════════════════════════════════════════════════════

// GET  listFamilies   ?status=
exports.listFamilies = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN', 'PRICING')],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    try {
      const { status } = req.query
      let q = db.collection('product_family_registry').orderBy('created_at', 'desc')
      if (status) {
        if (!Object.values(PRODUCT_STATUS).includes(status))
          return res.status(400).json({ error: `Invalid status: ${status}` })
        q = q.where('status', '==', status)
      }
      const snap = await q.get()
      return res.status(200).json({ families: snap.docs.map(d => ({ family_id: d.id, ...d.data() })) })
    } catch (err) {
      console.error('[products] listFamilies:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// POST createFamily   { family_name }
exports.createFamily = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { family_name } = req.body
    if (!family_name) return res.status(400).json({ error: 'family_name is required' })
    try {
      // Uniqueness check (case-insensitive via lowercase field)
      const dup = await db.collection('product_family_registry')
        .where('family_name_lower', '==', family_name.toLowerCase()).limit(1).get()
      if (!dup.empty) return res.status(409).json({ error: 'family_name already exists' })

      const family_id = await nextId('families', 'FAM-', 6)
      await db.collection('product_family_registry').doc(family_id).set({
        family_name,
        family_name_lower : family_name.toLowerCase(),
        status            : PRODUCT_STATUS.ACTIVE,
        created_at        : FieldValue.serverTimestamp(),
        updated_at        : FieldValue.serverTimestamp(),
        created_by        : req.user.uid,
        updated_by        : req.user.uid
      })
      await writeAudit(AUDIT.FAMILY_CREATED, req.user.uid, family_id, { family_name })
      return res.status(201).json({ ok: true, family_id })
    } catch (err) {
      console.error('[products] createFamily:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// POST updateFamily   { family_id, family_name }
exports.updateFamily = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { family_id, family_name } = req.body
    if (!family_id || !family_name)
      return res.status(400).json({ error: 'family_id and family_name are required' })
    try {
      const snap = await db.collection('product_family_registry').doc(family_id).get()
      if (!snap.exists) return res.status(404).json({ error: 'Family not found' })

      const dup = await db.collection('product_family_registry')
        .where('family_name_lower', '==', family_name.toLowerCase()).limit(2).get()
      const conflict = dup.docs.find(d => d.id !== family_id)
      if (conflict) return res.status(409).json({ error: 'family_name already used' })

      await db.collection('product_family_registry').doc(family_id).update({
        family_name,
        family_name_lower : family_name.toLowerCase(),
        updated_at        : FieldValue.serverTimestamp(),
        updated_by        : req.user.uid
      })
      await writeAudit(AUDIT.FAMILY_UPDATED, req.user.uid, family_id, { family_name })
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[products] updateFamily:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// POST deactivateFamily  { family_id }
exports.deactivateFamily = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { family_id } = req.body
    if (!family_id) return res.status(400).json({ error: 'family_id is required' })
    try {
      const snap = await db.collection('product_family_registry').doc(family_id).get()
      if (!snap.exists) return res.status(404).json({ error: 'Family not found' })
      if (snap.data().status === PRODUCT_STATUS.INACTIVE)
        return res.status(400).json({ error: 'Family is already INACTIVE' })
      const mappedSnap = await db.collection('product_family_mapping')
        .where('family_id', '==', family_id).limit(1).get()
      if (!mappedSnap.empty)
        return res.status(400).json({ error: 'Cannot deactivate family with active product mappings' })
      await db.collection('product_family_registry').doc(family_id).update({
        status     : PRODUCT_STATUS.INACTIVE,
        updated_at : FieldValue.serverTimestamp(),
        updated_by : req.user.uid
      })
      await writeAudit(AUDIT.FAMILY_DEACTIVATED, req.user.uid, family_id, {})
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[products] deactivateFamily:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// POST reactivateFamily  { family_id }
exports.reactivateFamily = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { family_id } = req.body
    if (!family_id) return res.status(400).json({ error: 'family_id is required' })
    try {
      const snap = await db.collection('product_family_registry').doc(family_id).get()
      if (!snap.exists) return res.status(404).json({ error: 'Family not found' })
      if (snap.data().status !== PRODUCT_STATUS.INACTIVE)
        return res.status(400).json({ error: 'Family is not INACTIVE' })
      await db.collection('product_family_registry').doc(family_id).update({
        status     : PRODUCT_STATUS.ACTIVE,
        updated_at : FieldValue.serverTimestamp(),
        updated_by : req.user.uid
      })
      await writeAudit(AUDIT.FAMILY_REACTIVATED, req.user.uid, family_id, {})
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[products] reactivateFamily:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// ═══════════════════════════════════════════════════════════
// PRODUCT FAMILY MAPPING
// ═══════════════════════════════════════════════════════════

// GET  listMappings   ?family_id=  ?product_id=
exports.listMappings = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN', 'PRICING')],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    try {
      const { family_id, product_id } = req.query
      let q = db.collection('product_family_mapping').orderBy('created_at', 'desc')
      if (family_id)  q = q.where('family_id',  '==', family_id)
      if (product_id) q = q.where('product_id', '==', product_id)
      const snap = await q.get()
      return res.status(200).json({ mappings: snap.docs.map(d => ({ mapping_id: d.id, ...d.data() })) })
    } catch (err) {
      console.error('[products] listMappings:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// POST assignFamily   { product_id, family_id }
// One product → one family. Replaces existing mapping for that product.
exports.assignFamily = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { product_id, family_id } = req.body
    if (!product_id || !family_id)
      return res.status(400).json({ error: 'product_id and family_id are required' })
    try {
      // Validate both exist
      const [pSnap, fSnap] = await Promise.all([
        db.collection('product_registry').doc(product_id).get(),
        db.collection('product_family_registry').doc(family_id).get()
      ])
      if (!pSnap.exists) return res.status(404).json({ error: 'Product not found' })
      if (!fSnap.exists) return res.status(404).json({ error: 'Family not found' })

      // Remove existing mapping for this product (if any)
      const existing = await db.collection('product_family_mapping')
        .where('product_id', '==', product_id).limit(1).get()
      const batch = db.batch()
      existing.docs.forEach(d => batch.delete(d.ref))

      // Create new mapping
      const mapping_id = await nextId('mappings', 'MAP-', 6)
      const mapRef = db.collection('product_family_mapping').doc(mapping_id)
      batch.set(mapRef, {
        product_id,
        family_id,
        confidence     : 100,
        mapping_source : MAPPING_SOURCE.MANUAL,
        approved_by    : req.user.uid,
        approved_at    : FieldValue.serverTimestamp(),
        created_at     : FieldValue.serverTimestamp(),
        updated_at     : FieldValue.serverTimestamp()
      })
      await batch.commit()
      await writeAudit(AUDIT.MAPPING_CREATED, req.user.uid, mapping_id, { product_id, family_id })
      return res.status(201).json({ ok: true, mapping_id })
    } catch (err) {
      console.error('[products] assignFamily:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)

// POST removeMapping  { product_id }
exports.removeMapping = run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const { product_id } = req.body
    if (!product_id) return res.status(400).json({ error: 'product_id is required' })
    try {
      const snap = await db.collection('product_family_mapping')
        .where('product_id', '==', product_id).limit(1).get()
      if (snap.empty) return res.status(404).json({ error: 'No mapping found for this product' })
      const mapping_id = snap.docs[0].id
      await db.collection('product_family_mapping').doc(mapping_id).delete()
      await writeAudit(AUDIT.MAPPING_REMOVED, req.user.uid, mapping_id, { product_id })
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[products] removeMapping:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
)
