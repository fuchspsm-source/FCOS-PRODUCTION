'use strict'

const { onRequest }                               = require('firebase-functions/v2/https')
const { db, admin }                               = require('./db')
const { requireAuth, requireActive, requireRole } = require('./middleware')

const FieldValue = admin.firestore.FieldValue

// -- POST /seedApprovalMatrix
// Idempotent. Creates approval_matrix_versions/v1 if not exists.
// SUPER_ADMIN only.

exports.seedApprovalMatrix = onRequest({ region: 'us-central1' }, async (req, res) => {
  await requireAuth(req, res, async () => {
  await requireActive(req, res, async () => {
  await requireRole('SUPER_ADMIN')(req, res, async () => {

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    try {
      const ref  = db.collection('approval_matrix_versions').doc('v1')
      const snap = await ref.get()

      if (snap.exists) {
        return res.status(200).json({ ok: true, status: 'skipped', reason: 'v1 already exists' })
      }

      await ref.set({
        version_name : 'Default Matrix v1',
        is_active    : true,
        created_at   : FieldValue.serverTimestamp(),
        created_by   : req.user.uid,
      })

      return res.status(201).json({ ok: true, status: 'created', id: 'v1' })

    } catch (err) {
      console.error('[approvalMatrix] seedApprovalMatrix error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }

  })})})
})

// -- POST /seedApprovalMatrixRules
// Idempotent. Seeds 5 frozen band documents into approval_matrix
// for version v1. Hard fails if v1 does not exist or is inactive.
// SUPER_ADMIN only.

const FROZEN_BANDS = [
  { min_nc_value: null, max_nc_value: 20,   required_authority_rank: 5 },
  { min_nc_value: 20,   max_nc_value: 25,   required_authority_rank: 4 },
  { min_nc_value: 25,   max_nc_value: 30,   required_authority_rank: 3 },
  { min_nc_value: 30,   max_nc_value: 40,   required_authority_rank: 2 },
  { min_nc_value: 40,   max_nc_value: null, required_authority_rank: 1 },
]

exports.seedApprovalMatrixRules = onRequest({ region: 'us-central1' }, async (req, res) => {
  await requireAuth(req, res, async () => {
  await requireActive(req, res, async () => {
  await requireRole('SUPER_ADMIN')(req, res, async () => {

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    try {
      const versionRef  = db.collection('approval_matrix_versions').doc('v1')
      const versionSnap = await versionRef.get()

      if (!versionSnap.exists) {
        return res.status(400).json({ error: 'approval_matrix_versions/v1 does not exist. Run seedApprovalMatrix first.' })
      }
      if (versionSnap.data().is_active !== true) {
        return res.status(400).json({ error: 'approval_matrix_versions/v1 is not active.' })
      }

      const existing = await db.collection('approval_matrix')
        .where('matrix_version_id', '==', 'v1')
        .limit(1)
        .get()

      if (!existing.empty) {
        return res.status(200).json({ ok: true, status: 'skipped', reason: 'rules for v1 already exist' })
      }

      const now     = FieldValue.serverTimestamp()
      const results = []

      for (const band of FROZEN_BANDS) {
        const ref = db.collection('approval_matrix').doc()
        await ref.set({
          matrix_version_id      : 'v1',
          min_nc_value           : band.min_nc_value,
          max_nc_value           : band.max_nc_value,
          required_authority_rank: band.required_authority_rank,
          created_at             : now,
          updated_at             : now,
        })
        results.push({ id: ref.id, required_authority_rank: band.required_authority_rank })
      }

      return res.status(201).json({ ok: true, status: 'created', count: results.length, results })

    } catch (err) {
      console.error('[approvalMatrix] seedApprovalMatrixRules error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }

  })})})
})
