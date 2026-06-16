'use strict'

var createdPsm = null   // { psm_id, status, created_at, validity_from, validity_to }

// ─── Local callable wrapper (do not modify api.js) ───────
// fcos_createPsmDraft / fcos_savePsmHeader are onCall functions.
// They expect { data: {...} } and respond with { result: {...} } or { error: {...} }.
async function callCallable(fnName, payload) {
  var token = window.FCOS.authToken

  var headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = 'Bearer ' + token

  var url = window.FCOS.BASE_URL + '/' + fnName

  var response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ data: payload })
    })
  } catch (networkErr) {
    throw new Error('Network error. Check your connection.')
  }

  var body
  try {
    body = await response.json()
  } catch (e) {
    throw new Error('Invalid response from server.')
  }

  if (body.error) {
    throw new Error(body.error.message || 'Request failed')
  }

  return body.result
}

// ─── Init ────────────────────────────────────────────────
FCOS.initPage().then(function (user) {
  FCOS_buildNav(user)
  document.getElementById('topbar-name').textContent  = user.name
  document.getElementById('sidebar-footer').innerHTML =
    '<div>' + escHtml(user.name) + '</div>' +
    '<div class="mt-4 text-small">' + FCOS.formatRoles(user.roles) + '</div>'

  document.getElementById('loading').style.display = 'none'
  document.getElementById('main-content').classList.remove('hidden')

  loadCustomers()
})

// ─── Load customer list ──────────────────────────────────
async function loadCustomers() {
  var select = document.getElementById('input-customer')
  try {
    var result = await FCOS.api('listCustomers', 'GET')
    var customers = (result.customers || []).filter(function (c) {
      return c.active === true
    }).sort(function (a, b) {
      return (a.customerName || '').localeCompare(b.customerName || '', 'id', { sensitivity: 'base' })
    })

    if (customers.length === 0) {
      select.innerHTML = '<option value="">Tidak ada customer aktif</option>'
      return
    }

    select.innerHTML = '<option value="">— Pilih Customer —</option>' +
      customers.map(function (c) {
        return '<option value="' + escAttr(c.id) + '">' +
          escHtml(c.customerCode || '') + ' — ' + escHtml(c.customerName || '') +
          '</option>'
      }).join('')
  } catch (err) {
    select.innerHTML = '<option value="">Gagal memuat customer</option>'
    showGlobalMsg('error', 'Gagal memuat daftar customer: ' + err.message)
  }
}

// ─── Step 1: Create Draft ─────────────────────────────────
document.getElementById('btn-create-draft').addEventListener('click', async function () {
  var btn = this
  var customerId = document.getElementById('input-customer').value

  clearGlobalMsg()
  if (!customerId) {
    showGlobalMsg('error', 'Pilih customer terlebih dahulu.')
    return
  }

  FCOS.setLoading(btn, 'Membuat draft...')
  try {
    var result = await callCallable('fcos_createPsmDraft', { customer_id: customerId })
    createdPsm = result

    showStep2(result)
    showGlobalMsg('success', 'Draft PSM berhasil dibuat.')
  } catch (err) {
    showGlobalMsg('error', 'Gagal membuat draft: ' + err.message)
    FCOS.clearLoading(btn)
    btn.textContent = 'Create Draft'
  }
})

// ─── Step 2: show fields, populate defaults ──────────────
function showStep2(draft) {
  document.getElementById('card-step1').classList.add('hidden')
  document.getElementById('card-step2').classList.remove('hidden')

  document.getElementById('draft-info').innerHTML =
    '<dt>PSM ID</dt>'         + '<dd>' + escHtml(draft.psm_id || '—')         + '</dd>' +
    '<dt>Status</dt>'         + '<dd>' + escHtml(draft.status || '—')         + '</dd>' +
    '<dt>Created At</dt>'     + '<dd>' + FCOS.formatDateTime(draft.created_at) + '</dd>'

  // Server defaults: validity_to = last day of current month, accrual_enabled = false, accrual_percent = 3
  document.getElementById('input-validity-to').value     = lastDayOfMonthString()
  document.getElementById('input-accrual-enabled').checked = false
  document.getElementById('input-accrual-percent').value = 3
}

// ─── Step 2: Save Header ─────────────────────────────────
document.getElementById('btn-save-header').addEventListener('click', async function () {
  var btn = this
  clearGlobalMsg()

  var validityTo     = document.getElementById('input-validity-to').value
  var accrualEnabled = document.getElementById('input-accrual-enabled').checked
  var accrualPercent = parseFloat(document.getElementById('input-accrual-percent').value)
  var businessJustification = document.getElementById('input-business-justification').value.trim()

  if (!validityTo) {
    showGlobalMsg('error', 'Validity To wajib diisi.')
    return
  }
  if (isNaN(accrualPercent) || accrualPercent < 0 || accrualPercent > 100) {
    showGlobalMsg('error', 'Accrual Percent harus berupa angka antara 0 dan 100.')
    return
  }
  if (businessJustification.length < 10) {
    showGlobalMsg('error', 'Alasan Pengajuan PSM minimal 10 karakter.')
    return
  }

  FCOS.setLoading(btn, 'Menyimpan...')
  try {
    await callCallable('fcos_savePsmHeader', {
      psm_id: createdPsm.psm_id,
      validity_to: validityTo,
      accrual_enabled: accrualEnabled,
      accrual_percent: accrualPercent,
      business_justification: businessJustification
    })

    window.location.href = '/psm/detail.html?psm_id=' + encodeURIComponent(createdPsm.psm_id)
  } catch (err) {
    showGlobalMsg('error', 'Gagal menyimpan header: ' + err.message)
    FCOS.clearLoading(btn)
    btn.textContent = 'Save & Continue'
  }
})

// ─── Logout ──────────────────────────────────────────────
document.getElementById('btn-logout').addEventListener('click', function () { FCOS.logout() })

// ─── Helpers ─────────────────────────────────────────────
function lastDayOfMonthString() {
  var now     = new Date()
  var lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
  var y = lastDay.getUTCFullYear()
  var m = String(lastDay.getUTCMonth() + 1).padStart(2, '0')
  var d = String(lastDay.getUTCDate()).padStart(2, '0')
  return y + '-' + m + '-' + d
}

function escHtml(str) {
  return String(str === undefined || str === null ? '' : str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
function escAttr(str) { return escHtml(str) }

function showGlobalMsg(type, msg) {
  var el = document.getElementById('alert-msg')
  el.textContent = msg
  el.className   = 'alert alert--' + type
  el.style.display = 'block'
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function clearGlobalMsg() {
  var el = document.getElementById('alert-msg')
  el.style.display = 'none'
  el.textContent   = ''
}
