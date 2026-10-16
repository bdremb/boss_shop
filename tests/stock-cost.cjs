const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync, initializeSqlite, backup } = require('../electron/sqlite.cjs')
const { openDatabase } = require('../electron/database.cjs')
const { createRepository } = require('../electron/repository.cjs')
const costing = require('../electron/stock-cost.cjs')

;(async () => {
  await initializeSqlite()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-stock-cost-'))
  const file = path.join(root, 'test.sqlite')
  let db, api, token
  const connect = () => { db = openDatabase(file); api = createRepository(db); token = api.login({ login: 'admin', password: 'admin123' }).token }
  const product = article => {
    api.importProducts({_token:token,importRows:[{article,name:article,priceCents:100,quantity:0}],priceMode:'purchase',stockMode:'keep'})
    const item=api.listProducts({_token:token,search:article})[0]
    api.saveProduct({_token:token,product:{...item,retailPrice:1000}})
    return item
  }
  const row = id => db.prepare('SELECT quantity,stock_cost,purchase_price FROM product_variants WHERE id=?').get(id)
  const receipt = (id, quantity, purchasePrice) => api.createReceipt({ _token: token, receipt: { date: '2026-10-04', items: [{ variantId: id, quantity, purchasePrice }] } })
  const sell = (id, quantity) => api.createSale({ _token: token, sale: { date: '2026-10-04', items: [{ variantId: id, quantity, salePrice: 1000 }] } })
  const saleItem = id => db.prepare('SELECT * FROM sale_items WHERE sale_id=?').get(id)
  const returning = (saleId, itemId, quantity) => api.createReturn({ _token: token, data: { saleId, date: '2026-10-04', items: [{ saleItemId: itemId, quantity }] } })
  const writeoff = (id, quantity) => api.createWriteoff({ _token: token, data: { date: '2026-10-04', reason: 'Test', items: [{ variantId: id, quantity }] } })
  const edit = (id, field, value, scope = 'variant') => api.quickEditProduct({ _token: token, scope, id, field, value })
  const importRow = (article, quantity, priceCents) => ({ article, name: article, color: '', size: '', quantity, priceCents })
  const importing = (article, quantity, priceCents, stockMode, priceMode = 'purchase') => api.importProducts({ _token: token, importRows: [importRow(article, quantity, priceCents)], stockMode, priceMode })
  const documents = () => Object.fromEntries(['receipts','receipt_items','sales','sale_items','returns','return_items','writeoffs','writeoff_items'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]))
  try {
    connect()
    const p = product('WEIGHTED'), id = p.variantId
    receipt(id, 2, 10000); receipt(id, 3, 20000)
    assert.deepEqual(row(id), { quantity: 5, stock_cost: 80000, purchase_price: 16000 })
    const sale = sell(id, 2), si = saleItem(sale.id)
    assert.equal(si.cost, 32000); assert.equal(si.purchase_price, 16000)
    receipt(id, 1, 30000)
    returning(sale.id, si.id, 1)
    assert.deepEqual(row(id), { quantity: 5, stock_cost: 94000, purchase_price: 18800 })
    writeoff(id, 2)
    assert.deepEqual(row(id), { quantity: 3, stock_cost: 56400, purchase_price: 18800 })
    assert.equal(db.prepare('SELECT cost FROM writeoff_items WHERE variant_id=?').get(id).cost, 37600)
    const history = documents()
    edit(id, 'purchasePrice', 500)
    assert.deepEqual(row(id), { quantity: 3, stock_cost: 1500, purchase_price: 500 })
    assert.deepEqual(documents(), history)
    db.close(); connect()
    assert.deepEqual(documents(), history)
    assert.deepEqual(row(id), { quantity: 3, stock_cost: 1500, purchase_price: 500 })

    const fractional = product('FRACTIONAL').variantId
    receipt(fractional, 2, 100); receipt(fractional, 1, 101)
    assert.deepEqual(row(fractional), { quantity: 3, stock_cost: 301, purchase_price: 100 })
    // Saving the same displayed price must preserve the undisplayed kopeck.
    api.saveProduct({ _token: token, product: { productId: db.prepare('SELECT product_id FROM product_variants WHERE id=?').get(fractional).product_id, variantId: fractional, article: 'FRACTIONAL', name: 'Renamed', purchasePrice: 100, retailPrice: 1000 } })
    assert.equal(row(fractional).stock_cost, 301)
    const fsale = sell(fractional, 2), fsi = saleItem(fsale.id)
    assert.equal(fsi.cost, 201)
    returning(fsale.id, fsi.id, 1); returning(fsale.id, fsi.id, 1)
    assert.deepEqual(db.prepare('SELECT cost FROM return_items WHERE sale_item_id=? ORDER BY id').all(fsi.id).map(item => item.cost), [101, 100])
    assert.deepEqual(row(fractional), { quantity: 3, stock_cost: 301, purchase_price: 100 })
    writeoff(fractional, 3)
    assert.deepEqual(row(fractional), { quantity: 0, stock_cost: 0, purchase_price: 100 })
    assert.equal(db.prepare('SELECT cost FROM writeoff_items WHERE variant_id=?').get(fractional).cost, 301)
    receipt(fractional, 1, 777)
    assert.deepEqual(row(fractional), { quantity: 1, stock_cost: 777, purchase_price: 777 })

    const imported = product('IMPORT').variantId
    receipt(imported, 2, 100)
    importing('IMPORT', 1, 400, 'add')
    assert.deepEqual(row(imported), { quantity: 3, stock_cost: 600, purchase_price: 200 })
    const ihistory = documents()
    importing('IMPORT', 0, 300, 'keep')
    assert.deepEqual(row(imported), { quantity: 3, stock_cost: 900, purchase_price: 300 })
    importing('IMPORT', 2, 500, 'set', 'both')
    assert.deepEqual(row(imported), { quantity: 2, stock_cost: 1000, purchase_price: 500 })
    importing('IMPORT', 1, 900, 'add', 'retail')
    assert.deepEqual(row(imported), { quantity: 3, stock_cost: 1500, purchase_price: 500 })
    importing('IMPORT', 2, 950, 'set', 'retail')
    assert.deepEqual(row(imported), { quantity: 2, stock_cost: 1000, purchase_price: 500 })
    assert.deepEqual(documents(), ihistory)
    edit(imported, 'quantity', 3)
    assert.equal(row(imported).stock_cost, 1500)
    edit(imported, 'quantity', 1)
    assert.equal(row(imported).stock_cost, 500)
    const importProductId = db.prepare('SELECT product_id FROM product_variants WHERE id=?').get(imported).product_id
    edit(importProductId, 'purchasePrice', 700, 'allVariants')
    assert.equal(row(imported).stock_cost, 700)
    assert.throws(() => receipt(imported, 0.5, 1), /целое число/)
    assert.throws(() => receipt(imported, 1, 0.5), /целое число/)
    assert.throws(() => receipt(imported, 1, Number.MAX_SAFE_INTEGER), /диапазон/)
    assert.equal(row(imported).stock_cost, 700)
    assert.throws(() => costing.multiply(Number.MAX_SAFE_INTEGER, 2), /диапазон/)
    assert.equal(costing.allocate(1, 2, 1), 1)
    const copies = path.join(root, 'manual.bossshop')
    await backup(db, copies)
    const current = documents()
    db.close(); db = null
    const restored = openDatabase(copies)
    assert.equal(restored.prepare('SELECT stock_cost FROM product_variants WHERE id=?').get(imported).stock_cost, 700)
    restored.close()
    connect(); assert.deepEqual(documents(), current)

    // Emulate an old schema by removing only the new column from a synthetic DB.
    const legacyHistory = documents()
    db.exec('ALTER TABLE product_variants DROP COLUMN stock_cost')
    const expected = db.prepare('SELECT id,quantity*purchase_price total FROM product_variants').all()
    db.close(); db = null
    const oldBytes = fs.readFileSync(file)
    const failureFile = path.join(root, 'failed-migration.sqlite')
    fs.writeFileSync(failureFile, oldBytes)
    const rename = fs.renameSync
    fs.renameSync = (source, destination) => { if (destination === failureFile) throw new Error('injected migration save failure'); return rename(source, destination) }
    try { assert.throws(() => openDatabase(failureFile), /migration save failure/) } finally { fs.renameSync = rename }
    assert.deepEqual(fs.readFileSync(failureFile), oldBytes)
    const unmigrated = new DatabaseSync(failureFile, { readOnly: true })
    assert.equal(unmigrated.prepare('PRAGMA table_info(product_variants)').all().some(column => column.name === 'stock_cost'), false)
    unmigrated.close()
    const migrated = openDatabase(failureFile)
    assert.ok(migrated.prepare('PRAGMA table_info(product_variants)').all().some(column => column.name === 'stock_cost'))
    migrated.close()
    connect()
    assert.deepEqual(documents(), legacyHistory)
    for (const item of expected) assert.equal(db.prepare('SELECT stock_cost FROM product_variants WHERE id=?').get(item.id).stock_cost, item.total)
    assert.deepEqual(fs.readFileSync(`${file}.previous`), oldBytes)
    db.close(); db = null
    const legacyCopy = path.join(root, 'legacy.bossshop'); fs.writeFileSync(legacyCopy, oldBytes)
    db = openDatabase(legacyCopy)
    assert.deepEqual(documents(), legacyHistory)
    db.close(); db = null
    console.log('Stock cost passed: weighted receipts, exact rounded sale/partial returns/writeoff, price/quantity edits, import modes, reopen, migration with unchanged history, manual backups')
  } finally {
    try { db?.close() } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
