'use strict'

const { onRequest }                               = require('firebase-functions/v2/https')
const { db, admin }                               = require('./db')
const { requireAuth, requireActive, requireRole } = require('./middleware')

const FieldValue = admin.firestore.FieldValue

const POSITION_SEED = [
  { id: 'AREA_MANAGER',      label: 'Area Manager',       authority_rank: 1 },
  { id: 'REGIONAL_MANAGER',  label: 'Regional Manager',   authority_rank: 2 },
  { id: 'DIVISION_MANAGER',  label: 'Division Manager',   authority_rank: 3 },
  { id: 'SALES_DIRECTOR',    label: 'Sales Director',     authority_rank: 4 },
  { id: 'MANAGING_DIRECTOR', label: 'Managing Director',  authority_rank: 5 },
]

exports.seedPositions = onRequest({ region: 'us-central1' }, async (req, res) => {
  await requireAuth(req, res, async () => {
  await requireActive(req, res, async () => {
  await requireRole('SUPER_ADMIN')(req, res, async () => {

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' })
    }

    try {
      const now     = FieldValue.serverTimestamp()
      const results = []

      for (const pos of POSITION_SEED) {
        const ref  = db.collection('positions').doc(pos.id)
        const snap = await ref.get()

        if (snap.exists) {
          await ref.update({
            label          : pos.label,
            authority_rank : pos.authority_rank,
            is_active      : true,
            updated_at     : now,
          })
          results.push({ id: pos.id, status: 'updated' })
        } else {
          await ref.set({
            label          : pos.label,
            authority_rank : pos.authority_rank,
            is_active      : true,
            created_at     : now,
            updated_at     : now,
          })
          results.push({ id: pos.id, status: 'created' })
        }
      }

      return res.status(200).json({ ok: true, results })

    } catch (err) {
      console.error('[positions] seedPositions error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }

  })})})
})
