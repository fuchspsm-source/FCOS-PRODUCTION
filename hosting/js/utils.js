'use strict'

window.FCOS = window.FCOS || {}

function formatDate(value, fallback = '—') {
  if (!value) return fallback
  let date
  if (value && typeof value._seconds === 'number') {
    date = new Date(value._seconds * 1000)
  } else if (value && typeof value.seconds === 'number') {
    date = new Date(value.seconds * 1000)
  } else {
    date = new Date(value)
  }
  if (isNaN(date.getTime())) return fallback
  return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
}

function formatDateTime(value, fallback = '—') {
  if (!value) return fallback
  let date
  if (value && typeof value._seconds === 'number') {
    date = new Date(value._seconds * 1000)
  } else if (value && typeof value.seconds === 'number') {
    date = new Date(value.seconds * 1000)
  } else {
    date = new Date(value)
  }
  if (isNaN(date.getTime())) return fallback
  return date.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const ROLE_LABELS = {
  SUPER_ADMIN      : 'Super Admin',
  ADMIN            : 'Admin',
  COMMERCIAL_ADMIN : 'Commercial Admin',
  CUSTOMER_SERVICE : 'Customer Service',
  AREA_MANAGER     : 'Area Manager',
  REGIONAL_MANAGER : 'Regional Manager',
  DIVISION_MANAGER : 'Division Manager',
  SALES_DIRECTOR   : 'Sales Director',
  MANAGING_DIRECTOR: 'Managing Director'
}

function roleLabel(role) { return ROLE_LABELS[role] || role }

function formatRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return '—'
  return roles.map(roleLabel).join(', ')
}

const STATUS_LABELS  = { PENDING: 'Pending', ACTIVE: 'Active', INACTIVE: 'Inactive' }
const STATUS_CLASSES = { PENDING: 'badge badge--pending', ACTIVE: 'badge badge--active', INACTIVE: 'badge badge--inactive' }

function statusBadge(status) {
  const label = STATUS_LABELS[status] || status
  const cls   = STATUS_CLASSES[status] || 'badge'
  return `<span class="${cls}">${label}</span>`
}

function el(id) {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Element not found: #${id}`)
  return element
}

function showError(elementId, message) {
  const target = document.getElementById(elementId)
  if (!target) return
  target.textContent  = message
  target.style.display = 'block'
}

function hideError(elementId) {
  const target = document.getElementById(elementId)
  if (!target) return
  target.textContent  = ''
  target.style.display = 'none'
}

function setLoading(btn, loadingText = 'Loading...') {
  btn.disabled      = true
  btn._originalText = btn.textContent
  btn.textContent   = loadingText
}

function clearLoading(btn) {
  btn.disabled    = false
  btn.textContent = btn._originalText || 'Submit'
}

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name)
}

function confirm(message) { return window.confirm(message) }

Object.assign(window.FCOS, {
  formatDate, formatDateTime, roleLabel, formatRoles,
  statusBadge, el, showError, hideError, setLoading,
  clearLoading, getParam, confirm, ROLE_LABELS, STATUS_LABELS
})
