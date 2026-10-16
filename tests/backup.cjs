const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { backup, initializeSqlite } = require('../electron/sqlite.cjs')
const { openDatabase } = require('../electron/database.cjs')
const { createRepository } = require('../electron/repository.cjs')

const root = path.join(os.tmpdir(), `boss-shop-backup-test-${process.pid}`)
const livePath = `${root}-live.sqlite`
const backupPath = `${root}.bossshop`
const restoredPath = `${root}-restored.sqlite`

;(async () => {
  let live
  let restored
  try {
    await initializeSqlite()
    live = openDatabase(livePath)
    const api = createRepository(live)
    const admin = api.login({ login: 'admin', password: 'admin123' })
    const seller = api.login({ login: 'seller', password: 'seller123' })
    assert.equal(api.authorizeAdmin({ _token: admin.token }), true)
    assert.throws(() => api.authorizeAdmin({ _token: seller.token }), /Недостаточно прав/)

    const catalogs = api.bootstrap({ _token: admin.token })
    const created = api.saveProduct({ _token: admin.token, product: {
      article: 'BACKUP-001', name: 'Товар в резервной копии', categoryId: catalogs.categories[0].id,
      sizeId: catalogs.sizes[0].id, color: 'Черный', purchasePrice: 10000, retailPrice: 20000
    }})
    live.exec('PRAGMA wal_checkpoint(FULL)')
    await backup(live, backupPath)
    live.close()
    live = null

    fs.copyFileSync(backupPath, restoredPath)
    restored = openDatabase(restoredPath)
    const restoredProduct = restored.prepare('SELECT article,name FROM products WHERE article=?').get(created.article)
    assert.deepEqual({ ...restoredProduct }, { article: created.article, name: 'Товар в резервной копии' })
    assert.equal(Object.values(restored.prepare('PRAGMA quick_check').get())[0], 'ok')
    console.log('Backup scenario passed: full SQLite backup -> file copy -> validation -> restored data')
  } finally {
    try { live?.close() } catch {}
    try { restored?.close() } catch {}
    for (const file of [livePath, backupPath, restoredPath]) {
      for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix) } catch {} }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
