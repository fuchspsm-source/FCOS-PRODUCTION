'use strict'

const users  = require('./users')
const matrix = require('./matrix')

exports.register = users.register
exports.getMe    = users.getMe

exports.listUsers       = users.listUsers
exports.getUser         = users.getUser
exports.approveUser     = users.approveUser
exports.updateUserRoles = users.updateUserRoles
exports.deactivateUser  = users.deactivateUser
exports.reactivateUser  = users.reactivateUser

exports.listMatrix   = matrix.listMatrix
exports.getMatrix    = matrix.getMatrix
exports.createMatrix = matrix.createMatrix
exports.closeMatrix  = matrix.closeMatrix
