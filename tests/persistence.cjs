const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { DatabaseSync, initializeSqlite, backup, replaceDatabaseFile } = require('../electron/sqlite.cjs')
const { openDatabase } = require('../electron/database.cjs')
const { createRepository } = require('../electron/repository.cjs')

;(async () => {
  await initializeSqlite()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-persistence-'))
  let db
  const readValue = file => {
    const candidate = new DatabaseSync(file, { readOnly: true })
    try { return candidate.prepare('SELECT value FROM sample').get().value } finally { candidate.close() }
  }
  const create = file => {
    const database = new DatabaseSync(file)
    database.exec('CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (1)')
    return database
  }
  try {
    // Startup schema and migration are durably saved even though the batch starts with PRAGMA.
    const shop = path.join(root, 'shop.sqlite')
    db = openDatabase(shop)
    const api = createRepository(db), token = api.login({ login: 'admin', password: 'admin123' }).token
    const p = api.saveProduct({ _token: token, product: { article: 'FAULT', name: 'Fault', retailPrice: 100, purchasePrice: 50 } })
    const original = fs.writeFileSync
    fs.writeFileSync = () => { const error = new Error('injected ENOSPC'); error.code = 'ENOSPC'; throw error }
    try {
      assert.throws(() => api.quickEditProduct({ _token: token, scope: 'variant', id: p.variantId, field: 'retailPrice', value: 200 }), /injected ENOSPC/)
    } finally { fs.writeFileSync = original }
    assert.equal(db.inTransaction, false); assert.equal(db.dirty, false)
    assert.equal(db.prepare('SELECT retail_price FROM product_variants').get().retail_price, 100)
    const countReceipts = () => db.prepare('SELECT COUNT(*) count FROM receipts').get().count
    const savedRename = fs.renameSync
    fs.renameSync = (source, destination) => { if (destination === shop) throw new Error('injected commit failure'); return savedRename(source, destination) }
    const receipt = { _token: token, receipt: { date: '2026-10-04', items: [{ variantId: p.variantId, quantity: 2, purchasePrice: 50 }] } }
    try { assert.throws(() => api.createReceipt(receipt), /injected commit failure/) } finally { fs.renameSync = savedRename }
    assert.equal(countReceipts(), 0)
    assert.equal(db.prepare('SELECT quantity,stock_cost FROM product_variants WHERE id=?').get(p.variantId).quantity, 0)
    api.createReceipt(receipt)
    assert.equal(countReceipts(), 1)
    assert.equal(db.prepare('SELECT stock_cost FROM product_variants WHERE id=?').get(p.variantId).stock_cost, 100)
    db.close(); db = openDatabase(shop)
    assert.equal(db.prepare('SELECT retail_price FROM product_variants').get().retail_price, 100)
    assert.throws(() => db.prepare('INSERT INTO product_variants(product_id) VALUES (999999)').run(), /FOREIGN KEY/)
    db.close(); db = null

    const deferred = path.join(root, 'deferred.sqlite')
    db = new DatabaseSync(deferred)
    db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)')
    db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO child(id) VALUES (123)').run()
    assert.throws(() => db.exec('COMMIT'), /FOREIGN KEY/)
    assert.equal(db.inTransaction, true)
    db.exec('ROLLBACK'); assert.equal(db.inTransaction, false); assert.equal(db.dirty, false)
    assert.equal(db.prepare('SELECT COUNT(*) count FROM child').get().count, 0)
    db.close(); db = null

    for (const fault of ['write', 'flush', 'previous-rename', 'replace']) {
      const file = path.join(root, `${fault}.sqlite`)
      db = create(file)
      const before = fs.readFileSync(file)
      const savedWrite = fs.writeFileSync, savedSync = fs.fsyncSync, savedRename = fs.renameSync
      const failure = () => { throw new Error(`injected ${fault}`) }
      if (fault === 'write') fs.writeFileSync = failure
      if (fault === 'flush') fs.fsyncSync = failure
      if (fault.includes('rename') || fault === 'replace') fs.renameSync = (source, destination) => {
        if (destination === (fault === 'replace' ? file : `${file}.previous`)) failure()
        return savedRename(source, destination)
      }
      try {
        db.exec('BEGIN IMMEDIATE'); db.prepare('UPDATE sample SET value=2').run()
        assert.throws(() => db.exec('COMMIT'), new RegExp(`injected ${fault}`))
        assert.equal(db.inTransaction, false); assert.equal(db.dirty, false)
        assert.equal(db.prepare('SELECT value FROM sample').get().value, 1)
        // Autocommit failures must also restore in-memory state.
        assert.throws(() => db.prepare('UPDATE sample SET value=3').run(), /injected/)
        assert.equal(db.prepare('SELECT value FROM sample').get().value, 1)
      } finally { fs.writeFileSync = savedWrite; fs.fsyncSync = savedSync; fs.renameSync = savedRename }
      assert.deepEqual(fs.readFileSync(file), before)
      db.prepare('UPDATE sample SET value=4').run(); db.close(); db = null
      assert.equal(readValue(file), 4)
    }

    for (const phase of ['partial', 'flushed', 'previous', 'before-replace', 'after-replace']) {
      const file = path.join(root, `crash-${phase}.sqlite`)
      db = create(file); db.close(); db = null
      const result = spawnSync(process.execPath, [path.join(__dirname, 'persistence-crash.cjs'), file, phase], { encoding: 'utf8', timeout: 30000 })
      assert.ok(!result.error, result.error?.message)
      assert.notEqual(result.status, 0, `Child unexpectedly succeeded: ${result.stdout} ${result.stderr}`)
      assert.equal(fs.readFileSync(`${file}.crash-stage`, 'utf8'), phase)
      assert.equal(readValue(file), phase === 'after-replace' ? 2 : 1)
      // Actual Windows rename replacement after an interrupted save.
      db = new DatabaseSync(file); db.prepare('UPDATE sample SET value=5').run(); db.close(); db = null
      assert.equal(readValue(file), 5)
    }

    const recovery = path.join(root, 'recovery.sqlite')
    db = create(recovery); db.prepare('UPDATE sample SET value=2').run(); db.close(); db = null
    fs.writeFileSync(recovery, 'interrupted/corrupt')
    db = new DatabaseSync(recovery)
    assert.equal(db.prepare('SELECT value FROM sample').get().value, 1)
    assert.equal(db.getBackupStatus().recoveredFrom, `${recovery}.previous`)
    db.close(); db = null
    assert.equal(readValue(recovery), 1)
    assert.ok(fs.readdirSync(root).some(name => name.startsWith('recovery.sqlite.damaged-')))
    fs.rmSync(recovery)
    db = new DatabaseSync(recovery); db.close(); db = null
    assert.equal(readValue(recovery), 1)
    const invalid = path.join(root, 'invalid.sqlite'); fs.writeFileSync(invalid, 'bad')
    assert.throws(() => new DatabaseSync(invalid), /Не удалось открыть/)
    assert.equal(fs.readFileSync(invalid, 'utf8'), 'bad')
    const interruptedNew = path.join(root, 'new.sqlite')
    fs.writeFileSync(`${interruptedNew}.pending-dead`, 'partial')
    assert.throws(() => new DatabaseSync(interruptedNew), /Не удалось открыть/)
    assert.equal(fs.existsSync(interruptedNew), false)
    const unreadableBackups = path.join(root, 'missing-with-backups.sqlite')
    fs.writeFileSync(`${unreadableBackups}-autobackups`, 'unavailable backup directory')
    assert.throws(() => new DatabaseSync(unreadableBackups), /Не удалось открыть/)
    assert.equal(fs.existsSync(unreadableBackups), false)

    const rotating = path.join(root, 'rotation.sqlite')
    db = new DatabaseSync(rotating, { autoBackup: true, backupLimit: 3, backupIntervalMs: 0 })
    db.exec('CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (1)')
    const backupDir = db.getBackupStatus().directory
    fs.writeFileSync(path.join(backupDir, 'manual.bossshop'), 'do not rotate')
    for (let n = 2; n <= 6; n++) db.prepare('UPDATE sample SET value=?').run(n)
    const status = db.getBackupStatus()
    assert.equal(status.count, 3); assert.equal(status.error, '')
    const values = fs.readdirSync(backupDir).filter(name => name.startsWith('auto-')).map(name => readValue(path.join(backupDir, name)))
    assert.deepEqual(values.sort(), [4, 5, 6])
    assert.equal(fs.readFileSync(path.join(backupDir, 'manual.bossshop'), 'utf8'), 'do not rotate')
    const manual = path.join(root, 'manual.bossshop'); await backup(db, manual)
    db.prepare('UPDATE sample SET value=7').run()
    const savedRestoreRename = fs.renameSync
    fs.renameSync = (source, destination) => { if (destination === rotating) throw new Error('injected restore EACCES'); return savedRestoreRename(source, destination) }
    try { assert.throws(() => db.restoreFrom(manual), /restore EACCES/) } finally { fs.renameSync = savedRestoreRename }
    assert.equal(db.prepare('SELECT value FROM sample').get().value, 7)
    assert.equal(readValue(rotating), 7)
    db.restoreFrom(manual)
    assert.equal(db.prepare('SELECT value FROM sample').get().value, 6)
    db.close(); db = null
    // Recovery from an automatic copy if both primary and previous are unusable.
    fs.writeFileSync(rotating, 'bad'); fs.writeFileSync(`${rotating}.previous`, 'bad')
    db = new DatabaseSync(rotating); assert.equal(db.prepare('SELECT value FROM sample').get().value, 7); db.close(); db = null
    replaceDatabaseFile(rotating, fs.readFileSync(manual))
    assert.equal(readValue(rotating), 6)

    // Backup failures report their own status but do not undo an acknowledged save.
    const unavailable = path.join(root, 'unavailable.sqlite')
    db = new DatabaseSync(unavailable, { autoBackup: true, backupIntervalMs: 0 })
    fs.writeFileSync(db.backupDirectory, 'not a directory')
    db.exec('CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (1)')
    assert.ok(db.getBackupStatus().error); assert.equal(readValue(unavailable), 1)
    db.close(); db = null
    console.log('Persistence passed: disk errors, SIGKILL at 5 save stages, rollback state, reopen/recovery, automatic rotation and manual backup')
  } finally {
    try { db?.close() } catch {}
    // root is an explicitly created temporary test directory.
    fs.rmSync(root, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
