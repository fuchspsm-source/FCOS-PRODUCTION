'use strict'

window.FCOS = window.FCOS || {}

const BASE_URL = window.FCOS_CONFIG?.functionsBaseUrl
  || 'http://127.0.0.1:5001/fcos-dev/us-central1'

async function api(fnName, method = 'GET', body = null, queryParams = {}) {
  const token = window.FCOS.authToken

  const headers = {
    'Content-Type': 'application/json'
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  let url = `${BASE_URL}/${fnName}`

  if (method === 'GET' && queryParams && Object.keys(queryParams).length > 0) {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(queryParams).filter(([, v]) => v !== undefined && v !== null)
      )
    ).toString()
    if (qs) url += `?${qs}`
  }

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: (method !== 'GET' && body) ? JSON.stringify(body) : undefined
    })
  } catch (networkErr) {
    throw new FCOSApiError('Network error. Check your connection.', 0, fnName)
  }

  let data
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    data = await response.json()
  } else {
    data = { message: await response.text() }
  }

  if (!response.ok) {
    if (response.status === 401) {
      window.location.href = '/login.html'
      return
    }
    if (response.status === 403 && data.error === 'INACTIVE') {
      window.location.href = '/access-denied.html'
      return
    }
    if (response.status === 403 && data.error === 'PENDING') {
      window.location.href = '/waiting-approval.html'
      return
    }

    throw new FCOSApiError(
      data.error || data.message || 'Request failed',
      response.status,
      fnName
    )
  }

  return data
}

class FCOSApiError extends Error {
  constructor(message, status, fnName) {
    super(message)
    this.name   = 'FCOSApiError'
    this.status = status
    this.fnName = fnName
  }
}

Object.assign(window.FCOS, {
  api,
  FCOSApiError,
  BASE_URL
})


async function listMatrix() {
  return api('listMatrix');
}
async function getMatrix(matrixId) {
  return api('getMatrix', 'GET', null, { matrixId });
}
async function createMatrix(payload) {
  return api('createMatrix', 'POST', payload);
}
async function closeMatrix(matrixId) {
  return api('closeMatrix', 'POST', { matrixId });
}
Object.assign(window.FCOS, { listMatrix, getMatrix, createMatrix, closeMatrix });

async function listUsers(status) {
  const params = status ? { status } : {};
  return api('listUsers', 'GET', null, params);
}
Object.assign(window.FCOS, { listUsers });
