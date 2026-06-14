'use strict'

window.PORTAL = window.PORTAL || {}

let _portalUser  = null
let _authToken   = null
let _tokenExpiry = 0

async function getToken(firebaseUser) {
  const now          = Date.now()
  const forceRefresh = (_tokenExpiry - now) < 5 * 60 * 1000
  const token        = await firebaseUser.getIdToken(forceRefresh)
  _tokenExpiry       = now + 55 * 60 * 1000
  _authToken         = token
  window.PORTAL.authToken = token
  return token
}

// initPage — call on every protected portal page
// Returns promise that resolves with portalUser on success
// Redirects to /login.html if not authenticated
// Redirects to /access-denied.html if FCOS user (not in customer_users)
function initPage() {
  return new Promise((resolve, reject) => {
    firebase.auth().onAuthStateChanged(async (firebaseUser) => {
      if (!firebaseUser) {
        window.location.href = '/login.html'
        return
      }

      try {
        await getToken(firebaseUser)
        // portalWhoAmI loads customer_users/{uid} — rejects FCOS internal users
        const me = await PORTAL.api('portalWhoAmI', 'GET')
        if (!me) return // api() already redirected on error

        _portalUser             = me
        window.PORTAL.user      = me
        window.PORTAL.authToken = _authToken

        resolve(me)

      } catch (err) {
        console.error('[portal-auth] initPage:', err)
        window.location.href = '/login.html'
      }
    })
  })
}

async function logout() {
  try {
    await firebase.auth().signOut()
  } finally {
    window.location.href = '/login.html'
  }
}

Object.assign(window.PORTAL, {
  initPage,
  logout,
  getToken,
  get user()      { return _portalUser },
  get authToken() { return _authToken  }
})
