'use strict'

const { onRequest }                  = require('firebase-functions/v2/https')
const { requireAuth, requireActive } = require('../middleware')
const { savePoCore }                 = require('./savePoCore')
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

exports.savePo = onRequest({ region: REGION }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    try {
      const { po_number } = await savePoCore(req.body || {}, req.user.uid)
      return res.status(201).json({ ok: true, po_number })
    } catch (err) {
      if (err.code === 400) return res.status(400).json({ error: err.message })
      if (err.code === 409) return res.status(409).json({ error: err.message })
      console.error('[PO-6] savePo:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
