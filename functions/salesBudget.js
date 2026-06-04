'use strict'

const { onRequest }                           = require('firebase-functions/v2/https')
const { db, admin }                           = require('./db')
const { requireAuth, requireActive, requireRole } = require('./middleware')
const { writeAudit }                          = require('./audit')
const { ROLES }                               = require('./constants')

const FieldValue = admin.firestore.FieldValue

const BUDGET_SEGMENTS = [
  'AAM (Not Assigned)','AAM (Two Wheeler)','AAM Passenger Car',
  'Industry (Automotive MFG)','Industry (Not Assigned)',
  'MINING (Cement Ind.)','MINING (Not Assigned)','MINING (Soft Rock)',
  'OEM (Commercial Vehicle MFG)','OEM (Off Highway Equipment MFG)','OEM (Passenger Car MFG)',
  'Specialties (Food Ind.)','Specialties (Not Assigned)','Specialties (Packaging Materials)'
]

const MONTH_KEYS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']

const AUDIT_KEYS = { CREATED:'BUDGET_CREATED', UPDATED:'BUDGET_UPDATED', IMPORTED:'BUDGET_IMPORTED' }

function run(middlewares, handler) {
  return onRequest(async (req, res) => {
    let idx = 0
    const next = async () => {
      const mw = middlewares[idx++]
      if (mw) { const r = mw(req,res,next); if (r&&typeof r.then==='function') await r }
      else await handler(req, res)
    }
    await next()
  })
}

function computeTotal(m) { return MONTH_KEYS.reduce((s,k)=>s+(Number(m[k])||0),0) }

function extractMonths(body) {
  const months = {}
  for (const m of MONTH_KEYS) {
    const v = body[m]
    const n = (v===undefined||v===null||v==='') ? 0 : Number(v)
    if (isNaN(n)||n<0) return { error:`Invalid value for ${m}` }
    months[m] = n
  }
  return { months }
}

async function checkDuplicate(year, customerCode, budgetSegment, excludeId=null) {
  const snap = await db.collection('salesBudgets')
    .where('year','==',year).where('customerCode','==',customerCode)
    .where('budgetSegment','==',budgetSegment).get()
  if (snap.empty) return false
  if (excludeId) return snap.docs.some(d=>d.id!==excludeId)
  return true
}

async function validateCustomer(customerCode) {
  const snap = await db.collection('customers').where('customerCode','==',customerCode).limit(1).get()
  return !snap.empty
}

exports.getSegmentList = run([requireAuth,requireActive], async(req,res)=>{
  if (req.method!=='GET') return res.status(405).json({error:'Method not allowed'})
  return res.status(200).json({segments:BUDGET_SEGMENTS,count:BUDGET_SEGMENTS.length})
})

exports.listSalesBudgets = run([requireAuth,requireActive], async(req,res)=>{
  if (req.method!=='GET') return res.status(405).json({error:'Method not allowed'})
  try {
    const {year,customerCode,segment} = req.query
    let q = db.collection('salesBudgets')
    if (year)         q = q.where('year','==',Number(year))
    if (customerCode) q = q.where('customerCode','==',customerCode)
    if (segment)      q = q.where('budgetSegment','==',segment)
    q = q.orderBy('customerCode').orderBy('budgetSegment')
    const snap = await q.get()
    const records = snap.docs.map(d=>({id:d.id,...d.data()}))
    return res.status(200).json({records,count:records.length})
  } catch(err) { console.error('[salesBudget] list:',err); return res.status(500).json({error:'Internal error'}) }
})

exports.getSalesBudget = run([requireAuth,requireActive], async(req,res)=>{
  if (req.method!=='GET') return res.status(405).json({error:'Method not allowed'})
  try {
    const id = req.path.split('/').filter(Boolean).pop()
    if (!id) return res.status(400).json({error:'Missing id'})
    const snap = await db.collection('salesBudgets').doc(id).get()
    if (!snap.exists) return res.status(404).json({error:'Not found'})
    return res.status(200).json({id:snap.id,...snap.data()})
  } catch(err) { return res.status(500).json({error:'Internal error'}) }
})

exports.createSalesBudget = run(
  [requireAuth,requireActive,requireRole(ROLES.SUPER_ADMIN,ROLES.COMMERCIAL_ADMIN)],
  async(req,res)=>{
    if (req.method!=='POST') return res.status(405).json({error:'Method not allowed'})
    try {
      const {year,customerCode,budgetSegment} = req.body
      if (!year)          return res.status(400).json({error:'year is required'})
      if (!customerCode)  return res.status(400).json({error:'customerCode is required'})
      if (!budgetSegment) return res.status(400).json({error:'budgetSegment is required'})
      const yearNum = Number(year)
      if (isNaN(yearNum)||yearNum<2000||yearNum>2100) return res.status(400).json({error:'Invalid year'})
      if (!BUDGET_SEGMENTS.includes(budgetSegment)) return res.status(400).json({error:'Invalid budgetSegment. Must be one of the 14 defined segments.'})
      if (!await validateCustomer(customerCode)) return res.status(404).json({error:`Customer ${customerCode} not found`})
      if (await checkDuplicate(yearNum,customerCode,budgetSegment)) return res.status(409).json({error:`Budget already exists for year=${yearNum}, customer=${customerCode}, segment=${budgetSegment}`})
      const {months,error:monthErr} = extractMonths(req.body)
      if (monthErr) return res.status(400).json({error:monthErr})
      const totalBudget = computeTotal(months)
      const now = FieldValue.serverTimestamp()
      const docRef = db.collection('salesBudgets').doc()
      await docRef.set({year:yearNum,customerCode,budgetSegment,...months,totalBudget,createdAt:now,createdBy:req.user.uid,updatedAt:now,updatedBy:req.user.uid})
      await writeAudit(AUDIT_KEYS.CREATED,req.user.uid,docRef.id,{year:yearNum,customerCode,budgetSegment,totalBudget})
      return res.status(201).json({ok:true,id:docRef.id})
    } catch(err) { console.error('[salesBudget] create:',err); return res.status(500).json({error:'Internal error'}) }
  }
)

exports.updateSalesBudget = run(
  [requireAuth,requireActive,requireRole(ROLES.SUPER_ADMIN)],
  async(req,res)=>{
    if (req.method!=='POST') return res.status(405).json({error:'Method not allowed'})
    try {
      const {id} = req.body
      if (!id) return res.status(400).json({error:'id is required'})
      const docRef = db.collection('salesBudgets').doc(id)
      const snap = await docRef.get()
      if (!snap.exists) return res.status(404).json({error:'Not found'})
      const existing = snap.data()
      const {months,error:monthErr} = extractMonths(req.body)
      if (monthErr) return res.status(400).json({error:monthErr})
      const totalBudget = computeTotal(months)
      const oldValues = {}, newValues = {}
      for (const m of MONTH_KEYS) {
        const o=existing[m]||0, n=months[m]
        if (o!==n) { oldValues[m]=o; newValues[m]=n }
      }
      if ((existing.totalBudget||0)!==totalBudget) { oldValues.totalBudget=existing.totalBudget||0; newValues.totalBudget=totalBudget }
      const now = FieldValue.serverTimestamp()
      await docRef.update({...months,totalBudget,updatedAt:now,updatedBy:req.user.uid})
      await writeAudit(AUDIT_KEYS.UPDATED,req.user.uid,id,{year:existing.year,customerCode:existing.customerCode,budgetSegment:existing.budgetSegment,oldValues,newValues,changedAt:new Date().toISOString(),changedBy:req.user.uid})
      return res.status(200).json({ok:true})
    } catch(err) { console.error('[salesBudget] update:',err); return res.status(500).json({error:'Internal error'}) }
  }
)

exports.importSalesBudget = run(
  [requireAuth,requireActive,requireRole(ROLES.SUPER_ADMIN,ROLES.COMMERCIAL_ADMIN)],
  async(req,res)=>{
    if (req.method!=='POST') return res.status(405).json({error:'Method not allowed'})
    try {
      const {year,rows} = req.body
      if (!year) return res.status(400).json({error:'year is required'})
      const yearNum = Number(year)
      if (isNaN(yearNum)||yearNum<2000||yearNum>2100) return res.status(400).json({error:'Invalid year'})
      if (!Array.isArray(rows)||rows.length===0) return res.status(400).json({error:'rows must be a non-empty array'})
      const grouped = {}
      for (const [idx,row] of rows.entries()) {
        const {customerCode,budgetSegment} = row
        if (!customerCode)  return res.status(400).json({error:`Row ${idx+1}: customerCode required`})
        if (!budgetSegment) return res.status(400).json({error:`Row ${idx+1}: budgetSegment required`})
        if (!grouped[customerCode]) grouped[customerCode]=[]
        grouped[customerCode].push(row)
      }
      const rejected=[], accepted=[]
      for (const [code,cRows] of Object.entries(grouped)) {
        const segs=cRows.map(r=>r.budgetSegment)
        const unknown=segs.filter(s=>!BUDGET_SEGMENTS.includes(s))
        if (unknown.length) { rejected.push({customerCode:code,reason:`Unknown segment(s): ${[...new Set(unknown)].join(', ')}`}); continue }
        const seen=new Set(); let dup=false
        for (const s of segs){if(seen.has(s)){dup=true;break}seen.add(s)}
        if (dup) { rejected.push({customerCode:code,reason:'Duplicate segment entries'}); continue }
        const missing=BUDGET_SEGMENTS.filter(s=>!segs.includes(s))
        if (missing.length) { rejected.push({customerCode:code,reason:`Missing segments: ${missing.join(', ')}`}); continue }
        accepted.push({customerCode:code,rows:cRows})
      }
      if (accepted.length===0) return res.status(422).json({ok:false,message:'All customers rejected.',rejected})
      const userRoles=req.user.roles||[]
      const isSuperAdmin=userRoles.includes(ROLES.SUPER_ADMIN)
      const toWrite=[]
      for (const entry of accepted) {
        const exists=await validateCustomer(entry.customerCode)
        if (!exists) { rejected.push({customerCode:entry.customerCode,reason:'Customer not found in registry'}); continue }
        let conflict=false
        const entryDocs=[]
        for (const row of entry.rows) {
          const {months,error:monthErr}=extractMonths(row)
          if (monthErr) { rejected.push({customerCode:entry.customerCode,reason:`${monthErr}`}); conflict=true; break }
          const existSnap=await db.collection('salesBudgets').where('year','==',yearNum).where('customerCode','==',entry.customerCode).where('budgetSegment','==',row.budgetSegment).limit(1).get()
          if (!existSnap.empty&&!isSuperAdmin) { conflict=true; break }
          const existingDocId=!existSnap.empty?existSnap.docs[0].id:null
          const now=FieldValue.serverTimestamp()
          entryDocs.push({docId:existingDocId,isUpdate:!!existingDocId,data:{year:yearNum,customerCode:entry.customerCode,budgetSegment:row.budgetSegment,...months,totalBudget:computeTotal(months),updatedAt:now,updatedBy:req.user.uid,...(existingDocId?{}:{createdAt:now,createdBy:req.user.uid})}})
        }
        if (conflict) { rejected.push({customerCode:entry.customerCode,reason:'Existing budget found. Only SUPER_ADMIN may overwrite existing budgets.'}); continue }
        toWrite.push(...entryDocs)
      }
      if (toWrite.length===0) return res.status(422).json({ok:false,message:'No records to write.',rejected})
      const CHUNK=400
      for (let i=0;i<toWrite.length;i+=CHUNK) {
        const batch=db.batch()
        for (const w of toWrite.slice(i,i+CHUNK)) {
          const ref=w.docId?db.collection('salesBudgets').doc(w.docId):db.collection('salesBudgets').doc()
          w.isUpdate?batch.update(ref,w.data):batch.set(ref,w.data)
        }
        await batch.commit()
      }
      await writeAudit(AUDIT_KEYS.IMPORTED,req.user.uid,`year_${yearNum}`,{year:yearNum,written:toWrite.length,rejectedCount:rejected.length})
      return res.status(200).json({ok:true,written:toWrite.length,rejectedCount:rejected.length,rejected:rejected.length>0?rejected:undefined})
    } catch(err) { console.error('[salesBudget] import:',err); return res.status(500).json({error:'Internal error'}) }
  }
)
