'use strict'

const users       = require('./users')
const matrix      = require('./matrix')
const salesBudget = require('./salesBudget')

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

exports.getSegmentList    = salesBudget.getSegmentList
exports.listSalesBudgets  = salesBudget.listSalesBudgets
exports.getSalesBudget    = salesBudget.getSalesBudget
exports.createSalesBudget = salesBudget.createSalesBudget
exports.updateSalesBudget = salesBudget.updateSalesBudget
exports.importSalesBudget = salesBudget.importSalesBudget
