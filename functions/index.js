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
exports.fcos_searchProducts  = products.searchProducts
exports.fcos_listAllProducts = products.listAllProducts
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
exports.getShipTosByCustomer = shipTo.getShipTosByCustomer
exports.updateUserManager   = users.updateUserManager
exports.updateUserPosition  = users.updateUserPosition
const positions = require('./positions')
exports.getPositions = positions.getPositions
exports.createPosition = positions.createPosition
exports.updatePosition = positions.updatePosition
exports.deactivatePosition = positions.deactivatePosition
exports.reactivatePosition = positions.reactivatePosition
exports.updateUserAuthorityRank = users.updateUserAuthorityRank
exports.updateUserPosition = users.updateUserPosition
exports.updateUserManager = users.updateUserManager
exports.updateUserRoles = users.updateUserRoles

const approvalMatrix = require('./approvalMatrix')
exports.getApprovalMatrix = approvalMatrix.getApprovalMatrix
exports.createMatrixDraft = approvalMatrix.createMatrixDraft
exports.updateMatrixDraft = approvalMatrix.updateMatrixDraft
exports.deleteMatrixDraft = approvalMatrix.deleteMatrixDraft
exports.publishMatrix = approvalMatrix.publishMatrix

const delegations = require('./delegations')
exports.getDelegations = delegations.getDelegations
exports.createDelegation = delegations.createDelegation
exports.deactivateDelegation = delegations.deactivateDelegation
exports.seedPositions = positions.seedPositions
exports.seedApprovalMatrix      = approvalMatrix.seedApprovalMatrix
exports.seedApprovalMatrixRules = approvalMatrix.seedApprovalMatrixRules

const approvalRequests = require('./approvalRequests')
exports.fcos_createApprovalRequest = approvalRequests.createApprovalRequest

const approvalActions = require('./approvalActions')
exports.fcos_recordApprovalAction = approvalActions.recordApprovalAction

// Package 3C-3: Approver Inbox
const approvalInbox = require('./approvalInbox')
exports.fcos_getApproverInbox = approvalInbox.getApproverInbox

// Package 3C-4: Approval Detail Screen
const approvalDetail = require('./approvalDetail')
exports.fcos_getApprovalDetail = approvalDetail.getApprovalDetail

// Package PSM-2: Create PSM Draft
const psmRequests = require('./psmRequests')
exports.fcos_createPsmDraft = psmRequests.createPsmDraft

// Package PSM-3: Save PSM Header
exports.fcos_savePsmHeader = psmRequests.savePsmHeader

// Package PSM-4A: Product Search
exports.fcos_searchProducts = products.searchProducts

// Package PSM-4B: Add PSM Item
exports.fcos_addPsmItem = require('./psmRequests').addPsmItem

// Package PSM-4C: Remove PSM Item
exports.fcos_removePsmItem = require('./psmRequests').removePsmItem

// Package PSM-5: Submit PSM
exports.fcos_submitPsm = require('./psmRequests').submitPsm

// Package PSM-6: Create PSM Approval Request
exports.fcos_createPsmApprovalRequest = require('./psmRequests').createPsmApprovalRequest

// Package PSM-7: Record PSM Approval Action
exports.fcos_recordPsmApprovalAction = require('./psmRequests').recordPsmApprovalAction

// Package PSM-8: Sync Approval Result
exports.fcos_syncApprovalResult = require('./psmRequests').syncApprovalResult

// Package PSM-9: Recall PSM
exports.fcos_recallPsm = require('./psmRequests').recallPsm

// Package PSM-RM-1: List PSMs
exports.fcos_listPsms   = require('./psmRead').listPsms
exports.fcos_listMyPsms = require('./psmRead').listMyPsms

// Package PSM-RM-2: Get PSM Detail
exports.fcos_getPsmDetail = require('./psmRead').getPsmDetail

// Package PSM-PDF-1C: Get PSM PDF
exports.fcos_getPsmPdf = require('./psmRead').getPsmPdf


exports.fcos_resolveCprPrice = require('./cpr/resolveCprPrice').resolveCprPrice
exports.fcos_listCprRecords = require('./cpr/listCprRecords').listCprRecords

// PO-2: Segment Master
const segments = require('./segments')
exports.listSegments   = segments.listSegments
exports.getSegment     = segments.getSegment
exports.createSegment  = segments.createSegment
exports.updateSegment  = segments.updateSegment

// PO-6: Save PO
const po = require('./po')
exports.savePo  = po.savePo
exports.getPoPdf = po.getPoPdf

// PO-FE-2: Customer Invitation Flow
exports.createCustomerInvitation = require('./portal/createCustomerInvitation').createCustomerInvitation
exports.acceptCustomerInvitation = require('./portal/acceptCustomerInvitation').acceptCustomerInvitation

// PO-FE-3: Portal Session Validation
exports.portalWhoAmI = require('./portal/portalWhoAmI').portalWhoAmI

// PO-FE-4: Portal Bootstrap
exports.portalBootstrap = require('./portal/portalBootstrap').portalBootstrap

// PO-FE-5: Portal Product Search
exports.portalSearchProducts  = require('./portal/portalSearchProducts').portalSearchProducts
exports.portalListAllProducts = require('./portal/portalListAllProducts').portalListAllProducts

// PO-FE-6: Portal Price Resolver
exports.portalResolvePrice = require('./portal/portalResolvePrice').portalResolvePrice

// PO-FE-7B: Portal Save PO
exports.portalSavePo = require('./portal/portalSavePo').portalSavePo

// PO-FE-8: Portal PDF
exports.portalGetPoPdf = require('./portal/portalGetPoPdf').portalGetPoPdf

// PO-UI-3: Portal List Segments
exports.portalListSegments  = require('./portal/portalListSegments').portalListSegments
exports.portalListSalesReps = require('./portal/portalListSalesReps').portalListSalesReps
exports.portalListPos      = require('./portal/portalListPos').portalListPos
exports.fcos_listAllPos    = require('./po/listAllPos').listAllPos
exports.fcos_getPoDetail   = require('./po/getPoDetail').getPoDetail
