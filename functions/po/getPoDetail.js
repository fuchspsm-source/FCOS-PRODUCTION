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

exports.getPoDetail = onRequest({ region: REGION }, run(
  [requireAuth, requireActive, requireRole('SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN')],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    const { po_number } = req.query
    if (!po_number) return res.status(400).json({ error: 'po_number is required' })

    try {
      const headerSnap = await db.collection('po_headers').doc(po_number).get()
      if (!headerSnap.exists) return res.status(404).json({ error: 'PO not found' })

      const linesSnap = await db.collection('po_lines')
        .where('po_number', '==', po_number)
        .orderBy('line_number', 'asc')
        .get()

      const lines = linesSnap.docs.map(d => ({ id: d.id, ...d.data() }))

      return res.status(200).json({
        header : { po_number, ...headerSnap.data() },
        lines
      })

    } catch (err) {
      console.error('[fcos] getPoDetail:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
