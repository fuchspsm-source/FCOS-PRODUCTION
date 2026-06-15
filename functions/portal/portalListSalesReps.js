'use strict'

const { onRequest }         = require('firebase-functions/v2/https')
const { db }                = require('../db')
const { requirePortalAuth } = require('../middleware')
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

exports.portalListSalesReps = onRequest({ region: REGION }, run(
  [requirePortalAuth],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    try {
      const snap = await db.collection('users')
        .where('status', '==', 'ACTIVE')
        .get()

      const reps = snap.docs
        .map(d => ({ uid: d.id, name: d.data().name, email: d.data().email }))
        .filter(u => u.name)
        .sort((a, b) => a.name.localeCompare(b.name))

      return res.status(200).json({ reps })

    } catch (err) {
      console.error('[portal] portalListSalesReps:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
