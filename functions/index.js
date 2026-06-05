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

const products   = require('./products')
const hierarchy  = require('./hierarchy')
const importEng  = require('./import')
const customers  = require('./customers')
const shipTo     = require('./shipTo')

exports.listProducts      = products.listProducts
exports.getProduct        = products.getProduct
exports.createProduct     = products.createProduct
exports.updateProduct     = products.updateProduct
exports.deactivateProduct = products.deactivateProduct
exports.reactivateProduct = products.reactivateProduct
exports.listFamilies      = products.listFamilies
exports.assignFamily      = products.assignFamily
exports.listMappings      = products.listMappings
exports.removeMapping     = products.removeMapping
exports.listProductCodes  = products.listProductCodes
exports.createProductCode = products.createProductCode
exports.updateProductCode = products.updateProductCode
exports.deleteProductCode = products.deleteProductCode

exports.listOrdos     = hierarchy.listOrdos
exports.createOrdo    = hierarchy.createOrdo
exports.updateOrdo    = hierarchy.updateOrdo
exports.deleteOrdo    = hierarchy.deleteOrdo
exports.listFamilies3C  = hierarchy.listFamilies3C
exports.createFamily3C  = hierarchy.createFamily3C
exports.updateFamily3C  = hierarchy.updateFamily3C
exports.deleteFamily3C  = hierarchy.deleteFamily3C
exports.listGenus     = hierarchy.listGenus
exports.createGenus   = hierarchy.createGenus
exports.updateGenus   = hierarchy.updateGenus
exports.deleteGenus   = hierarchy.deleteGenus
exports.listFamily    = hierarchy.listFamily
exports.updateFamily  = hierarchy.updateFamily
exports.deactivateFamily = hierarchy.deactivateFamily
exports.reactivateFamily = hierarchy.reactivateFamily

exports.createImportJob   = importEng.createImportJob
exports.submitImportRows  = importEng.submitImportRows
exports.validateImportJob = importEng.validateImportJob
exports.commitImportJob   = importEng.commitImportJob
exports.cancelImportJob   = importEng.cancelImportJob
exports.listImportJobs    = importEng.listImportJobs
exports.getImportJob      = importEng.getImportJob
exports.setRowDecision    = importEng.setRowDecision

exports.listCustomers      = customers.listCustomers
exports.createCustomer     = customers.createCustomer
exports.updateCustomer     = customers.updateCustomer
exports.activateCustomer   = customers.activateCustomer
exports.deactivateCustomer = customers.deactivateCustomer

exports.listShipTos      = shipTo.listShipTos
exports.createShipTo     = shipTo.createShipTo
exports.updateShipTo     = shipTo.updateShipTo
exports.activateShipTo   = shipTo.activateShipTo
exports.deactivateShipTo = shipTo.deactivateShipTo
exports.updateUserManager   = users.updateUserManager
exports.updateUserPosition  = users.updateUserPosition
