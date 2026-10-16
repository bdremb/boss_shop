const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { zipSync, strToU8 } = require('fflate')
const { initializeSqlite } = require('../electron/sqlite.cjs')
const { openDatabase } = require('../electron/database.cjs')
const { createRepository } = require('../electron/repository.cjs')
const { parseImportFile } = require('../electron/importer.cjs')

function createWorkbook(filePath) {
  const shared = ['КУРТКИ','Товар','Цвет','Размер','Цена','Оплата','Куртка Test','черный','M','БРАК','Скрытый товар']
  const cell = (ref, value, string = true) => `<c r="${ref}"${string ? ' t="s"' : ''}><v>${value}</v></c>`
  const itemRow = (number, marked = false) => `<row r="${number}">${cell(`A${number}`, number - 2, false)}${cell(`B${number}`, 6)}${cell(`C${number}`, 7)}${cell(`D${number}`, 8)}${cell(`E${number}`, 5000, false)}${marked ? cell(`F${number}`, 9) : `<c r="F${number}"/>`}</row>`
  const files = {
    'xl/workbook.xml': strToU8(`<workbook><sheets><sheet name="Склад" r:id="rId1"/><sheet name="Старое" state="hidden" r:id="rId2"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`),
    'xl/sharedStrings.xml': strToU8(`<sst>${shared.map(value => `<si><t>${value}</t></si>`).join('')}</sst>`),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData><row r="1">${cell('A1',0)}</row><row r="2"><c r="A2"/>${cell('B2',1)}${cell('C2',2)}${cell('D2',3)}${cell('E2',4)}${cell('F2',5)}</row>${itemRow(3)}${itemRow(4)}${itemRow(5,true)}</sheetData></worksheet>`),
    'xl/worksheets/sheet2.xml': strToU8(`<worksheet><sheetData><row r="1">${cell('A1',10)}</row></sheetData></worksheet>`)
  }
  fs.writeFileSync(filePath, Buffer.from(zipSync(files)))
}

;(async () => {
  await initializeSqlite()
  const base = path.join(os.tmpdir(), `boss-shop-import-${process.pid}`)
  const workbookPath = `${base}.xlsx`
  const dbPath = `${base}.sqlite`
  createWorkbook(workbookPath)
  const parsed = parseImportFile(workbookPath)
  assert.equal(parsed.sheetCount, 1)
  assert.equal(parsed.sourceRows, 3)
  assert.equal(parsed.skippedRows, 1)
  assert.equal(parsed.skipped[0].row, 5)
  assert.match(parsed.skipped[0].reason, /отметка/)
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0].quantity, 2)
  assert.equal(parsed.rows[0].priceCents, 500000)

  const db = openDatabase(dbPath)
  try {
    const api = createRepository(db)
    const token = api.login({ login: 'admin', password: 'admin123' }).token
    const first = api.importProducts({ _token: token, importRows: parsed.rows, priceMode: 'retail', stockMode: 'set', fileName: 'test.xlsx' })
    assert.equal(first.createdVariants, 1)
    assert.equal(first.unitsChanged, 2)
    const second = api.importProducts({ _token: token, importRows: parsed.rows, priceMode: 'retail', stockMode: 'set', fileName: 'test.xlsx' })
    assert.equal(second.unitsChanged, 0)
    const priceOnly = api.importProducts({ _token: token, importRows: parsed.rows.map(x => ({ ...x, priceCents: 240000, purchasePriceCents: 240000, purchaseTotalCents: x.quantity * 240000 })), priceMode: 'purchase', stockMode: 'keep', fileName: 'costs.xlsx' })
    assert.equal(priceOnly.unitsChanged, 0)
    const products = api.listProducts({ _token: token, search: 'Куртка Test' })
    assert.equal(products[0].quantity, 2)
    assert.equal(products[0].retailPrice, 500000)
    assert.equal(products[0].purchasePrice, 240000)
    const mixedPath = `${base}-mixed.csv`
    try {
      fs.writeFileSync(mixedPath, '\uFEFFАртикул;Товар;Размер;Цвет;Количество;Цена\nMIX;Mix;M;black;2;1.00\nMIX;Mix;M;black;1;1.01\n')
      const mixed = parseImportFile(mixedPath)
      assert.equal(mixed.rows.length, 1)
      assert.equal(mixed.rows[0].quantity, 3)
      assert.equal(mixed.rows[0].purchaseTotalCents, 301)
      assert.equal(mixed.rows[0].purchasePriceCents, 100)
      assert.equal(mixed.rows[0].priceCents, 101)
      api.importProducts({ _token: token, importRows: mixed.rows, priceMode: 'both', stockMode: 'add' })
      const item = api.listProducts({ _token: token, search: 'MIX' })[0]
      assert.equal(item.purchasePrice, 100); assert.equal(item.retailPrice, 101)
      assert.equal(db.prepare('SELECT stock_cost FROM product_variants WHERE id=?').get(item.variantId).stock_cost, 301)
      api.importProducts({ _token: token, importRows: mixed.rows, priceMode: 'purchase', stockMode: 'set' })
      assert.equal(db.prepare('SELECT stock_cost FROM product_variants WHERE id=?').get(item.variantId).stock_cost, 301)
      api.importProducts({ _token: token, importRows: mixed.rows, priceMode: 'purchase', stockMode: 'keep' })
      assert.equal(db.prepare('SELECT stock_cost FROM product_variants WHERE id=?').get(item.variantId).stock_cost, 300)
    } finally { try { fs.unlinkSync(mixedPath) } catch {} }
    console.log('Import scenario passed: XLSX preview -> grouped stock -> idempotent import')
  } finally {
    db.close()
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix) } catch {} }
    try { fs.unlinkSync(workbookPath) } catch {}
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
