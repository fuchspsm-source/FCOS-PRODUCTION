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

exports.portalListPos = onRequest({ region: REGION }, run(
  [requirePortalAuth],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    const customer_code = req.portalUser.customer_code

    try {
      const snap = await db.collection('po_headers')
        .where('customer_code', '==', customer_code)
        .orderBy('created_at', 'desc')
        .limit(100)
        .get()

      const pos = snap.docs.map(d => {
        const data = d.data()
        return {
          po_number   : data.po_number,
          po_date     : data.po_date,
          status      : data.status,
          grand_total : data.grand_total,
          created_at  : data.created_at ? data.created_at.toMillis() : null
        }
      })

      return res.status(200).json({ pos })

    } catch (err) {
      console.error('[portal] portalListPos:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
