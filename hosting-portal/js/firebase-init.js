'use strict'

;(function () {
  var hostname = window.location.hostname
  var IS_DEV   = (hostname === 'localhost' || hostname === '127.0.0.1')

  var PROD_CONFIG = {
    apiKey            : 'AIzaSyCd24ibHeKOCs36AmOBuuauOKjFveLYwE0',
    authDomain        : 'fcos-production.firebaseapp.com',
    projectId         : 'fcos-production',
    storageBucket     : 'fcos-production.firebasestorage.app',
    messagingSenderId : '13476752455',
    appId             : '1:13476752455:web:daa01bb2f1f3f72dc49562'
  }

  var PROD_FUNCTIONS_URL = 'https://us-central1-fcos-production.cloudfunctions.net'
  var DEV_FUNCTIONS_URL  = 'http://127.0.0.1:5001/fcos-production/us-central1'

  var config       = PROD_CONFIG
  var functionsUrl = IS_DEV ? DEV_FUNCTIONS_URL : PROD_FUNCTIONS_URL

  if (!firebase.apps.length) {
    firebase.initializeApp(config)
  }

  window.PORTAL_CONFIG = {
    functionsBaseUrl : functionsUrl,
    isDev            : IS_DEV
  }

  window.PORTAL = window.PORTAL || {}
})()
