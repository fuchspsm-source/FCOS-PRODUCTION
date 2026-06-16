'use strict'

var currentStatus = ''
var currentCursor = null   // cursor used to load the CURRENT page (null = first page)
var cursorStack   = []     // stack of cursors for previous pages (for "Prev")
var nextCursor    = null   // cursor returned by API to load the NEXT page
var hasMore       = false
var lastItems     = []

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
  var label = PSM_STATUS_LABELS[status] || status
  var cls   = PSM_STATUS_CLASSES[status] || 'badge'
  return '<span class="' + cls + '">' + label + '</span>'
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

  loadPage(null, [])
})

// ─── Load a page of PSMs ─────────────────────────────────
async function loadPage(cursor, stack) {
  var tbody = document.getElementById('table-body')
  tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Loading PSM records...</td></tr>'
  try {
    var params = { page_size: 20 }
    if (currentStatus) params.status = currentStatus
    if (cursor) params.cursor = cursor

    var result = await FCOS.api('fcos_listPsms', 'GET', null, params)

    lastItems     = result.items || []
    hasMore       = !!result.has_more
    nextCursor    = result.cursor || null
    currentCursor = cursor
    cursorStack   = stack

    renderTable()
    renderPagination()
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty text-danger">' + escHtml(err.message) + '</td></tr>'
    document.getElementById('pagination').innerHTML = ''
  }
}

// ─── Render table ─────────────────────────────────────────
function renderTable() {
  document.getElementById('list-subtitle').textContent =
    lastItems.length + ' PSM' + (currentStatus ? ' (' + currentStatus.toLowerCase() + ')' : '')

  var tbody = document.getElementById('table-body')
  if (lastItems.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No PSM records found.</td></tr>'
    return
  }

  tbody.innerHTML = lastItems.map(function (p) {
    return '<tr>' +
      '<td class="text-small">' + escHtml(p.psm_number || '—') + '</td>' +
      '<td>' + escHtml(p.customer_name || '—') + '</td>' +
      '<td>' + psmStatusBadge(p.status) + '</td>' +
      '<td class="text-small">' + escHtml(p.created_by || '—') + '</td>' +
      '<td class="text-small">' + FCOS.formatDateTime(p.created_at) + '</td>' +
      '<td style="white-space:nowrap;">' +
        '<a class="btn btn--secondary btn--sm" href="/psm/detail.html?psm_id=' + encodeURIComponent(p.psm_id) + '">View</a>' +
      '</td>' +
      '</tr>'
  }).join('')
}

// ─── Pagination (cursor-based) ───────────────────────────
function renderPagination() {
  var el = document.getElementById('pagination')
  var html = ''

  if (cursorStack.length > 0) {
    html += '<button class="btn btn--secondary btn--sm" id="btn-prev">← Prev</button>'
  }
  if (hasMore) {
    html += '<button class="btn btn--secondary btn--sm" id="btn-next">Next →</button>'
  }

  el.innerHTML = html

  var btnPrev = document.getElementById('btn-prev')
  var btnNext = document.getElementById('btn-next')

  if (btnPrev) {
    btnPrev.addEventListener('click', function () {
      var stack = cursorStack.slice()
      var prevCursor = stack.pop()
      loadPage(prevCursor || null, stack)
    })
  }
  if (btnNext) {
    btnNext.addEventListener('click', function () {
      var stack = cursorStack.concat([currentCursor])
      loadPage(nextCursor, stack)
    })
  }
}

// ─── Status filter ────────────────────────────────────────
document.getElementById('filter-status').addEventListener('click', function (e) {
  var tab = e.target.closest('.filter-tab')
  if (!tab) return
  document.querySelectorAll('#filter-status .filter-tab').forEach(function (t) { t.classList.remove('active') })
  tab.classList.add('active')
  currentStatus = tab.dataset.status
  loadPage(null, [])
})

// ─── New PSM ───────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', function () {
  window.location.href = '/psm/draft.html'
})

// ─── Logout ──────────────────────────────────────────────
document.getElementById('btn-logout').addEventListener('click', function () { FCOS.logout() })

// ─── Helpers ─────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
