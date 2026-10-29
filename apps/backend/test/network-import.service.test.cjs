const assert = require('node:assert/strict')
const { test } = require('node:test')
const ExcelJS = require('exceljs')
const JSZip = require('jszip')
const { NetworkImportService } = require('../src/network/network-import.service')

async function workbookWithNestedCommentParts() {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Lokasi')
  sheet.addRow(['Alamat', 'Provinsi', 'Kabupaten/Kota', 'Kecamatan', 'Latitude', 'Longitude'])
  sheet.addRow(['', '', '', '', -6.2, 106.8])
  sheet.getCell('A1').note = 'Header comment'

  const archive = await JSZip.loadAsync(Buffer.from(await workbook.xlsx.writeBuffer()))
  archive.file('xl/comments/comment1.xml', await archive.file('xl/comments1.xml').async('nodebuffer'))
  archive.remove('xl/comments1.xml')
  archive.file('xl/drawings/commentsDrawing1.vml', await archive.file('xl/drawings/vmlDrawing1.vml').async('nodebuffer'))
  archive.remove('xl/drawings/vmlDrawing1.vml')

  const relationshipsPath = 'xl/worksheets/_rels/sheet1.xml.rels'
  let relationships = await archive.file(relationshipsPath).async('string')
  relationships = relationships
    .replace('Target="../comments1.xml"', 'Target="/xl/comments/comment1.xml"')
    .replace('Target="../drawings/vmlDrawing1.vml"', 'Target="/xl/drawings/commentsDrawing1.vml"')
  archive.file(relationshipsPath, relationships)

  const contentTypes = await archive.file('[Content_Types].xml').async('string')
  archive.file('[Content_Types].xml', contentTypes.replace('/xl/comments1.xml', '/xl/comments/comment1.xml'))
  return Buffer.from(await archive.generateAsync({ type: 'nodebuffer' }))
}

test('reads XLSX files whose worksheet comments use nested package paths', async () => {
  const importer = new NetworkImportService({})
  const rows = await importer.analyzeWorkbook(await workbookWithNestedCommentParts(), { maxBytes: 15 * 1024 * 1024, maxRows: 5000 })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].latitude, -6.2)
  assert.equal(rows[0].longitude, 106.8)
  assert.equal(rows[0].inputError, undefined)
})
