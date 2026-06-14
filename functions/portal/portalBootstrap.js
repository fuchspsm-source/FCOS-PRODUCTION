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

exports.portalBootstrap = onRequest({ region: REGION }, run(
  [requirePortalAuth],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    // customer_code ALWAYS from token — never from request
    const { customer_code } = req.portalUser

    try {
      // L1: Load customer record
      const custSnap = await db.collection('customers')
        .where('customerCode', '==', customer_code)
        .where('active', '==', true)
        .limit(1)
        .get()

      if (custSnap.empty)
        return res.status(404).json({ error: `Customer not found: ${customer_code}` })

      const cust = custSnap.docs[0].data()

      // L2: Load active Ship-Tos under this customer only
      const shipSnap = await db.collection('customerShipTos')
        .where('soldToCode', '==', customer_code)
        .where('active', '==', true)
        .orderBy('shipToName')
        .get()

      const ship_tos = shipSnap.docs.map(d => ({
        shipto_code : d.data().shipToCode,
        shipto_name : d.data().shipToName,
        address     : d.data().address || ''
      }))

      return res.status(200).json({
        customer: {
          customer_code : cust.customerCode,
          customer_name : cust.customerName,
          address       : cust.address || ''
        },
        ship_tos
      })

    } catch (err) {
      console.error('[portal] portalBootstrap:', err)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
))
