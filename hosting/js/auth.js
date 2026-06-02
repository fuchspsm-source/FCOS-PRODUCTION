'use strict'

window.FCOS = window.FCOS || {}

let _currentUser  = null
let _authToken    = null
let _tokenExpiry  = 0

async function getToken(firebaseUser) {
  const now = Date.now()
  const forceRefresh = (_tokenExpiry - now) < 5 * 60 * 1000
  const token = await firebaseUser.getIdToken(forceRefresh)
  _tokenExpiry = now + 55 * 60 * 1000
  _authToken   = token
  window.FCOS.authToken = token
  return token
}

function initPage(options = {}) {
  const { allowPending = false } = options

  return new Promise((resolve, reject) => {
    firebase.auth().onAuthStateChanged(async (firebaseUser) => {
      if (!firebaseUser) {
        window.location.href = '/login.html'
        return
      }

      try {
        await getToken(firebaseUser)
        const user = await FCOS.api('getMe', 'GET')

        if (user.status === 'INACTIVE') {
          window.location.href = '/access-denied.html'
          return
        }

        if (user.status === 'PENDING' && !allowPending) {
          window.location.href = '/waiting-approval.html'
          return
        }

        if (user.status === 'ACTIVE' && allowPending) {
          window.location.href = '/dashboard.html'
          return
        }

        _currentUser          = user
        window.FCOS.user      = user
        window.currentUser    = user

        document.dispatchEvent(new CustomEvent('fcos:userReady', { detail: user }))
        resolve(user)

      } catch (err) {
        console.error('[auth] initPage error:', err)
        window.location.href = '/login.html'
      }
    })
  })
}

function hasRole(...roles) {
  const userRoles = _currentUser?.roles || []
  return roles.some(r => userRoles.includes(r))
}

function requirePageRole(...roles) {
  if (!hasRole(...roles)) {
    window.location.href = '/access-denied.html'
  }
}

async function logout() {
  try {
    await firebase.auth().signOut()
  } finally {
    window.location.href = '/login.html'
  }
}

Object.assign(window.FCOS, {
  initPage,
  hasRole,
  requirePageRole,
  logout,
  getToken,
  get user()      { return _currentUser },
  get authToken() { return _authToken   }
})
