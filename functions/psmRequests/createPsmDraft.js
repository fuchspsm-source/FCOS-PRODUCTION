'use strict'

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { db, admin }          = require('../db')

const REGION = 'us-central1'

// ── Date helpers (UTC — avoids timezone drift) ─────────────────────────────

function todayString() {
  const now = new Date()
  const y   = now.getUTCFullYear()
  const m   = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d   = String(now.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function lastDayOfMonthString() {
  const now     = new Date()
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
  const y       = lastDay.getUTCFullYear()
  const m       = String(lastDay.getUTCMonth() + 1).padStart(2, '0')
  const d       = String(lastDay.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// ─────────────────────────────────────────────────────────────────────────

exports.createPsmDraft = onCall({ region: REGION }, async (request) => {

  // V1: Authentication
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.')
  }
  const sales_uid = request.auth.uid

  // V2: customer_id required, non-empty string
  const raw_customer_id = request.data?.customer_id
  if (
    !raw_customer_id ||
    typeof raw_customer_id !== 'string' ||
    raw_customer_id.trim() === ''
  ) {
    throw new HttpsError('invalid-argument', 'customer_id is required.')
  }
  const customer_id = raw_customer_id.trim()

  // V3: Customer must exist in Customer Registry
  // Registry field names confirmed from production: customerCode, customerName
  const custSnap = await db.collection('customers').doc(customer_id).get()
  if (!custSnap.exists) {
    throw new HttpsError('not-found', 'Customer not found in Customer Registry.')
  }

  // V4: Authenticated user must exist in User Registry
  const userSnap = await db.collection('users').doc(sales_uid).get()
  if (!userSnap.exists) {
    throw new HttpsError(
      'failed-precondition',
      'Authenticated user not found in User Registry.'
    )
  }

  const custData = custSnap.data()
  const userData = userSnap.data()

  // Snapshots from registry — backend reads authoritative values.
  // Customer registry uses camelCase (verified from production):
  //   customerCode, customerName
  // Users registry uses: name
  const customer_code = custData.customerCode || null
  const customer_name = custData.customerName || null
  const sales_name    = userData.name         || sales_uid

  // Validity dates: server-computed, read-only
  // validity_from = today (UTC), validity_to = last day of current month (UTC)
  const validity_from = todayString()
  const validity_to   = lastDayOfMonthString()

  // Generate document — psm_id = Firestore document ID
  const docRef = db.collection('psm_requests').doc()
  const psm_id = docRef.id
  const now_ts = admin.firestore.FieldValue.serverTimestamp()

  await docRef.set({
    psm_id,
    psm_number:          null,
    customer_id,
    customer_code,
    customer_name,
    sales_uid,
    sales_name,
    status:              'DRAFT',
    validity_from,
    validity_to,
    accrual_enabled:     false,
    accrual_percent:     3,
    gross_sales:         0,
    gross_cost:          0,
    gross_nc:            0,
    nc_after_accrual:    0,
    nc_resolver:         0,
    approval_request_id: null,
    created_by:          sales_uid,
    created_at:          now_ts,
    updated_at:          now_ts,
  })

  return {
    psm_id,
    status:     'DRAFT',
    created_at: new Date().toISOString(),
  }
})
