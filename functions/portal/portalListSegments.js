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

exports.portalListSegments = onRequest({ region: REGION }, run(
  [requirePortalAuth],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    try {
      const snap = await db.collection('segments')
        .where('active', '==', true)
        .orderBy('segment_code')
        .get()
      return res.status(200).json({
        segments: snap.docs.map(d => ({
          segment_code : d.data().segment_code,
          segment_name : d.data().segment_name
        }))
      })
    } catch (err) {
      console.error('[portal] portalListSegments:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
