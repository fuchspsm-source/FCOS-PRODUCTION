'use strict'

const { onRequest }                              = require('firebase-functions/v2/https')
const { db }                                     = require('../db')
const { requireAuth, requireActive, requireRole } = require('../middleware')
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

exports.listAllPos = onRequest({ region: REGION }, run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    try {
      const snap = await db.collection('po_headers')
        .orderBy('created_at', 'desc')
        .limit(200)
        .get()

      const pos = snap.docs.map(d => {
        const data = d.data()
        return {
          po_number    : data.po_number,
          po_date      : data.po_date,
          customer_code: data.customer_code,
          customer_name: data.customer_name,
          segment_name : data.segment_name  || '',
          grand_total  : data.grand_total,
          status       : data.status,
          created_at   : data.created_at ? data.created_at.toMillis() : null
        }
      })

      return res.status(200).json({ pos })

    } catch (err) {
      console.error('[fcos] listAllPos:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
