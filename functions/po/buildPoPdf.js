'use strict'

const PDFDocument = require('pdfkit')

function fmtCurrency(num) {
  if (num === null || num === undefined || isNaN(num)) return '-'
  return 'Rp ' + Number(num).toLocaleString('id-ID', { maximumFractionDigits: 0 })
}

function fmtNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '-'
  return Number(num).toLocaleString('id-ID', { maximumFractionDigits: 0 })
}

function fmtPercent(num) {
  if (num === null || num === undefined || isNaN(num)) return '-'
  return Number(num).toFixed(2) + '%'
}

function fmtDate(str) {
  if (!str) return '-'
  const d = new Date(str)
  if (isNaN(d.getTime())) return str
  const day   = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year  = d.getFullYear()
  return `${day}/${month}/${year}`
}

function computeDisc(dbp, unitPrice) {
  if (!dbp || dbp === 0 || unitPrice === null || unitPrice === undefined) return null
  return ((dbp - unitPrice) / dbp) * 100
}

// ============================================================
// buildPoPdf(hdr, lines, po_number, res)
// Single PDF rendering engine. Used by getPoPdf and portalGetPoPdf.
// Pipes PDF output directly to res.
// ============================================================
function buildPoPdf(hdr, lines, po_number, res) {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${po_number}.pdf"`)
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')

  const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'portrait' })
  doc.pipe(res)

  const PL = doc.page.margins.left
  const PR = doc.page.width - doc.page.margins.right
  const PW = PR - PL
  const PB = doc.page.height - doc.page.margins.bottom

  function checkPageBreak(h) {
    if (doc.y + h > PB) { doc.addPage(); return true }
    return false
  }

  function hLine(y) {
    doc.moveTo(PL, y ?? doc.y).lineTo(PR, y ?? doc.y).stroke()
  }

  // ── SECTION 1: HEADER ──────────────────────────────────────
  // Left: Customer (pembeli) — header surat
  doc.fontSize(13).font('Helvetica-Bold').text(hdr.customer_name || '-', PL, doc.y)
  doc.fontSize(8).font('Helvetica').text(hdr.customer_address || '-', PL, doc.y, { width: PW / 2 })
  doc.fontSize(8).font('Helvetica').text(`Code: ${hdr.customer_code || '-'}`)
  doc.moveDown(0.3)

  // Right: PO title + number (overlaid at top)
  const titleY = doc.page.margins.top
  doc.fontSize(16).font('Helvetica-Bold').text('PURCHASE ORDER', PL, titleY, { align: 'right', width: PW })
  const displayNo = hdr.po_reference_number || po_number
  doc.fontSize(9).font('Helvetica').text(`No: ${displayNo}`, PL, doc.y, { align: 'right', width: PW })
  doc.fontSize(9).font('Helvetica').text(`Ref: ${po_number}`, PL, doc.y, { align: 'right', width: PW })
  doc.fontSize(9).font('Helvetica').text(`Date: ${fmtDate(hdr.po_date)}`, PL, doc.y, { align: 'right', width: PW })

  doc.moveDown(0.8)
  hLine()
  doc.moveDown(0.5)

  // ── SECTION 2 & 3: CUSTOMER + SHIP-TO ──────────────────────
  const colMid = PL + PW / 2 + 10
  const leftW  = PW / 2 - 15
  const rightW = PW / 2 - 10
  const infoY  = doc.y

  doc.fontSize(9).font('Helvetica-Bold').text('BILL TO:', PL, infoY)
  doc.fontSize(8).font('Helvetica')
  doc.text('PT. Fuchs Lubricants Indonesia', PL, infoY + 13, { width: leftW })
  doc.text('Jl. Raya Bekasi KM 28, Medan Satria, Bekasi 17132', PL, infoY + 24, { width: leftW })

  doc.fontSize(9).font('Helvetica-Bold').text('SHIP TO:', colMid, infoY)
  doc.fontSize(8).font('Helvetica')
  doc.text(hdr.shipto_name    || '-', colMid, infoY + 13, { width: rightW })
  doc.text(hdr.shipto_address || '-', colMid, infoY + 24, { width: rightW })
  doc.text(`Code: ${hdr.shipto_code || '-'}`, colMid, infoY + 35, { width: rightW })

  doc.moveDown(2.5)
  doc.moveDown(0.5)
  hLine()
  doc.moveDown(0.5)

  // ── SECTION 4 & 5: SALES + SEGMENT ─────────────────────────
  const salesY = doc.y
  doc.fontSize(8).font('Helvetica-Bold').text('Kepada:', PL, salesY, { width: 80 })
  doc.font('Helvetica').text('PT. Fuchs Lubricants Indonesia', PL + 85, salesY, { width: leftW - 85 })
  doc.font('Helvetica-Bold').text('Segment:', colMid, salesY, { width: 80 })
  doc.font('Helvetica').text(`${hdr.segment_name || '-'} (${hdr.segment_code || '-'})`, colMid + 85, salesY, { width: rightW - 85 })

  doc.moveDown(1.2)
  hLine()
  doc.moveDown(0.6)

  // ── SECTION 6: LINE ITEMS TABLE ─────────────────────────────
  doc.fontSize(10).font('Helvetica-Bold').text('LINE ITEMS', PL, doc.y)
  doc.moveDown(0.4)

  const cols = [
    { key: 'no',           label: 'No',           x: PL,       w: 18,  align: 'center' },
    { key: 'product_code', label: 'Material Code', x: PL + 18,  w: 75,  align: 'left'   },
    { key: 'product_name', label: 'Description',  x: PL + 93,  w: 135, align: 'left'   },
    { key: 'qty',          label: 'Qty',          x: PL + 228, w: 28,  align: 'center' },
    { key: 'price_list',   label: 'Price List',   x: PL + 256, w: 68,  align: 'right'  },
    { key: 'unit_price',   label: 'Unit Price',   x: PL + 324, w: 68,  align: 'right'  },
    { key: 'disc_pct',     label: 'Disc %',       x: PL + 392, w: 40,  align: 'right'  },
    { key: 'net_amount',   label: 'Net Amount',   x: PL + 432, w: 83,  align: 'right'  },
  ]

  function drawTableHeader() {
    const y = doc.y
    doc.rect(PL, y, PW, 14).fill('#1a3c6b')
    doc.fillColor('white').fontSize(7).font('Helvetica-Bold')
    cols.forEach(c => doc.text(c.label, c.x, y + 3, { width: c.w, align: c.align }))
    doc.fillColor('black')
    doc.y = y + 16
  }

  drawTableHeader()
  doc.fontSize(7).font('Helvetica')
  let rowBg = false

  for (let i = 0; i < lines.length; i++) {
    checkPageBreak(18)
    const ln      = lines[i]
    const discPct = computeDisc(ln.resolved_price, ln.final_price)
    const y       = doc.y

    if (rowBg) { doc.rect(PL, y, PW, 14).fill('#f0f4fa'); doc.fillColor('black') }
    rowBg = !rowBg

    const rowVals = {
      no           : String(i + 1),
      product_code : ln.product_code || '-',
      product_name : ln.product_name || '-',
      qty          : fmtNumber(ln.qty),
      price_list   : fmtCurrency(ln.resolved_price),
      unit_price   : fmtCurrency(ln.final_price),
      disc_pct     : fmtPercent(discPct),
      net_amount   : fmtCurrency(ln.line_total),
    }

    cols.forEach(c => doc.text(String(rowVals[c.key]), c.x, y + 2, { width: c.w, align: c.align, lineBreak: false }))
    doc.y = y + 16
  }

  hLine()
  doc.moveDown(0.6)

  // ── SECTION 7: FINANCIAL SUMMARY ────────────────────────────
  checkPageBreak(80)
  const sumX = PL + PW * 0.55
  const sumW = PW * 0.45

  function summaryRow(label, value, bold, bgColor) {
    checkPageBreak(16)
    const y = doc.y
    if (bgColor) { doc.rect(sumX, y, sumW, 14).fill(bgColor); doc.fillColor('black') }
    const fnt = bold ? 'Helvetica-Bold' : 'Helvetica'
    doc.font(fnt).fontSize(8)
    doc.text(label, sumX + 4, y + 2, { width: sumW * 0.5,  align: 'left',  lineBreak: false })
    doc.text(value, sumX + sumW * 0.5, y + 2, { width: sumW * 0.48, align: 'right', lineBreak: false })
    doc.y = y + 14
  }

  summaryRow('Subtotal',    fmtCurrency(hdr.subtotal),   false, '#f9fafb')
  summaryRow('VAT (11%)',   fmtCurrency(hdr.vat_amount), false, '#f9fafb')
  doc.moveTo(sumX, doc.y).lineTo(sumX + sumW, doc.y).stroke()
  summaryRow('GRAND TOTAL', fmtCurrency(hdr.grand_total), true, '#1a3c6b')
  const gtY = doc.y - 14
  doc.fillColor('white').font('Helvetica-Bold').fontSize(8)
  doc.text('GRAND TOTAL', sumX + 4, gtY + 2, { width: sumW * 0.5, align: 'left', lineBreak: false })
  doc.text(fmtCurrency(hdr.grand_total), sumX + sumW * 0.5, gtY + 2, { width: sumW * 0.48, align: 'right', lineBreak: false })
  doc.fillColor('black')
  doc.moveDown(2)

  // ── SECTION 8: LEGAL NOTE ────────────────────────────────────
  checkPageBreak(60)
  doc.rect(PL, doc.y, PW, 40).stroke()
  const noteY = doc.y + 5
  doc.fontSize(7).font('Helvetica-Bold').text('Catatan:', PL + 6, noteY)
  doc.font('Helvetica').fontSize(7).text(
    'Harga hanya sebagai indikasi awal. Apabila terjadi selisih maka akan mengikuti\n' +
    'nilai invoice yang diterbitkan oleh PT. Fuchs Lubricants Indonesia.',
    PL + 6, noteY + 10, { width: PW - 12 }
  )
  doc.y = noteY + 44

  // ── SECTION 9: SIGNATURE BLOCK ───────────────────────────────
  checkPageBreak(100)
  doc.moveDown(1.5)
  // 2 signature cols: customer signatory (left) + FLI Sales Manager (right)
  const sigCols = [
    { label: 'Dibuat Oleh',    name: hdr.sales_name || '', title: hdr.customer_name || '' },
    { label: 'Disetujui Oleh', name: hdr.fli_sales_name || '', title: 'Sales Manager\nPT. Fuchs Lubricants Indonesia' },
  ]
  const sigW = PW / 2
  const sigY = doc.y
  sigCols.forEach((s, i) => {
    const sx = PL + i * sigW
    doc.fontSize(8).font('Helvetica-Bold').text(s.label, sx, sigY, { width: sigW, align: 'center' })
    doc.moveTo(sx + 20, sigY + 55).lineTo(sx + sigW - 20, sigY + 55).stroke()
    doc.fontSize(7).font('Helvetica-Bold').text(s.name, sx, sigY + 58, { width: sigW, align: 'center' })
    doc.font('Helvetica').text(s.title, sx, sigY + 68, { width: sigW, align: 'center' })
  })

  // ── PAGE FOOTER ───────────────────────────────────────────────
  const generated = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    doc.fontSize(6).font('Helvetica').fillColor('#888888')
    doc.text(
      `Generated by FCOS | ${generated} | ${po_number} | Page ${i - range.start + 1} of ${range.count}`,
      PL, doc.page.height - doc.page.margins.bottom - 10,
      { width: PW, align: 'center', lineBreak: false }
    )
    doc.fillColor('black')
  }

  doc.end()
}

module.exports = { buildPoPdf }
