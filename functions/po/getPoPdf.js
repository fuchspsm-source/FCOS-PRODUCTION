'use strict'

const { onRequest }                  = require('firebase-functions/v2/https')
const { db }                         = require('../db')
const { requireAuth, requireActive } = require('../middleware')
const { buildPoPdf }                 = require('./buildPoPdf')
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

exports.getPoPdf = onRequest({ region: REGION }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    const po_number = (req.query.po_number || '').trim()
    if (!po_number) return res.status(400).json({ error: 'po_number is required' })

    try {
      const headerSnap = await db.collection('po_headers').doc(po_number).get()
      if (!headerSnap.exists) return res.status(404).json({ error: 'PO not found' })
      const hdr = headerSnap.data()

      const linesSnap = await db.collection('po_lines')
        .where('po_number', '==', po_number)
        .orderBy('line_number')
        .get()
      const lines = linesSnap.docs.map(d => d.data())

      buildPoPdf(hdr, lines, po_number, res)

    } catch (err) {
      console.error('[PO-8] getPoPdf:', err)
      if (!res.headersSent) return res.status(500).json({ error: 'Internal error' })
      res.end()
    }
  }
))
