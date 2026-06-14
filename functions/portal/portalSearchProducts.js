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

exports.portalSearchProducts = onRequest({ region: REGION }, run(
  [requirePortalAuth],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    const { q, limit } = req.query
    const searchTerm = q ? String(q).trim() : ''
    const pageSize   = Math.min(Math.max(parseInt(limit) || 20, 1), 50)

    if (searchTerm.length < 2)
      return res.status(400).json({ error: 'Search term must be >= 2 characters' })

    const searchLower = searchTerm.toLowerCase()

    try {
      const [nameResults, codeResults] = await Promise.all([
        db.collection('product_registry')
          .where('status', '==', 'ACTIVE')
          .where('product_name_lower', '>=', searchLower)
          .where('product_name_lower', '<',  searchLower + '\uf8ff')
          .limit(pageSize)
          .get(),
        db.collection('product_registry')
          .where('status', '==', 'ACTIVE')
          .where('product_code_lower', '>=', searchLower)
          .where('product_code_lower', '<',  searchLower + '\uf8ff')
          .limit(pageSize)
          .get()
      ])

      const seen     = new Set()
      const products = []

      const processDoc = (doc) => {
        if (seen.has(doc.id)) return
        seen.add(doc.id)
        const d = doc.data()
        // Expose ONLY portal-safe fields — no cost, no source, no internal metadata
        products.push({
          product_code : d.product_code || '',
          product_name : d.product_name || '',
          dbp          : d.dbp          || 0
        })
      }

      nameResults.docs.forEach(processDoc)
      codeResults.docs.forEach(processDoc)
      products.sort((a, b) => a.product_code.localeCompare(b.product_code))

      return res.status(200).json({ products })

    } catch (err) {
      console.error('[portal] portalSearchProducts:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
