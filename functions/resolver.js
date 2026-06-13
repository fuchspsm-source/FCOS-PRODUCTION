'use strict'

const { db, admin } = require('./db')

const MAX_TRAVERSAL_DEPTH = 200

function makeError(code, message) {
  const err = new Error(message)
  err.code  = code
  return err
}

async function resolveApprover(submitter_uid, nc_value) {

  const submitterSnap = await db.collection('users').doc(submitter_uid).get()
  if (!submitterSnap.exists) {
    throw makeError('SUBMITTER_NOT_FOUND', `Submitter not found: ${submitter_uid}`)
  }
  const submitter = submitterSnap.data()
  if (submitter.status !== 'ACTIVE') {
    throw makeError('SUBMITTER_INACTIVE', `Submitter is not ACTIVE: ${submitter_uid}`)
  }

  if (!submitter.manager_user_id) {
    throw makeError('APPROVAL_CHAIN_BROKEN', `Submitter has no manager_user_id: ${submitter_uid}`)
  }

  const versionSnap = await db.collection('approval_matrix_versions')
    .where('is_active', '==', true)
    .get()

  if (versionSnap.size === 0) {
    throw makeError('APPROVAL_CHAIN_BROKEN', 'No active approval matrix version found')
  }
  if (versionSnap.size > 1) {
    throw makeError('APPROVAL_CHAIN_BROKEN', 'Multiple active approval matrix versions found')
  }

  const versionDoc     = versionSnap.docs[0]
  const matrix_version = versionDoc.id

  const bandsSnap = await db.collection('approval_matrix')
    .where('matrix_version_id', '==', matrix_version)
    .get()

  let required_authority_rank = null

  for (const bandDoc of bandsSnap.docs) {
    const band = bandDoc.data()
    const aboveMin = (band.min_nc_value === null || nc_value >= band.min_nc_value)
    const belowMax = (band.max_nc_value === null || nc_value <  band.max_nc_value)
    if (aboveMin && belowMax) {
      required_authority_rank = band.required_authority_rank
      break
    }
  }

  if (required_authority_rank === null) {
    throw makeError('APPROVAL_CHAIN_BROKEN', `No matching approval band for nc_value: ${nc_value}`)
  }

  let   current_uid     = submitter.manager_user_id
  const visited         = new Set()
  const resolution_path = []
  let   depth           = 0

  while (true) {

    if (current_uid === null || current_uid === undefined) {
      throw makeError('APPROVAL_CHAIN_BROKEN', 'Approval chain ended before a match was found')
    }

    if (depth >= MAX_TRAVERSAL_DEPTH) {
      throw makeError('APPROVAL_CHAIN_MAX_DEPTH_EXCEEDED',
        `Traversal exceeded MAX_TRAVERSAL_DEPTH (${MAX_TRAVERSAL_DEPTH})`)
    }

    if (visited.has(current_uid)) {
      throw makeError('APPROVAL_CHAIN_CYCLE_DETECTED',
        `Cycle detected at user: ${current_uid}`)
    }

    visited.add(current_uid)
    depth++

    const userSnap = await db.collection('users').doc(current_uid).get()
    if (!userSnap.exists) {
      throw makeError('APPROVAL_CHAIN_BROKEN', `User not found in chain: ${current_uid}`)
    }
    const user = userSnap.data()

    if (!user.position_id) {
      throw makeError('APPROVAL_CHAIN_BROKEN', `User has no position_id: ${current_uid}`)
    }
    const posSnap = await db.collection('positions').doc(user.position_id).get()
    if (!posSnap.exists) {
      throw makeError('APPROVAL_CHAIN_BROKEN', `Position not found: ${user.position_id} for user: ${current_uid}`)
    }
    const candidateRank = posSnap.data().authority_rank

    resolution_path.push({
      user_id:   current_uid,
      user_name: user.name,
      rank:      candidateRank,
      matched:   false,
      status:    user.status,
    })

    if (user.status === 'ACTIVE' && candidateRank >= required_authority_rank) {
      resolution_path[resolution_path.length - 1].matched = true

      return {
        matrix_version,
        required_authority_rank,
        authority_owner_id:   current_uid,
        authority_owner_name: user.name,
        authority_owner_rank: candidateRank,
        resolution_path,
        resolved_at: admin.firestore.Timestamp.now(),
      }
    }

    current_uid = user.manager_user_id
  }

  throw makeError('NO_QUALIFYING_APPROVER_FOUND', 'No qualifying approver found in chain')
}

module.exports = { resolveApprover }
