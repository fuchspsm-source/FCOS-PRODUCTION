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

exports.portalListAllProducts = onRequest({ region: REGION }, run(
  [requirePortalAuth],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    try {
      const snap = await db.collection('product_registry')
        .where('status', '==', 'ACTIVE')
        .get()
      const products = snap.docs.map(doc => {
        const d = doc.data()
        return {
          product_code : d.product_code || '',
          product_name : d.product_name || '',
          dbp          : d.dbp          || 0,
          display_name : (d.product_code || '') + ' - ' + (d.product_name || '')
        }
      }).sort((a, b) => a.product_name.localeCompare(b.product_name))
      return res.status(200).json({ products })
    } catch (err) {
      console.error('[portal] portalListAllProducts:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
