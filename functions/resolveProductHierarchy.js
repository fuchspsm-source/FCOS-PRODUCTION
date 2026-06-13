'use strict'
const { db, admin } = require('./db')
const FieldValue = admin.firestore.FieldValue

/**
 * Resolve (lookup-or-create) Brand → Family → Master SKU hierarchy.
 * Uses an in-memory cache to handle repeated values within the same
 * import job (Firestore writes via batch are not visible to .get()
 * until the batch is committed).
 *
 * @param {string} brand - Brand name (= code, uppercase)
 * @param {string} family - Family name (= code, uppercase)
 * @param {string} masterSku - Master SKU / Genus name (= code, uppercase)
 * @param {Object} cache - { ordos: {}, families: {}, genus: {} } - mutated in place
 * @param {FirebaseFirestore.WriteBatch} batch
 * @param {string} userId
 * @returns {Promise<{ordoId: string|null, familyId: string|null, genusId: string|null}>}
 */
async function resolveProductHierarchy(brand, family, masterSku, cache, batch, userId) {
  const brandTrim  = (brand || '').trim()
  const familyTrim = (family || '').trim()
  const genusTrim  = (masterSku || '').trim()

  let ordoId = null, familyId = null, genusId = null
  const now = FieldValue.serverTimestamp()

  // 1. Brand -> productOrdos
  if (brandTrim) {
    const code = brandTrim.toUpperCase()
    if (cache.ordos[code]) {
      ordoId = cache.ordos[code]
    } else {
      const snap = await db.collection('productOrdos').where('code', '==', code).limit(1).get()
      if (!snap.empty) {
        ordoId = snap.docs[0].id
      } else {
        const ref = db.collection('productOrdos').doc()
        batch.set(ref, { code, name: brandTrim, active: true, createdAt: now, updatedAt: now })
        ordoId = ref.id
      }
      cache.ordos[code] = ordoId
    }
  }

  // 2. Family -> productFamilies (scoped under ordoId)
  if (ordoId && familyTrim) {
    const code = familyTrim.toUpperCase()
    const cacheKey = ordoId + '|' + code
    if (cache.families[cacheKey]) {
      familyId = cache.families[cacheKey]
    } else {
      const snap = await db.collection('productFamilies')
        .where('ordoId', '==', ordoId)
        .where('code', '==', code)
        .limit(1).get()
      if (!snap.empty) {
        familyId = snap.docs[0].id
      } else {
        const ref = db.collection('productFamilies').doc()
        batch.set(ref, { ordoId, code, name: familyTrim, active: true, createdAt: now, updatedAt: now })
        familyId = ref.id
      }
      cache.families[cacheKey] = familyId
    }
  }

  // 3. Master SKU -> productGenus (scoped under familyId)
  if (familyId && genusTrim) {
    const code = genusTrim.toUpperCase()
    const cacheKey = familyId + '|' + code
    if (cache.genus[cacheKey]) {
      genusId = cache.genus[cacheKey]
    } else {
      const snap = await db.collection('productGenus')
        .where('familyId', '==', familyId)
        .where('code', '==', code)
        .limit(1).get()
      if (!snap.empty) {
        genusId = snap.docs[0].id
      } else {
        const ref = db.collection('productGenus').doc()
        batch.set(ref, { familyId, code, name: genusTrim, active: true, createdAt: now, updatedAt: now })
        genusId = ref.id
      }
      cache.genus[cacheKey] = genusId
    }
  }

  return { ordoId, familyId, genusId }
}

module.exports = { resolveProductHierarchy }
