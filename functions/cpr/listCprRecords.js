'use strict'

const { onRequest }                  = require('firebase-functions/v2/https')
const { db }                         = require('../db')
const { requireAuth, requireActive } = require('../middleware')
const REGION = 'us-central1'

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

exports.listCprRecords = onRequest({ region: REGION }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    // Role guard: SUPER_ADMIN and ADMIN only
    const roles = req.user.roles || []
    if (!roles.includes('SUPER_ADMIN') && !roles.includes('ADMIN')) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const status = req.query.status || null

    try {
      let query = db.collection('cpr_records').orderBy('created_at', 'desc')
      if (status) query = query.where('status', '==', status)

      const snap = await query.get()
      const records = snap.docs.map(d => ({ id: d.id, ...d.data() }))

      return res.status(200).json({ records, total: records.length })

    } catch (err) {
      console.error('[CPR-1D] listCprRecords error:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
