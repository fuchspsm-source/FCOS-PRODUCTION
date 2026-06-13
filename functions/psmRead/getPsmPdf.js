'use strict'
const { onRequest }                  = require('firebase-functions/v2/https')
const { db }                         = require('../db')
const { requireAuth, requireActive } = require('../middleware')
const PDFDocument                    = require('pdfkit')

const REGION      = 'us-central1'
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN', 'COMMERCIAL_ADMIN']

function run(middlewares, handler) {
  return async (req, res) => {
    for (const mw of middlewares) {
      let next = false
      await mw(req, res, () => { next = true })
      if (!next) return
    }
    return handler(req, res)
  }
}

function toISO(ts) {
  if (!ts)                             return null
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString()
  if (ts instanceof Date)              return ts.toISOString()
  return String(ts)
}

function fmtDate(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  const day   = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year  = d.getFullYear()
  const hh    = String(d.getHours()).padStart(2, '0')
  const mm    = String(d.getMinutes()).padStart(2, '0')
  return `${day}/${month}/${year} ${hh}:${mm}`
}

function fmtCurrency(num) {
  if (num === null || num === undefined || isNaN(num)) return '-'
  return Number(num).toLocaleString('id-ID', { maximumFractionDigits: 0 })
}

function fmtPercent(num) {
  if (num === null || num === undefined || isNaN(num)) return '-'
  return Number(num).toFixed(2) + '%'
}

function fmtNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '-'
  return Number(num).toLocaleString('id-ID', { maximumFractionDigits: 0 })
}

async function getUserDisplayName(uid) {
  try {
    const doc = await db.collection('users').doc(uid).get()
    if (doc.exists) {
      const data = doc.data()
      return data.name || uid
    }
  } catch (_) {}
  return uid
}

// ─── Ported from hosting/js/psm-detail.js ────────────────
function computeDiscountPercent(dbp, proposedPrice) {
  if (typeof dbp !== 'number' || dbp === 0) return null
  if (typeof proposedPrice !== 'number') return null
  return ((dbp - proposedPrice) / dbp) * 100
}

function computePsmFinancials(psm, items) {
  items = items || []

  let total_qty     = 0
  let gross_sales   = 0
  let gross_cost    = 0
  let discountSum   = 0
  let discountCount = 0

  items.forEach(it => {
    if (typeof it.qty === 'number')         total_qty   += it.qty
    if (typeof it.total_sales === 'number') gross_sales += it.total_sales
    if (typeof it.total_cost === 'number')  gross_cost  += it.total_cost

    const d = computeDiscountPercent(it.dbp, it.proposed_price)
    if (d !== null) {
      discountSum += d
      discountCount++
    }
  })

  const gross_margin = gross_sales - gross_cost
  const gross_nc     = gross_sales !== 0 ? (gross_margin / gross_sales) * 100 : null
  const avg_discount = discountCount > 0 ? (discountSum / discountCount) : null

  const result = {
    total_qty,
    gross_sales,
    gross_cost,
    gross_margin,
    gross_nc,
    avg_discount,
    accrual_enabled: !!(psm && psm.accrual_enabled),
    accrual_percent: psm ? psm.accrual_percent : null,
    accrual_value: null,
    net_sales: null,
    net_cost: gross_cost,
    net_margin: null,
    net_nc: null
  }

  if (result.accrual_enabled && typeof psm.accrual_percent === 'number') {
    result.accrual_value = gross_sales * psm.accrual_percent / 100
    result.net_sales     = gross_sales - result.accrual_value
    result.net_margin    = result.net_sales - gross_cost
    result.net_nc        = result.net_sales !== 0
                            ? (result.net_margin / result.net_sales) * 100
                            : null
  } else {
    result.net_sales  = gross_sales
    result.net_margin = gross_margin
    result.net_nc     = gross_nc
  }

  return result
}

exports.getPsmPdf = onRequest({ region: REGION }, run(
  [requireAuth, requireActive],
  async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    const psm_id = (req.query.psm_id || '').trim()
    if (!psm_id) return res.status(400).json({ error: 'psm_id is required' })

    try {
      // L1: PSM lookup
      const psmRef  = db.collection('psm_requests').doc(psm_id)
      const psmSnap = await psmRef.get()
      if (!psmSnap.exists) return res.status(404).json({ error: 'PSM not found' })
      const psm = psmSnap.data()

      // Authorization (same pattern as getPsmDetail.js)
      const callerUid = req.user.uid
      const isAdmin   = (req.user.roles || []).some(r => ADMIN_ROLES.includes(r))
      const isOwner   = psm.created_by === callerUid

      let isApprover = false
      let arData     = null
      if (psm.approval_request_id) {
        const arSnap = await db.collection('approval_requests').doc(psm.approval_request_id).get()
        if (arSnap.exists) {
          arData     = arSnap.data()
          isApprover = arData.status === 'PENDING' && arData.current_approver_uid === callerUid
        }
      }

      if (!isOwner && !isAdmin && !isApprover)
        return res.status(403).json({ error: 'Access denied' })

      // L2: PSM items (full field set, matching UI)
      const itemsSnap = await psmRef.collection('psm_items').get()
      const items = itemsSnap.docs.map(doc => {
        const d = doc.data()
        return {
          product_code:   d.product_code   ?? null,
          product_name:   d.product_name   ?? null,
          qty:            d.qty            ?? null,
          dbp:            d.dbp            ?? null,
          cost:           d.cost           ?? null,
          proposed_price: d.proposed_price ?? null,
          total_sales:    d.total_sales    ?? null,
          total_cost:     d.total_cost     ?? null,
          nc:             d.nc             ?? null
        }
      })

      // L3: Approval summary
      let approval = null
      if (arData) {
        approval = {
          status:                arData.status                ?? null,
          current_approver_uid:  arData.current_approver_uid  ?? null,
          approved_at:           toISO(arData.approved_at),
          approved_by:           arData.approved_by           ?? null,
          decision_comment:      arData.decision_comment      ?? null,
          rejected_at:           toISO(arData.rejected_at),
          rejected_by:           arData.rejected_by           ?? null
        }

        // Resolve display names for approved_by / rejected_by / current_approver_uid
        const uidsToResolve = [approval.approved_by, approval.rejected_by, approval.current_approver_uid]
          .filter(Boolean)
        const nameCache = new Map()
        for (const uid of uidsToResolve) {
          if (!nameCache.has(uid)) {
            nameCache.set(uid, await getUserDisplayName(uid))
          }
        }
        approval.approved_by_name      = approval.approved_by ? nameCache.get(approval.approved_by) : null
        approval.rejected_by_name      = approval.rejected_by ? nameCache.get(approval.rejected_by) : null
        approval.current_approver_name = approval.current_approver_uid ? nameCache.get(approval.current_approver_uid) : null
      }

      // L4: Approval history with actor_name
      let approval_history = []
      if (psm.approval_request_id) {
        const actionsSnap = await db.collection('approval_request_actions')
          .where('approval_request_id', '==', psm.approval_request_id)
          .orderBy('created_at', 'asc')
          .get()

        const actorNameCache = new Map()
        for (const doc of actionsSnap.docs) {
          const uid = doc.data().actor_uid
          if (uid && !actorNameCache.has(uid)) {
            actorNameCache.set(uid, await getUserDisplayName(uid))
          }
        }

        approval_history = actionsSnap.docs.map(doc => {
          const d = doc.data()
          const uid = d.actor_uid ?? null
          return {
            action:     d.action ?? null,
            actor_name: uid ? actorNameCache.get(uid) : null,
            comment:    d.comment ?? null,
            created_at: toISO(d.created_at)
          }
        })
      }

      const fin = computePsmFinancials(psm, items)

      // ── Build PDF ──────────────────────────────────────────
      const psm_number = psm.psm_number || '-'

      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${psm_number}.pdf"`)
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')

      const doc = new PDFDocument({ size: 'A4', margin: 30, layout: 'landscape' })
      doc.pipe(res)

      const pageBottom = doc.page.height - doc.page.margins.bottom
      const pageLeft   = doc.page.margins.left
      const pageRight  = doc.page.width - doc.page.margins.right

      function checkPageBreak(rowHeight) {
        if (doc.y + rowHeight > pageBottom) {
          doc.addPage()
          return true
        }
        return false
      }

      // Header
      doc.fontSize(16).font('Helvetica-Bold').text('FUCHS LUBRICANTS INDONESIA', { align: 'left' })
      doc.fontSize(12).font('Helvetica').text('PRICE SUPPORT MEMO', { align: 'left' })
      doc.moveDown(0.5)
      doc.fontSize(10).font('Helvetica-Bold').text(`PSM Number: ${psm_number}`)
      doc.font('Helvetica').text(`Status: ${psm.status || '-'}`)
      doc.moveDown(1)

      // Informasi PSM
      doc.fontSize(11).font('Helvetica-Bold').text('Informasi PSM')
      doc.moveDown(0.3)
      doc.fontSize(9).font('Helvetica')
      doc.text(`PSM Number    : ${psm.psm_number || '-'}`)
      doc.text(`Customer Code : ${psm.customer_code || '-'}`)
      doc.text(`Customer Name : ${psm.customer_name || '-'}`)
      doc.text(`Sales Name    : ${psm.sales_name || '-'}`)
      doc.text(`Validity From : ${psm.validity_from || '-'}`)
      doc.text(`Validity To   : ${psm.validity_to || '-'}`)
      doc.moveDown(1)

      // ALASAN PENGAJUAN PSM (own section, per BIZ-1)
      checkPageBreak(60)
      doc.fontSize(11).font('Helvetica-Bold').text('ALASAN PENGAJUAN PSM')
      doc.moveDown(0.3)
      doc.fontSize(9).font('Helvetica')
      doc.text(psm.business_justification || '-')
      doc.moveDown(1)

      // Status
      checkPageBreak(20)
      doc.fontSize(9).font('Helvetica-Bold').text(`Status : ${psm.status || '-'}`)
      doc.moveDown(1)

      // ── Items Table (11 columns) ──────────────────────────
      doc.fontSize(11).font('Helvetica-Bold').text('Daftar Item')
      doc.moveDown(0.3)

      // Column layout (landscape A4 ~ 782pt usable width with 30pt margins)
      const cols = [
        { key: 'product_code',   label: 'Code',   x: 30,  w: 55, align: 'left'  },
        { key: 'product_name',   label: 'Name',   x: 85,  w: 130, align: 'left'  },
        { key: 'qty',            label: 'Qty',    x: 215, w: 40, align: 'right' },
        { key: 'dbp',            label: 'DBP',    x: 255, w: 65, align: 'right' },
        { key: 'cost',           label: 'Cost',   x: 320, w: 65, align: 'right' },
        { key: 'proposed_price', label: 'PPrice', x: 385, w: 65, align: 'right' },
        { key: 'discount_pct',   label: 'Disc%',  x: 450, w: 50, align: 'right' },
        { key: 'sales_value',    label: 'Sales Value', x: 500, w: 80, align: 'right' },
        { key: 'cost_value',     label: 'Cost Value',  x: 580, w: 80, align: 'right' },
        { key: 'margin',         label: 'Margin', x: 660, w: 70, align: 'right' },
        { key: 'nc',             label: 'NC%',    x: 730, w: 52, align: 'right' }
      ]

      function drawTableHeader() {
        doc.fontSize(7).font('Helvetica-Bold')
        const y = doc.y
        cols.forEach(c => doc.text(c.label, c.x, y, { width: c.w, align: c.align }))
        doc.moveDown(0.3)
        doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke()
        doc.moveDown(0.2)
      }

      drawTableHeader()
      doc.font('Helvetica').fontSize(7)

      for (const it of items) {
        if (checkPageBreak(20)) {
          drawTableHeader()
          doc.font('Helvetica').fontSize(7)
        }

        const discountPct = computeDiscountPercent(it.dbp, it.proposed_price)
        const salesValue  = it.total_sales
        const costValue   = it.total_cost
        const margin      = (typeof it.total_sales === 'number' && typeof it.total_cost === 'number')
                             ? (it.total_sales - it.total_cost)
                             : null

        const rowVals = {
          product_code: it.product_code || '-',
          product_name: it.product_name || '-',
          qty:          fmtNumber(it.qty),
          dbp:          fmtCurrency(it.dbp),
          cost:         fmtCurrency(it.cost),
          proposed_price: fmtCurrency(it.proposed_price),
          discount_pct: fmtPercent(discountPct),
          sales_value:  fmtCurrency(salesValue),
          cost_value:   fmtCurrency(costValue),
          margin:       fmtCurrency(margin),
          nc:           fmtPercent(it.nc)
        }

        const y = doc.y
        cols.forEach(c => doc.text(String(rowVals[c.key]), c.x, y, { width: c.w, align: c.align }))
        doc.moveDown(0.5)
      }

      doc.moveDown(0.3)
      doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke()
      doc.moveDown(0.3)

      // ── Footer rows: TOTAL / LESS ACCRUAL / NET RESULT ────
      function drawFooterRow(label, vals, bg) {
        if (checkPageBreak(20)) {
          drawTableHeader()
        }
        const y = doc.y
        if (bg) {
          doc.rect(pageLeft, y - 1, pageRight - pageLeft, 14).fill(bg)
          doc.fillColor('black')
        }
        doc.font('Helvetica-Bold').fontSize(7)
        doc.text(label, cols[0].x, y, { width: cols[1].x + cols[1].w - cols[0].x, align: 'left' })
        cols.forEach(c => {
          if (vals[c.key] !== undefined) {
            doc.text(String(vals[c.key]), c.x, y, { width: c.w, align: c.align })
          }
        })
        doc.moveDown(0.6)
      }

      // Row 1: TOTAL
      drawFooterRow('TOTAL', {
        qty:          fmtNumber(fin.total_qty),
        discount_pct: fmtPercent(fin.avg_discount),
        sales_value:  fmtCurrency(fin.gross_sales),
        cost_value:   fmtCurrency(fin.gross_cost),
        margin:       fmtCurrency(fin.gross_margin),
        nc:           fmtPercent(fin.gross_nc)
      }, '#f3f4f6')

      // Row 2: LESS ACCRUAL (conditional)
      if (fin.accrual_enabled) {
        const accrualLabel = `LESS ACCRUAL (${fmtNumber(fin.accrual_percent)}%)`
        drawFooterRow(accrualLabel, {
          sales_value: `(${fmtCurrency(fin.accrual_value)})`,
          margin:      `(${fmtCurrency(fin.accrual_value)})`
        }, '#fef9c3')
      }

      // Row 3: NET RESULT
      drawFooterRow('NET RESULT', {
        sales_value: fmtCurrency(fin.net_sales),
        cost_value:  fmtCurrency(fin.net_cost),
        margin:      fmtCurrency(fin.net_margin),
        nc:          fmtPercent(fin.net_nc)
      }, '#dcfce7')

      doc.moveDown(1)

      // ── Ringkasan Persetujuan ──────────────────────────────
      checkPageBreak(100)
      doc.fontSize(11).font('Helvetica-Bold').text('Ringkasan Persetujuan')
      doc.moveDown(0.3)
      doc.fontSize(9).font('Helvetica')

      const a = approval || {}
      doc.text(`Approval Status   : ${a.status || '-'}`)
      doc.text(`Current Approver  : ${a.current_approver_name || '-'}`)
      doc.text(`Approved By       : ${a.approved_by_name || '-'}`)
      doc.text(`Approved At       : ${fmtDate(a.approved_at)}`)
      doc.text(`Rejected By       : ${a.rejected_by_name || '-'}`)
      doc.text(`Rejected At       : ${fmtDate(a.rejected_at)}`)
      doc.text(`Decision Comment  : ${a.decision_comment || '-'}`)
      doc.moveDown(1)

      // ── Approval History ──────────────────────────────────
      checkPageBreak(60)
      doc.fontSize(11).font('Helvetica-Bold').text('Riwayat Persetujuan')
      doc.moveDown(0.3)

      if (approval_history.length === 0) {
        doc.fontSize(9).font('Helvetica').text('Tidak ada riwayat.')
      } else {
        const hCols = [
          { key: 'action',     label: 'Action',  x: 30,  w: 70,  align: 'left' },
          { key: 'actor_name', label: 'Actor',   x: 100, w: 150, align: 'left' },
          { key: 'comment',    label: 'Comment', x: 250, w: 350, align: 'left' },
          { key: 'created_at', label: 'Date',    x: 600, w: 150, align: 'left' }
        ]

        doc.fontSize(8).font('Helvetica-Bold')
        let y = doc.y
        hCols.forEach(c => doc.text(c.label, c.x, y, { width: c.w, align: c.align }))
        doc.moveDown(0.3)
        doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke()
        doc.moveDown(0.2)

        doc.font('Helvetica').fontSize(8)
        for (const h of approval_history) {
          checkPageBreak(40)
          y = doc.y
          hCols.forEach(c => {
            let val = h[c.key]
            if (c.key === 'created_at') val = fmtDate(val)
            doc.text(String(val || '-'), c.x, y, { width: c.w, align: c.align })
          })
          doc.moveDown(0.8)
        }
      }

      // Footer on every page
      const generated_at = fmtDate(new Date().toISOString())
      const range = doc.bufferedPageRange()
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i)
        doc.fontSize(7).font('Helvetica').fillColor('black')
        doc.text(
          `Generated by FCOS | ${generated_at} | ${psm_number}`,
          pageLeft,
          doc.page.height - doc.page.margins.bottom - 12,
          { width: pageRight - pageLeft, align: 'center', lineBreak: false }
        )
      }

      doc.end()

    } catch (err) {
      console.error('[psmRead] getPsmPdf:', err)
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Internal error' })
      }
      res.end()
    }
  }
))
