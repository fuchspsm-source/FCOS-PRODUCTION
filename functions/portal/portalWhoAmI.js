'use strict'

const { onRequest }          = require('firebase-functions/v2/https')
const { db }                 = require('../db')
const { requirePortalAuth }  = require('../middleware')
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

exports.portalWhoAmI = onRequest({ region: REGION }, run(
  [requirePortalAuth],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    try {
      const snap = await db.collection('customer_users').doc(req.portalUser.uid).get()
      if (!snap.exists) return res.status(404).json({ error: 'Portal user not found' })

      const u = snap.data()
      return res.status(200).json({
        uid           : req.portalUser.uid,
        email         : u.email         || null,
        name          : u.name          || null,
        customer_code : u.customer_code,
        status        : u.status
      })
    } catch (err) {
      console.error('[portal] portalWhoAmI:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
