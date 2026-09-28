const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { openDatabase } = require('../electron/database.cjs')
const { createRepository } = require('../electron/repository.cjs')

const dbPath = path.join(os.tmpdir(), `boss-shop-test-${process.pid}.sqlite`)
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
  let stock = api.listProducts({ _token: token, search: 'TEST-001' })
  assert.equal(stock[0].quantity, 5)

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
  stock = api.listProducts({ _token: seller.token, search: 'TEST-001' })
  assert.equal('purchasePrice' in stock[0], false)
  const sellerDashboard = api.dashboard({ _token: seller.token, from: '2026-09-28', to: '2026-09-28' })
  assert.equal(sellerDashboard.metrics.netProfit, null)
  console.log('Integration scenario passed: receipt -> sale -> return -> expense -> P&L -> role restrictions')
} finally {
  db.close()
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix) } catch {} }
}
