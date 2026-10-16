const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { initializeSqlite } = require('../electron/sqlite.cjs')
const { openDatabase } = require('../electron/database.cjs')
const { createRepository } = require('../electron/repository.cjs')

const dbPath = path.join(os.tmpdir(), `boss-shop-test-${process.pid}.sqlite`)

;(async () => {
await initializeSqlite()
const db = openDatabase(dbPath)
const api = createRepository(db)
try {
  const admin = api.login({ login: 'admin', password: 'admin123' })
  const token = admin.token
  const catalogs = api.bootstrap({ _token: token })
  assert.ok(catalogs.categories.length >= 12)
  assert.ok(catalogs.sizes.length >= 10)

  const product = api.saveProduct({ _token: token, product: {
    article: 'TEST-001', name: 'Тестовая рубашка', categoryId: catalogs.categories[0].id,
    sizeId: catalogs.sizes[0].id, color: 'Синий', purchasePrice: 5000, retailPrice: 20000,
    arrivalDate: '2026-09-28', lowStockThreshold: 2
  }})
  api.createReceipt({ _token: token, receipt: { date: '2026-09-28 10:00:00', items: [{ variantId: product.variantId, quantity: 5, purchasePrice: 5000 }] } })
  let stock = api.listProducts({ _token: token, search: product.article })
  assert.equal(stock[0].quantity, 5)
  assert.equal(api.listProducts({ _token: token, search: 'тЕсТоВаЯ' })[0].article, product.article)
  assert.equal(api.listProducts({ _token: token, search: 'РУБАШКА' })[0].article, product.article)

  const sale = api.createSale({ _token: token, sale: { date: '2026-09-28 12:00:00', paymentMethod: 'Карта', items: [{ variantId: product.variantId, quantity: 2, salePrice: 20000 }] } })
  let dashboard = api.dashboard({ _token: token, from: '2026-09-28', to: '2026-09-28' })
  assert.deepEqual({ revenue: dashboard.metrics.revenue, cost: dashboard.metrics.cost, gross: dashboard.metrics.grossProfit, units: dashboard.metrics.units }, { revenue: 40000, cost: 10000, gross: 30000, units: 2 })

  const saleData = api.getSale({ _token: token, saleId: sale.id })
  api.createReturn({ _token: token, data: { saleId: sale.id, date: '2026-09-28 13:00:00', reason: 'Тест', items: [{ saleItemId: saleData.items[0].id, quantity: 1 }] } })
  dashboard = api.dashboard({ _token: token, from: '2026-09-28', to: '2026-09-28' })
  assert.deepEqual({ revenue: dashboard.metrics.revenue, cost: dashboard.metrics.cost, gross: dashboard.metrics.grossProfit, units: dashboard.metrics.units }, { revenue: 20000, cost: 5000, gross: 15000, units: 1 })

  api.saveExpense({ _token: token, expense: { date: '2026-09-28', categoryId: catalogs.expenseCategories[0].id, description: 'Тестовый расход', amount: 3000 } })
  const pnl = api.pnl({ _token: token, from: '2026-09-28', to: '2026-09-28' })
  assert.equal(pnl.netProfit, 12000)

  const seller = api.login({ login: 'seller', password: 'seller123' })
  stock = api.listProducts({ _token: seller.token, search: product.article })
  assert.equal('purchasePrice' in stock[0], false)
  const sellerDashboard = api.dashboard({ _token: seller.token, from: '2026-09-28', to: '2026-09-28' })
  assert.equal(sellerDashboard.metrics.netProfit, null)
  const unknown = api.saveProduct({ _token: token, product: { article: 'NO-COST', name: 'Куртка Ёлка', sizeId: catalogs.sizes[0].id, color: 'Чёрный', purchasePrice: 0, retailPrice: 10000 } })
  api.createReceipt({ _token: token, receipt: { date: '2026-09-28 14:00:00', items: [{ variantId: unknown.variantId, quantity: 2, purchasePrice: 0 }] } })
  assert.equal(api.listProducts({ _token: token, search: 'ёлка' })[0].article, unknown.article)
  assert.equal(api.listProducts({ _token: token, search: 'ЕЛКА' })[0].article, unknown.article)
  assert.equal(api.listProducts({ _token: token, cost: 'missing' }).length, 1)
  api.createSale({ _token: token, sale: { date: '2026-09-28 15:00:00', paymentMethod: 'Карта', items: [{ variantId: unknown.variantId, quantity: 1, salePrice: 10000 }] } })
  dashboard = api.dashboard({ _token: token, from: '2026-09-28', to: '2026-09-28' })
  assert.equal(dashboard.metrics.revenue, 30000)
  assert.equal(dashboard.metrics.missingCostUnits, 1)
  assert.equal(dashboard.metrics.netProfit, null)
  assert.equal(api.pnl({ _token: token, from: '2026-09-28', to: '2026-09-28' }).grossProfit, null)
  assert.equal(api.analytics({ _token: token, from: '2026-09-28', to: '2026-09-28', dimension: 'product' }).find(x => x.label === 'Куртка Ёлка').profit, null)
  const second = api.saveProduct({ _token: token, product: {
    productId: product.productId, article: product.article, name: 'Тестовая рубашка', categoryId: catalogs.categories[0].id,
    sizeId: catalogs.sizes[1].id, color: 'Синий', purchasePrice: 5000, retailPrice: 20000
  } })
  api.quickEditProduct({ _token: token, scope: 'product', id: product.productId, field: 'name', value: 'Новая рубашка' })
  assert.throws(()=>api.quickEditProduct({ _token: token, scope: 'product', id: product.productId, field: 'article', value: 'TEST-002' }), /нельзя/)
  api.quickEditProduct({ _token: token, scope: 'product', id: product.productId, field: 'brand', value: 'Boss' })
  api.quickEditProduct({ _token: token, scope: 'product', id: product.productId, field: 'lowStockThreshold', value: 0 })
  api.quickEditProduct({ _token: token, scope: 'product', id: product.productId, field: 'note', value: 'Исправлено в таблице' })
  api.quickEditProduct({ _token: token, scope: 'variant', id: product.variantId, field: 'barcode', value: '12345' })
  assert.equal(api.listProducts({ _token: token, search: 'новая рубашка' }).length, 2)
  assert.equal(api.listProducts({ _token: token, search: product.article }).length, 2)
  assert.equal(api.listProducts({ _token: token, brand: 'Boss' }).length, 2)
  assert.equal(api.listProducts({ _token: token, search: '12345' })[0].lowStockThreshold, 0)
  assert.equal(api.listProducts({ _token: token, search: '12345' })[0].note, 'Исправлено в таблице')
  assert.throws(() => api.quickEditProduct({ _token: token, scope: 'product', id: product.productId, field: 'article', value: 'NO-COST' }), /нельзя/)
  assert.throws(() => api.quickEditProduct({ _token: token, scope: 'product', id: product.productId, field: 'arrivalDate', value: '2026-02-30' }), /дату/)
  api.quickEditProduct({ _token: token, scope: 'product', id: product.productId, field: 'arrivalDate', value: '2026-10-03' })
  assert.equal(api.listProducts({ _token: token, search: product.article })[0].arrivalDate, '2026-10-03')
  api.quickEditProduct({ _token: token, scope: 'variant', id: product.variantId, field: 'purchasePrice', value: 7500 })
  api.quickEditProduct({ _token: token, scope: 'allVariants', id: product.productId, field: 'retailPrice', value: 25000 })
  assert.equal(api.listProducts({ _token: token, search: product.article }).every(x => x.retailPrice === 25000), true)
  assert.equal(api.listProducts({ _token: token, search: product.article }).find(x => x.variantId === product.variantId).purchasePrice, 7500)
  assert.equal(api.getSale({ _token: token, saleId: sale.id }).items[0].purchasePrice, 5000)
  assert.equal(api.getSale({ _token: token, saleId: sale.id }).items[0].salePrice, 20000)
  assert.equal(api.getSale({ _token: token, saleId: sale.id }).items[0].article, product.article)
  assert.throws(() => api.quickEditProduct({ _token: token, scope: 'variant', id: second.variantId, field: 'sizeId', value: catalogs.sizes[0].id }), /размер и цвет/)
  assert.throws(() => api.quickEditProduct({ _token: token, scope: 'variant', id: product.variantId, field: 'quantity', value: -1 }), /неотрицательное/)
  api.quickEditProduct({ _token: token, scope: 'variant', id: product.variantId, field: 'quantity', value: 5 })
  assert.equal(api.listProducts({ _token: token, search: product.article }).find(x => x.variantId === product.variantId).quantity, 5)
  assert.equal(db.prepare("SELECT quantity_delta FROM stock_movements WHERE variant_id=? AND movement_type='adjustment'").get(product.variantId).quantity_delta, 1)
  assert.throws(() => api.quickEditProduct({ _token: seller.token, scope: 'variant', id: product.variantId, field: 'purchasePrice', value: 1 }), /Недостаточно прав/)
  assert.throws(() => api.quickEditProduct({ _token: token, scope: 'variant', id: product.variantId, field: 'sale_price', value: 1 }), /нельзя быстро изменить/)
  console.log('Integration scenario passed: receipt -> sale -> return -> expense -> P&L -> role restrictions')
} finally {
  db.close()
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix) } catch {} }
}
})().catch(error => { console.error(error); process.exitCode = 1 })
