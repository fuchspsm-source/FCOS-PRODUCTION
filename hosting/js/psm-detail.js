'use strict'

// ─── PSM-specific status badge (local only, do not modify utils.js) ──
var PSM_STATUS_LABELS = {
  DRAFT     : 'Draft',
  SUBMITTED : 'Submitted',
  PENDING   : 'Pending',
  APPROVED  : 'Approved',
  REJECTED  : 'Rejected'
}
var PSM_STATUS_CLASSES = {
  DRAFT     : 'badge badge--draft',
  SUBMITTED : 'badge badge--submitted',
  PENDING   : 'badge badge--pending',
  APPROVED  : 'badge badge--active',
  REJECTED  : 'badge badge--inactive'
}
function psmStatusBadge(status) {
  var label = PSM_STATUS_LABELS[status] || status || '—'
  var cls   = PSM_STATUS_CLASSES[status] || 'badge'
  return '<span class="' + cls + '">' + label + '</span>'
}

var psmId = FCOS.getParam('psm_id')

var selectedProduct  = null   // { product_id, product_code, product_name, dbp, cost, display_name }
var searchDebounceId = null
var lastLoadedData   = null

if (!psmId) {
  document.getElementById('loading').textContent =
    'PSM ID tidak ditemukan pada URL.'
} else {
  FCOS.initPage().then(function (user) {
  FCOS_SIDEBAR.build(user)
    document.getElementById('topbar-name').textContent  = user.name
    document.getElementById('sidebar-footer').innerHTML =
      '<div>' + escHtml(user.name) + '</div>' +
      '<div class="mt-4 text-small">' + FCOS.formatRoles(user.roles) + '</div>'
    loadDetail()
  })
}

async function loadDetail() {
  try {
    var data = await FCOS.api('fcos_getPsmDetail', 'GET', null, { psm_id: psmId })
    lastLoadedData = data

    document.getElementById('loading').style.display = 'none'
    document.getElementById('main-content').classList.remove('hidden')

    renderPsmInfo(data.psm)
    renderBusinessJustification(data.psm)
    renderCommercialInfo(data.psm)
    renderItems(data.items || [], data.can_edit === true)
    renderItemsFooter(data.psm, data.items || [])
    renderApprovalInfo(data.approval)
    renderApprovalHistory(data.approval_history || [])
    renderApprovalAction(data)
    renderCallerInfo(data)
    renderAddItemSection(data)
    renderSubmitButton(data)
    renderRecallButton(data)
  } catch (err) {
    document.getElementById('loading').textContent =
      'Gagal memuat PSM: ' + err.message
  }
}

// ─── Section 1: PSM Header ───────────────────────────────
function renderPsmInfo(psm) {
  psm = psm || {}
  document.getElementById('page-title').textContent =
    psm.psm_number || ('PSM ' + (psm.psm_id || ''))

  document.getElementById('psm-info').innerHTML =
    '<dt>PSM Number</dt>'    + '<dd>' + escHtml(psm.psm_number || '—')      + '</dd>' +
    '<dt>Customer Code</dt>' + '<dd>' + escHtml(psm.customer_code || '—')   + '</dd>' +
    '<dt>Customer Name</dt>' + '<dd>' + escHtml(psm.customer_name || '—')   + '</dd>' +
    '<dt>Sales Name</dt>'    + '<dd>' + escHtml(psm.sales_name || '—')      + '</dd>' +
    '<dt>Validity From</dt>' + '<dd>' + escHtml(psm.validity_from || '—')   + '</dd>' +
    '<dt>Validity To</dt>'   + '<dd>' + escHtml(psm.validity_to || '—')     + '</dd>' +
    '<dt>Status</dt>'        + '<dd>' + psmStatusBadge(psm.status)          + '</dd>'
}

// --- Section 1B: Business Justification (PSM-BIZ-1) ---
function renderBusinessJustification(psm) {
  psm = psm || {}
  document.getElementById('business-justification-content').innerHTML =
    escHtml(psm.business_justification || '—')
}

// --- Download PDF (PSM-PDF-1D) ---
var btnDownloadPdf = document.getElementById('btn-download-pdf')
if (btnDownloadPdf) {
  btnDownloadPdf.addEventListener('click', async function () {
    var btn = this
    FCOS.setLoading(btn, 'Menyiapkan PDF...')

    try {
      var token = window.FCOS.authToken
      var url = window.FCOS_CONFIG.functionsBaseUrl + '/fcos_getPsmPdf?psm_id=' + encodeURIComponent(psmId)

      var response = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + token }
      })

      if (!response.ok) {
        var errBody = await response.json().catch(function () { return {} })
        throw new Error(errBody.error || 'Gagal membuat PDF (status ' + response.status + ')')
      }

      var blob = await response.blob()
      var disposition = response.headers.get('Content-Disposition') || ''
      var match = disposition.match(/filename="?([^"]+)"?/)
      var filename = match ? match[1] : 'PSM.pdf'

      var blobUrl = window.URL.createObjectURL(blob)
      var a = document.createElement('a')
      a.href = blobUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(blobUrl)

    } catch (err) {
      alert('Gagal mengunduh PDF: ' + err.message)
    } finally {
      FCOS.clearLoading(btn)
      btn.textContent = 'Download PDF'
    }
  })
}

// ─── Section 2: Commercial Summary ───────────────────────
function renderCommercialInfo(psm) {
  psm = psm || {}
  document.getElementById('commercial-info').innerHTML =
    '<dt>Aggregate NC</dt>'      + '<dd>' + formatNumberOrDash(psm.aggregate_nc)      + '</dd>' +
    '<dt>Accrual Enabled</dt>'   + '<dd>' + formatBoolOrDash(psm.accrual_enabled)     + '</dd>' +
    '<dt>Accrual Percent</dt>'   + '<dd>' + formatNumberOrDash(psm.accrual_percent)   + '</dd>'
}

// ─── Section 3: Item List ─────────────────────────────────
var lastLoadedItems  = []
var lastCanEdit      = false
var editingIdx       = null   // index of row currently in inline edit mode (only one at a time)

function renderItems(items, canEdit) {
  lastLoadedItems = items || []
  lastCanEdit     = !!canEdit

  // If the previously-edited item no longer exists (e.g. after reload), clear edit state
  if (editingIdx !== null && editingIdx >= lastLoadedItems.length) {
    editingIdx = null
  }

  var tbody = document.getElementById('items-body')
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" class="table-empty">Tidak ada item.</td></tr>'
    return
  }

  tbody.innerHTML = items.map(function (it, idx) {
    if (canEdit && editingIdx === idx) {
      return renderEditRow(it, idx)
    }
    return renderReadOnlyRow(it, idx, canEdit)
  }).join('')

  attachRowHandlers(canEdit)
}

function renderReadOnlyRow(it, idx, canEdit) {
  var discountPct = computeDiscountPercent(it.dbp, it.proposed_price)
  var salesValue  = it.total_sales
  var costValue   = it.total_cost
  var margin      = (typeof it.total_sales === 'number' && typeof it.total_cost === 'number')
                     ? (it.total_sales - it.total_cost)
                     : null

  var actionCell = '—'
  if (canEdit) {
    actionCell =
      '<button class="btn btn--secondary btn--sm" data-edit-idx="' + idx + '">Edit</button> ' +
      '<button class="btn btn--danger btn--sm" data-delete-idx="' + idx + '">Delete</button>'
  }

  return '<tr>' +
    '<td class="text-small">' + escHtml(it.product_code || '—')          + '</td>' +
    '<td>'                     + escHtml(it.product_name || '—')          + '</td>' +
    '<td class="text-small">' + formatNumberOrDash(it.qty)                + '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(it.dbp)              + '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(it.cost)             + '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(it.proposed_price)   + '</td>' +
    '<td class="text-small">' + formatPercentOrDash(discountPct)          + '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(salesValue)          + '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(costValue)           + '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(margin)              + '</td>' +
    '<td class="text-small">' + formatPercentOrDash(it.nc)                + '</td>' +
    '<td class="text-small" style="white-space:nowrap;">' + actionCell + '</td>' +
    '</tr>'
}

function renderEditRow(it, idx) {
  return '<tr data-edit-row="' + idx + '">' +
    '<td class="text-small">' + escHtml(it.product_code || '—') + '</td>' +
    '<td>'                     + escHtml(it.product_name || '—') + '</td>' +
    '<td class="text-small">' +
      '<input type="number" class="form-control" id="edit-qty-' + idx + '" ' +
      'min="1" step="1" value="' + escAttr(it.qty) + '" style="width:80px;">' +
    '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(it.dbp)  + '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(it.cost) + '</td>' +
    '<td class="text-small">' +
      '<input type="number" class="form-control" id="edit-price-' + idx + '" ' +
      'min="0" step="0.01" value="' + escAttr(it.proposed_price) + '" style="width:120px;">' +
    '</td>' +
    '<td class="text-small">—</td>' +
    '<td class="text-small">—</td>' +
    '<td class="text-small">—</td>' +
    '<td class="text-small">—</td>' +
    '<td class="text-small">—</td>' +
    '<td class="text-small" style="white-space:nowrap;">' +
      '<button class="btn btn--primary btn--sm" data-save-idx="' + idx + '">Save</button> ' +
      '<button class="btn btn--secondary btn--sm" data-cancel-idx="' + idx + '">Cancel</button>' +
      '<div id="edit-row-error-' + idx + '" class="alert alert--error hidden" ' +
      'style="margin-top:6px; padding:4px 8px; font-size:12px; white-space:normal;"></div>' +
    '</td>' +
    '</tr>'
}

function attachRowHandlers(canEdit) {
  var tbody = document.getElementById('items-body')
  if (!canEdit) return

  tbody.querySelectorAll('button[data-edit-idx]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      editingIdx = parseInt(this.dataset.editIdx, 10)
      renderItems(lastLoadedItems, lastCanEdit)
    })
  })

  tbody.querySelectorAll('button[data-delete-idx]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var idx = parseInt(this.dataset.deleteIdx, 10)
      confirmDeleteItem(lastLoadedItems[idx])
    })
  })

  tbody.querySelectorAll('button[data-cancel-idx]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      editingIdx = null
      renderItems(lastLoadedItems, lastCanEdit)
    })
  })

  tbody.querySelectorAll('button[data-save-idx]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var idx = parseInt(this.dataset.saveIdx, 10)
      handleSaveEditRow(idx, btn)
    })
  })
}

// ─── Reusable Commercial Summary Calculation ─────────────
// Reusable for: detail page, approval screen, approval email
// snapshot, PDF export, CPR snapshot. Keep formulas centralized
// here — do not duplicate elsewhere.
function computePsmFinancials(psm, items) {
  items = items || []

  var total_qty    = 0
  var gross_sales  = 0
  var gross_cost   = 0
  var discountSum  = 0
  var discountCount = 0

  items.forEach(function (it) {
    if (typeof it.qty === 'number')         total_qty   += it.qty
    if (typeof it.total_sales === 'number') gross_sales += it.total_sales
    if (typeof it.total_cost === 'number')  gross_cost  += it.total_cost

    var d = computeDiscountPercent(it.dbp, it.proposed_price)
    if (d !== null) {
      discountSum  += d
      discountCount++
    }
  })

  var gross_margin = gross_sales - gross_cost
  var gross_nc     = gross_sales !== 0 ? (gross_margin / gross_sales) * 100 : null
  var avg_discount = discountCount > 0 ? (discountSum / discountCount) : null

  var result = {
    total_qty:     total_qty,
    gross_sales:   gross_sales,
    gross_cost:    gross_cost,
    gross_margin:  gross_margin,
    gross_nc:      gross_nc,
    avg_discount:  avg_discount,
    accrual_enabled: !!(psm && psm.accrual_enabled),
    accrual_percent: psm ? psm.accrual_percent : null,
    accrual_value: null,
    net_sales:     null,
    net_cost:      gross_cost,
    net_margin:    null,
    net_nc:        null
  }

  if (result.accrual_enabled && typeof psm.accrual_percent === 'number') {
    result.accrual_value = gross_sales * psm.accrual_percent / 100
    result.net_sales     = gross_sales - result.accrual_value
    result.net_margin    = result.net_sales - gross_cost
    result.net_nc        = result.net_sales !== 0
                            ? (result.net_margin / result.net_sales) * 100
                            : null
  } else {
    result.net_sales  = gross_sales
    result.net_margin = gross_margin
    result.net_nc     = gross_nc
  }

  return result
}

function computeDiscountPercent(dbp, proposedPrice) {
  if (typeof dbp !== 'number' || dbp === 0) return null
  if (typeof proposedPrice !== 'number') return null
  return ((dbp - proposedPrice) / dbp) * 100
}

// ─── Footer rows: TOTAL / LESS ACCRUAL / NET RESULT ──────
function renderItemsFooter(psm, items) {
  var tfoot = document.getElementById('items-footer')
  if (!items || items.length === 0) {
    tfoot.innerHTML = ''
    return
  }

  var f = computePsmFinancials(psm, items)

  var rows = ''

  // Row 1: TOTAL
  rows += '<tr style="background:#f3f4f6; font-weight:600;">' +
    '<td colspan="2">TOTAL</td>' +
    '<td class="text-small">' + formatNumberOrDash(f.total_qty) + '</td>' +
    '<td></td>' +
    '<td></td>' +
    '<td></td>' +
    '<td class="text-small">' + formatPercentOrDash(f.avg_discount) + '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(f.gross_sales) + '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(f.gross_cost) + '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(f.gross_margin) + '</td>' +
    '<td class="text-small">' + formatPercentOrDash(f.gross_nc) + '</td>' +
    '<td></td>' +
    '</tr>'

  // Row 2: LESS ACCRUAL (only if accrual_enabled)
  if (f.accrual_enabled) {
    var accrualLabel = 'LESS ACCRUAL (' + formatNumberOrDash(f.accrual_percent) + '%)'
    rows += '<tr style="background:#fef9c3;">' +
      '<td colspan="2">' + escHtml(accrualLabel) + '</td>' +
      '<td></td>' +
      '<td></td>' +
      '<td></td>' +
      '<td></td>' +
      '<td></td>' +
      '<td class="text-small">(' + formatCurrencyOrDash(f.accrual_value) + ')</td>' +
      '<td></td>' +
      '<td class="text-small">(' + formatCurrencyOrDash(f.accrual_value) + ')</td>' +
      '<td></td>' +
      '<td></td>' +
      '</tr>'
  }

  // Row 3: NET RESULT
  rows += '<tr style="background:#dcfce7; font-weight:600;">' +
    '<td colspan="2">NET RESULT</td>' +
    '<td></td>' +
    '<td></td>' +
    '<td></td>' +
    '<td></td>' +
    '<td></td>' +
    '<td class="text-small">' + formatCurrencyOrDash(f.net_sales) + '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(f.net_cost) + '</td>' +
    '<td class="text-small">' + formatCurrencyOrDash(f.net_margin) + '</td>' +
    '<td class="text-small">' + formatPercentOrDash(f.net_nc) + '</td>' +
    '<td></td>' +
    '</tr>'

  tfoot.innerHTML = rows
}

// ─── Delete Item (PSM-UI-2C) ─────────────────────────────
function confirmDeleteItem(item) {
  if (!item || !item.item_id) return

  var msg = 'Delete item?\n\n' +
    (item.product_code || '—') + '\n' +
    (item.product_name || '—') + '\n\n' +
    'This action cannot be undone.'

  if (!window.confirm(msg)) return

  doDeleteItem(item)
}

async function doDeleteItem(item) {
  hideAddItemError()
  try {
    await FCOS.api('fcos_removePsmItem', 'POST', {
      psm_id: psmId,
      item_id: item.item_id
    })
    await loadDetail()
  } catch (err) {
    showAddItemError(err.message)
  }
}

// ─── Edit Item (PSM-UI-2D, inline row edit) ──────────────
async function handleSaveEditRow(idx, btn) {
  var item = lastLoadedItems[idx]
  if (!item) return

  var errEl = document.getElementById('edit-row-error-' + idx)
  hideRowError(errEl)

  var qtyInput   = document.getElementById('edit-qty-' + idx)
  var priceInput = document.getElementById('edit-price-' + idx)

  var qty   = parseInt(qtyInput.value, 10)
  var price = parseFloat(priceInput.value)

  if (isNaN(qty) || qty < 1 || !Number.isInteger(qty)) {
    showRowError(errEl, 'Qty harus berupa bilangan bulat minimal 1.')
    return
  }
  if (isNaN(price) || price < 0) {
    showRowError(errEl, 'Proposed Price harus berupa angka >= 0.')
    return
  }

  var saveBtn   = btn
  var cancelBtn = saveBtn.parentElement.querySelector('button[data-cancel-idx]')
  FCOS.setLoading(saveBtn, 'Menyimpan...')
  if (cancelBtn) cancelBtn.disabled = true

  try {
    await FCOS.api('fcos_removePsmItem', 'POST', {
      psm_id: psmId,
      item_id: item.item_id
    })
  } catch (err) {
    showRowError(errEl, err.message)
    FCOS.clearLoading(saveBtn)
    saveBtn.textContent = 'Save'
    if (cancelBtn) cancelBtn.disabled = false
    return
  }

  try {
    await FCOS.api('fcos_addPsmItem', 'POST', {
      psm_id: psmId,
      product_id: item.product_id,
      qty: qty,
      proposed_price: price
    })
    editingIdx = null
    await loadDetail()
  } catch (err) {
    // Partial failure: item already removed, re-add failed.
    editingIdx = null
    await loadDetail()
    showAddItemError(
      'Item removed but failed to re-add with new values: ' + err.message +
      '. Please use "Add Item" below to re-add manually: ' +
      (item.product_code || '—') + ' ' + (item.product_name || '—')
    )
  }
}

function showRowError(el, msg) {
  if (!el) return
  el.textContent = msg
  el.classList.remove('hidden')
}

function hideRowError(el) {
  if (!el) return
  el.textContent = ''
  el.classList.add('hidden')
}

// ─── Section 3B: Add Item ─────────────────────────────────
function renderAddItemSection(data) {
  var card = document.getElementById('card-add-item')
  if (data.can_edit === true) {
    card.classList.remove('hidden')
  } else {
    card.classList.add('hidden')
  }
}

// Debounced product search on input
document.getElementById('input-product-search').addEventListener('input', function () {
  var q = this.value.trim()
  var resultsEl = document.getElementById('product-search-results')

  if (searchDebounceId) clearTimeout(searchDebounceId)

  if (q.length < 2) {
    resultsEl.classList.add('hidden')
    resultsEl.innerHTML = ''
    return
  }

  searchDebounceId = setTimeout(function () {
    doProductSearch(q)
  }, 300)
})

async function ensureProductsLoaded() {
  if (window._allProducts) return
  var data = await FCOS.api('fcos_searchProducts', 'GET', null, { q: 'a', limit: 2000 })
  window._allProducts = data.products || []
}

async function doProductSearch(q) {
  var resultsEl = document.getElementById('product-search-results')
  try {
    await ensureProductsLoaded()
    var qLower = q.toLowerCase()
    var products = window._allProducts.filter(function (p) {
      var code = (p.product_code || '').toLowerCase()
      var name = (p.product_name || p.display_name || '').toLowerCase()
      return code.includes(qLower) || name.includes(qLower)
    }).slice(0, 50)

    if (products.length === 0) {
      resultsEl.innerHTML = '<div style="padding:8px 12px; color:#6b7280; font-size:13px;">Tidak ada produk ditemukan.</div>'
      resultsEl.classList.remove('hidden')
      return
    }
    resultsEl.innerHTML = products.map(function (p, idx) {
      return '<div class="product-search-item" data-idx="' + idx + '" ' +
        'style="padding:8px 12px; cursor:pointer; border-bottom:1px solid #f3f4f6;">' +
        '<div style="font-weight:500;">' + escHtml(p.product_code || '\u2014') + ' \u2014 ' + escHtml(p.product_name || p.display_name || '\u2014') + '</div>' +
        '<div class="text-small text-muted">DBP: ' + formatNumberOrDash(p.dbp) + ' | Cost: ' + formatNumberOrDash(p.cost) + '</div>' +
        '</div>'
    }).join('')
    resultsEl.classList.remove('hidden')
    window._psmSearchResults = products
    resultsEl.querySelectorAll('.product-search-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var idx = parseInt(this.dataset.idx, 10)
        selectProduct(window._psmSearchResults[idx])
      })
      el.addEventListener('mouseover', function () { this.style.background = '#f9fafb' })
      el.addEventListener('mouseout',  function () { this.style.background = '' })
    })
  } catch (err) {
    resultsEl.innerHTML = '<div style="padding:8px 12px; color:#dc2626; font-size:13px;">Gagal mencari produk: ' + escHtml(err.message) + '</div>'
    resultsEl.classList.remove('hidden')
  }
}

function selectProduct(product) {
  selectedProduct = product
  hideAddItemError()

  var resultsEl = document.getElementById('product-search-results')
  resultsEl.classList.add('hidden')
  resultsEl.innerHTML = ''

  document.getElementById('input-product-search').value =
    (product.product_code || '') + ' — ' + (product.product_name || product.display_name || '')

  document.getElementById('selected-product-detail').innerHTML =
    '<dt>Product Code</dt>' + '<dd>' + escHtml(product.product_code || '—') + '</dd>' +
    '<dt>Product Name</dt>' + '<dd>' + escHtml(product.product_name || product.display_name || '—') + '</dd>' +
    '<dt>DBP</dt>'          + '<dd>' + formatNumberOrDash(product.dbp)  + '</dd>' +
    '<dt>Cost</dt>'         + '<dd>' + formatNumberOrDash(product.cost) + '</dd>'

  document.getElementById('selected-product-info').classList.remove('hidden')
}

// ─── Add Item submit ──────────────────────────────────────
document.getElementById('btn-add-item').addEventListener('click', async function () {
  var btn = this
  hideAddItemError()

  if (!selectedProduct || !selectedProduct.product_id) {
    showAddItemError('Pilih produk terlebih dahulu.')
    return
  }

  var qty = parseInt(document.getElementById('input-item-qty').value, 10)
  if (isNaN(qty) || qty < 1) {
    showAddItemError('Qty harus berupa bilangan bulat minimal 1.')
    return
  }

  var proposedPrice = parseFloat(document.getElementById('input-item-price').value)
  if (isNaN(proposedPrice) || proposedPrice < 0) {
    showAddItemError('Proposed Price harus berupa angka >= 0.')
    return
  }

  FCOS.setLoading(btn, 'Menambahkan...')
  try {
    await FCOS.api('fcos_addPsmItem', 'POST', {
      psm_id: psmId,
      product_id: selectedProduct.product_id,
      qty: qty,
      proposed_price: proposedPrice
    })

    resetAddItemForm()
    await loadDetail()
  } catch (err) {
    showAddItemError(err.message)
    FCOS.clearLoading(btn)
    btn.textContent = 'Add Item'
  }
})

function resetAddItemForm() {
  selectedProduct = null
  document.getElementById('input-product-search').value = ''
  document.getElementById('selected-product-info').classList.add('hidden')
  document.getElementById('selected-product-detail').innerHTML = ''
  document.getElementById('input-item-qty').value = 1
  document.getElementById('input-item-price').value = ''
  var resultsEl = document.getElementById('product-search-results')
  resultsEl.classList.add('hidden')
  resultsEl.innerHTML = ''

  var btn = document.getElementById('btn-add-item')
  FCOS.clearLoading(btn)
  btn.textContent = 'Add Item'
}

function showAddItemError(msg) {
  var el = document.getElementById('add-item-error')
  el.textContent = msg
  el.classList.remove('hidden')
}

function hideAddItemError() {
  var el = document.getElementById('add-item-error')
  el.textContent = ''
  el.classList.add('hidden')
}

// ─── Section 4: Approval Summary ─────────────────────────
function renderApprovalInfo(approval) {
  approval = approval || {}
  document.getElementById('approval-info').innerHTML =
    '<dt>Approval Status</dt>'  + '<dd>' + (approval.status ? psmStatusBadge(approval.status) : '—') + '</dd>' +
    '<dt>Current Approver</dt>' + '<dd>' + escHtml(approval.current_approver || '—')   + '</dd>' +
    '<dt>Approved By</dt>'      + '<dd>' + escHtml(approval.approved_by || '—')        + '</dd>' +
    '<dt>Approved At</dt>'      + '<dd>' + FCOS.formatDateTime(approval.approved_at)   + '</dd>' +
    '<dt>Rejected By</dt>'      + '<dd>' + escHtml(approval.rejected_by || '—')        + '</dd>' +
    '<dt>Rejected At</dt>'      + '<dd>' + FCOS.formatDateTime(approval.rejected_at)   + '</dd>' +
    '<dt>Decision Comment</dt>' + '<dd>' + escHtml(approval.decision_comment || '—')   + '</dd>'
}

// ─── Section 5: Approval History ─────────────────────────
function renderApprovalHistory(history) {
  var tbody = document.getElementById('history-body')
  if (history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="table-empty">Tidak ada riwayat.</td></tr>'
    return
  }
  tbody.innerHTML = history.map(function (h) {
    return '<tr>' +
      '<td class="text-small">' + escHtml(h.action || '—')               + '</td>' +
      '<td class="text-small">' + escHtml(h.actor_name || h.actor_uid || '—') + '</td>' +
      '<td>'                     + escHtml(h.comment || '—')              + '</td>' +
      '<td class="text-small">' + FCOS.formatDateTime(h.created_at)       + '</td>' +
      '</tr>'
  }).join('')
}

// ─── Approval Action (PSM-UI-3B) ─────────────────────────
function renderApprovalAction(data) {
  var card = document.getElementById('card-approval-action')
  if (data.can_approve === true) {
    card.classList.remove('hidden')
  } else {
    card.classList.add('hidden')
  }
}

var btnApprove = document.getElementById('btn-approve-psm')
if (btnApprove) {
  btnApprove.addEventListener('click', function () {
    if (!window.confirm('Approve this PSM?')) return
    doApprovalAction('APPROVE', this)
  })
}

var btnReject = document.getElementById('btn-reject-psm')
if (btnReject) {
  btnReject.addEventListener('click', function () {
    var comment = document.getElementById('input-approval-comment').value.trim()

    if (!comment) {
      showApprovalActionError('Comment is required for REJECT')
      return
    }

    if (!window.confirm('Reject this PSM?')) return
    doApprovalAction('REJECT', this)
  })
}

async function doApprovalAction(action, btn) {
  hideApprovalActionError()

  var comment = document.getElementById('input-approval-comment').value.trim()
  var requestId = (lastLoadedData.approval || {}).request_id

  var label = action === 'APPROVE' ? 'Approve' : 'Reject'
  FCOS.setLoading(btn, label + 'ing...')

  try {
    await FCOS.api('fcos_recordPsmApprovalAction', 'POST', {
      approval_request_id: requestId,
      action: action,
      comment: comment
    })
    await loadDetail()
  } catch (err) {
    showApprovalActionError(err.message)
    FCOS.clearLoading(btn)
    btn.textContent = label
  }
}

function showApprovalActionError(msg) {
  var el = document.getElementById('approval-action-error')
  el.textContent = msg
  el.classList.remove('hidden')
}

function hideApprovalActionError() {
  var el = document.getElementById('approval-action-error')
  el.textContent = ''
  el.classList.add('hidden')
}

// ─── Section 6: Caller Context ───────────────────────────
function renderCallerInfo(data) {
  document.getElementById('caller-info').innerHTML =
    '<dt>Caller Role</dt>'  + '<dd>' + escHtml(data.caller_role || '—')      + '</dd>' +
    '<dt>Can Edit</dt>'     + '<dd>' + formatBoolOrDash(data.can_edit)       + '</dd>' +
    '<dt>Can Submit</dt>'   + '<dd>' + formatBoolOrDash(data.can_submit)     + '</dd>' +
    '<dt>Can Recall</dt>'   + '<dd>' + formatBoolOrDash(data.can_recall)     + '</dd>' +
    '<dt>Can Approve</dt>'  + '<dd>' + formatBoolOrDash(data.can_approve)    + '</dd>'
}

// ─── Submit PSM (PSM-UI-3A) ──────────────────────────────
function renderSubmitButton(data) {
  var btn = document.getElementById('btn-submit-psm')
  if (data.can_submit === true) {
    btn.classList.remove('hidden')
  } else {
    btn.classList.add('hidden')
  }
}

// ─── Recall PSM (REJECTED -> DRAFT) ─────────────────────
function renderRecallButton(data) {
  var btn = document.getElementById('btn-recall-psm')
  if (!btn) return
  if (data.can_recall === true) {
    btn.classList.remove('hidden')
  } else {
    btn.classList.add('hidden')
  }
}
var btnRecall = document.getElementById('btn-recall-psm')
if (btnRecall) {
  btnRecall.addEventListener('click', function () {
    if (!window.confirm('Recall PSM ini? Status akan kembali ke Draft dan bisa diedit ulang.')) return
    doRecallPsm(this)
  })
}
async function doRecallPsm(btn) {
  FCOS.setLoading(btn, 'Recalling...')
  try {
    await FCOS.api('fcos_recallPsm', 'POST', { psm_id: psmId })
    await loadDetail()
  } catch (err) {
    alert('Gagal recall PSM: ' + err.message)
    FCOS.clearLoading(btn)
    btn.textContent = 'Recall & Revise'
  }
}

var btnSubmit = document.getElementById('btn-submit-psm')
if (btnSubmit) {
  btnSubmit.addEventListener('click', function () {
    var msg = 'Submit PSM?\n\n' +
      'This will send the PSM for approval. You will no longer be able to edit the PSM after submission.'

    if (!window.confirm(msg)) return

    doSubmitPsm(this)
  })
}

async function doSubmitPsm(btn) {
  hideSubmitPsmError()
  FCOS.setLoading(btn, 'Submitting...')

  // Step 1: Submit PSM (DRAFT -> SUBMITTED)
  try {
    await FCOS.api('fcos_submitPsm', 'POST', { psm_id: psmId })
  } catch (err) {
    showSubmitPsmError(err.message)
    FCOS.clearLoading(btn)
    btn.textContent = 'Submit PSM'
    return
  }

  // Step 2: Create approval request (links approval_request_id, approval.status = PENDING)
  try {
    await FCOS.api('fcos_createPsmApprovalRequest', 'POST', { psm_id: psmId })
  } catch (err) {
    await loadDetail()
    showSubmitPsmError(err.message)
    return
  }

  // Step 3: Both succeeded
  await loadDetail()
}

function showSubmitPsmError(msg) {
  var el = document.getElementById('submit-psm-error')
  el.textContent = msg
  el.classList.remove('hidden')
}

function hideSubmitPsmError() {
  var el = document.getElementById('submit-psm-error')
  el.textContent = ''
  el.classList.add('hidden')
}

// ─── Helpers ─────────────────────────────────────────────
function escHtml(str) {
  return String(str === undefined || str === null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escAttr(val) {
  if (val === undefined || val === null) return ''
  return escHtml(String(val))
}

function formatNumberOrDash(val) {
  if (val === undefined || val === null) return '—'
  return String(val)
}

// Reusable: Indonesian thousand-separator formatting for currency values.
// Returns '—' for null/undefined (consistent with formatNumberOrDash),
// otherwise formats with toLocaleString('id-ID') e.g. 2000000000 -> "2.000.000.000"
function formatCurrencyOrDash(val) {
  if (val === undefined || val === null) return '—'
  return Number(val).toLocaleString('id-ID')
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('id-ID')
}

function formatPercentOrDash(val) {
  if (val === undefined || val === null || isNaN(val)) return '—'
  return Math.round(val) + '%'
}

function formatBoolOrDash(val) {
  if (val === undefined || val === null) return '—'
  return val ? 'Yes' : 'No'
}

document.getElementById('btn-logout').addEventListener('click', function () {
  FCOS.logout()
})
