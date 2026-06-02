'use strict'

const admin = require('firebase-admin')
const path  = require('path')

const serviceAccountPath = path.join(__dirname, 'service-account.json')

try {
  const serviceAccount = require(serviceAccountPath)
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  })
} catch (e) {
  admin.initializeApp()
}

const auth = admin.auth()
const db   = admin.firestore()

const BOOTSTRAP_USER = {
  email    : 'fuchs.psm@gmail.com',
  password : 'Fuchs100',
  name     : 'FCOS Super Admin',
  roles    : ['SUPER_ADMIN'],
  status   : 'ACTIVE'
}

async function bootstrap() {
  console.log('FCOS Bootstrap starting...')
  console.log(`Target email: ${BOOTSTRAP_USER.email}`)

  const existing = await db.collection('users')
    .where('email', '==', BOOTSTRAP_USER.email)
    .limit(1)
    .get()

  if (!existing.empty) {
    console.log('Bootstrap account already exists. Nothing to do.')
    console.log('uid:', existing.docs[0].id)
    process.exit(0)
  }

  let userRecord
  try {
    userRecord = await auth.createUser({
      email         : BOOTSTRAP_USER.email,
      password      : BOOTSTRAP_USER.password,
      displayName   : BOOTSTRAP_USER.name,
      emailVerified : true
    })
    console.log('Firebase Auth account created. uid:', userRecord.uid)
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      userRecord = await auth.getUserByEmail(BOOTSTRAP_USER.email)
      console.log('Firebase Auth account already exists. uid:', userRecord.uid)
      console.log('Proceeding to create missing Firestore record...')
    } else {
      throw err
    }
  }

  await db.collection('users').doc(userRecord.uid).set({
    name        : BOOTSTRAP_USER.name,
    email       : BOOTSTRAP_USER.email,
    status      : BOOTSTRAP_USER.status,
    roles       : BOOTSTRAP_USER.roles,
    created_at  : admin.firestore.FieldValue.serverTimestamp(),
    approved_at : admin.firestore.FieldValue.serverTimestamp(),
    approved_by : 'system'
  })

  console.log('Firestore record created.')
  console.log('Bootstrap complete.')
  console.log('uid   :', userRecord.uid)
  console.log('email :', BOOTSTRAP_USER.email)
  console.log('roles :', BOOTSTRAP_USER.roles)
  console.log('status:', BOOTSTRAP_USER.status)
}

bootstrap()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Bootstrap failed:', err)
    process.exit(1)
  })
