;(function () {
  'use strict'

  var NAV = [
    { type: 'section', label: 'ADMINISTRASI', roles: ['SUPER_ADMIN', 'ADMIN'] },
    { label: 'User Registry',          href: '/users/list.html',                      roles: ['SUPER_ADMIN', 'ADMIN'] },
    { label: 'Organization Hierarchy', href: '/organization/list.html',               roles: ['SUPER_ADMIN'] },

    { type: 'section', label: 'PRODUCT', roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN', 'PRICING'] },
    { label: 'Product Registry',       href: '/products/list.html',                   roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN', 'PRICING'] },
    { label: 'Product Families',       href: '/products/families.html',               roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN', 'PRICING'] },
    { label: 'Family Mapping',         href: '/products/mapping.html',                roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN', 'PRICING'] },
    { label: 'Product Hierarchy',      href: '/products/hierarchy.html',              roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN', 'PRICING'] },
    { label: 'Import Products',        href: '/products/import.html',                 roles: ['SUPER_ADMIN', 'ADMIN'] },
    { label: 'Import History',         href: '/products/import-history.html',         roles: ['SUPER_ADMIN', 'ADMIN'] },

    { type: 'section', label: 'CUSTOMER', roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN'] },
    { label: 'Customer Registry',      href: '/customers/customer-registry.html',     roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN'] },
    { label: 'Customer Ship-To',       href: '/customers/ship-to.html',               roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN'] },

    { type: 'section', label: 'COMMERCIAL', roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN'] },
    { label: 'Sales Budget',           href: '/sales-budget/sales-budget.html',       roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN'] },
    { label: 'CPR Registry',           href: '/cpr/list.html',                        roles: ['SUPER_ADMIN', 'ADMIN'] },

    { type: 'section', label: 'PSM', roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN', 'SALES'] },
    { label: 'Price Special Management', href: '/psm/list.html',                      roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN', 'SALES'] },

    { type: 'section', label: 'PURCHASE ORDER', roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN'] },
    { label: 'PO Dashboard',           href: '/po/dashboard.html',                    roles: ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN'] },
    { label: 'Customer Invitations',   href: '/po/invitations.html',                  roles: ['SUPER_ADMIN', 'ADMIN'] },
  ]

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function buildSidebar(user) {
    var nav      = document.getElementById('sidebar-nav')
    if (!nav) return
    var userRoles = user.roles || []
    var current   = window.location.pathname

    nav.innerHTML = ''

    NAV.forEach(function (item) {
      var allowed = !item.roles || item.roles.some(function (r) { return userRoles.includes(r) })
      if (!allowed) return

      if (item.type === 'section') {
        var label = document.createElement('div')
        label.className   = 'sidebar__section-label'
        label.textContent = item.label
        nav.appendChild(label)
        return
      }

      var a = document.createElement('a')
      a.href      = item.href
      a.textContent = item.label
      if (current === item.href || current.startsWith(item.href.replace('.html', ''))) {
        a.classList.add('active')
      }
      nav.appendChild(a)
    })

    var footer = document.getElementById('sidebar-footer')
    if (footer) {
      footer.innerHTML =
        '<div>' + escHtml(user.name) + '</div>' +
        '<div class="mt-4 text-small">' + (window.FCOS ? FCOS.formatRoles(user.roles) : '') + '</div>'
    }
  }

  window.FCOS_SIDEBAR = { build: buildSidebar }
})()
