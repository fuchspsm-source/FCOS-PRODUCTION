'use strict'

;(function () {

  var hostname = window.location.hostname
  var IS_DEV   = (hostname === 'localhost' || hostname === '127.0.0.1')

  var DEV_CONFIG = {
    apiKey            : 'FCOS_DEV_API_KEY',
    authDomain        : 'fcos-dev.firebaseapp.com',
    projectId         : 'fcos-dev',
    storageBucket     : 'fcos-dev.appspot.com',
    messagingSenderId : 'FCOS_DEV_SENDER_ID',
    appId             : 'FCOS_DEV_APP_ID'
  }

  var PROD_CONFIG = {
    apiKey            : 'AIzaSyCd24ibHeKOCs36AmOBuuauOKjFveLYwE0',
    authDomain        : 'fcos-production.firebaseapp.com',
    projectId         : 'fcos-production',
    storageBucket     : 'fcos-production.firebasestorage.app',
    messagingSenderId : '13476752455',
    appId             : '1:13476752455:web:daa01bb2f1f3f72dc49562'
  }

  var DEV_FUNCTIONS_URL  = 'http://127.0.0.1:5001/fcos-dev/us-central1'
  var PROD_FUNCTIONS_URL = 'https://us-central1-fcos-production.cloudfunctions.net'

  var config       = IS_DEV ? DEV_CONFIG       : PROD_CONFIG
  var functionsUrl = IS_DEV ? DEV_FUNCTIONS_URL : PROD_FUNCTIONS_URL

  if (!firebase.apps.length) {
    firebase.initializeApp(config)
  }

  window.FCOS_CONFIG = {
    functionsBaseUrl : functionsUrl,
    isDev            : IS_DEV
  }

  window.FCOS = window.FCOS || {}

})()
