'use strict'

const { onRequest }         = require('firebase-functions/v2/https')
const { db }                = require('../db')
const { requirePortalAuth } = require('../middleware')
const { buildPoPdf }        = require('../po/buildPoPdf')
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

exports.portalGetPoPdf = onRequest({ region: REGION }, run(
  [requirePortalAuth],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    const po_number = (req.query.po_number || '').trim()
    if (!po_number) return res.status(400).json({ error: 'po_number is required' })

    // customer_code ALWAYS from token
    const customer_code = req.portalUser.customer_code

    try {
      const headerSnap = await db.collection('po_headers').doc(po_number).get()
      if (!headerSnap.exists) return res.status(404).json({ error: 'PO not found' })
      const hdr = headerSnap.data()

      // ── OWNERSHIP CHECK ──────────────────────────────────────
      if (hdr.customer_code !== customer_code)
        return res.status(403).json({ error: 'Access denied: PO does not belong to your account' })

      const linesSnap = await db.collection('po_lines')
        .where('po_number', '==', po_number)
        .orderBy('line_number')
        .get()
      const lines = linesSnap.docs.map(d => d.data())

      buildPoPdf(hdr, lines, po_number, res)

    } catch (err) {
      console.error('[portal] portalGetPoPdf:', err)
      if (!res.headersSent) return res.status(500).json({ error: 'Internal error' })
      res.end()
    }
  }
))
