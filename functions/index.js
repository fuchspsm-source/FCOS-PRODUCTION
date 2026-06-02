'use strict'
const { onRequest } = require('firebase-functions/v2/https')
const express       = require('express')
const { requireAuth } = require('./middleware')

const app = express()
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() })
})

app.get('/me', requireAuth, (req, res) => {
  res.json({ uid: req.user.uid, roles: req.user.roles, status: req.user.status })
})

exports.api = onRequest({ region: 'asia-southeast2' }, app)
