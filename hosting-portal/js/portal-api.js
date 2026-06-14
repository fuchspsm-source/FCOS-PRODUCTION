'use strict'

window.PORTAL = window.PORTAL || {}

const PORTAL_BASE_URL = window.PORTAL_CONFIG?.functionsBaseUrl
  || 'https://us-central1-fcos-production.cloudfunctions.net'

async function portalApi(fnName, method = 'GET', body = null, queryParams = {}) {
  const token = window.PORTAL.authToken

  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = 'Bearer ' + token

  let url = PORTAL_BASE_URL + '/' + fnName

  if (method === 'GET' && queryParams && Object.keys(queryParams).length > 0) {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(queryParams).filter(([, v]) => v !== undefined && v !== null)
      )
    ).toString()
    if (qs) url += '?' + qs
  }

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: (method !== 'GET' && body) ? JSON.stringify(body) : undefined
    })
  } catch (networkErr) {
    throw new PortalApiError('Koneksi gagal. Periksa jaringan Anda.', 0, fnName)
  }

  // PDF response — return blob directly
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/pdf')) {
    if (!response.ok) throw new PortalApiError('Gagal mengunduh PDF.', response.status, fnName)
    return response.blob()
  }

  let data
  if (contentType.includes('application/json')) {
    data = await response.json()
  } else {
    data = { message: await response.text() }
  }

  if (!response.ok) {
    // 401 → back to login
    if (response.status === 401) {
      firebase.auth().signOut().then(() => { window.location.href = '/login.html' })
      return
    }
    // 403 portal-not-found → FCOS internal user trying portal
    if (response.status === 403) {
      window.location.href = '/access-denied.html'
      return
    }
    throw new PortalApiError(
      data.error || data.message || 'Request gagal',
      response.status,
      fnName
    )
  }

  return data
}

class PortalApiError extends Error {
  constructor(message, status, fnName) {
    super(message)
    this.name   = 'PortalApiError'
    this.status = status
    this.fnName = fnName
  }
}

Object.assign(window.PORTAL, {
  api           : portalApi,
  PortalApiError,
  BASE_URL      : PORTAL_BASE_URL
})
