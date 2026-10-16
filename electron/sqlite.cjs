const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const initSqlJs = require('sql.js')

let SQL

async function initializeSqlite() {
  if (SQL) return
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
}

function validateBytes(bytes) {
  if (!bytes.length) throw new Error('Пустой файл базы данных')
  const candidate = new SQL.Database(bytes)
  try {
    const result = candidate.exec('PRAGMA quick_check')
    if (result[0]?.values?.[0]?.[0] !== 'ok') throw new Error('Файл базы данных поврежден')
  } finally { candidate.close() }
}

// Same-volume rename replaces the destination on Windows too. Never unlink the
// destination: an interrupted write must leave either the old or the new file.
function atomicWrite(filePath, bytes) {
  const temporary = `${filePath}.pending-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  let fd
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    fs.renameSync(temporary, filePath)
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
    try { fs.rmSync(temporary, { force: true }) } catch {}
  }
  // Directory flushing is unsupported on some Windows filesystems. No error
  // may turn an already published commit into a reported failed transaction.
  let directory
  try { directory = fs.openSync(path.dirname(filePath), 'r'); fs.fsyncSync(directory) } catch {}
  finally { if (directory !== undefined) { try { fs.closeSync(directory) } catch {} } }
}

function replaceDatabaseFile(filePath, bytes) {
  validateBytes(bytes)
  if (fs.existsSync(filePath)) {
    const previous = fs.readFileSync(filePath)
    validateBytes(previous)
    atomicWrite(`${filePath}.previous`, previous)
  }
  atomicWrite(filePath, bytes)
}

class StatementSync {
  constructor(database, sql) {
    this.database = database
    this.sql = sql
  }

  _statement(args) {
    const statement = this.database.inner.prepare(this.sql)
    if (args.length) statement.bind(args.map(value => value === undefined ? null : value))
    return statement
  }

  get(...args) {
    const statement = this._statement(args)
    try { return statement.step() ? statement.getAsObject() : undefined }
    finally { statement.free() }
  }

  all(...args) {
    const statement = this._statement(args)
    const result = []
    try { while (statement.step()) result.push(statement.getAsObject()); return result }
    finally { statement.free() }
  }

  run(...args) {
    return this.database._mutate(() => {
      this.database.inner.run(this.sql, args.map(value => value === undefined ? null : value))
      const info = this.database.inner.exec('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid')[0]
      return { changes: Number(info?.values?.[0]?.[0] || 0), lastInsertRowid: Number(info?.values?.[0]?.[1] || 0) }
    })
  }
}

class DatabaseSync {
  constructor(filePath, options = {}) {
    if (!SQL) throw new Error('SQLite не инициализирован')
    this.filePath = filePath
    this.readOnly = Boolean(options.readOnly ?? options.readonly)
    this.inTransaction = false
    this.dirty = false
    this.backupDirectory = path.join(path.dirname(filePath), `${path.basename(filePath)}-autobackups`)
    this.autoBackup = Boolean(options.autoBackup) && !this.readOnly
    this.backupLimit = options.backupLimit ?? 14
    this.backupIntervalMs = options.backupIntervalMs ?? 60 * 60 * 1000
    if (!Number.isInteger(this.backupLimit) || this.backupLimit < 1) throw new Error('Некорректный лимит автокопий')
    this.backupStatus = { directory: this.backupDirectory, limit: this.backupLimit, intervalMinutes: this.backupIntervalMs / 60000, lastBackup: null, error: '', recoveredFrom: '' }
    this.lastBackupTime = 0
    const bytes = this._load()
    this.inner = bytes ? new SQL.Database(bytes) : new SQL.Database()
    this._configure()
    if (bytes && this.autoBackup) this._autoBackup(bytes)
  }

  _configure() { this.inner.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000') }

  _load() {
    let error
    if (fs.existsSync(this.filePath)) {
      try { const bytes = fs.readFileSync(this.filePath); validateBytes(bytes); return bytes } catch (e) { error = e }
    } else if (this.readOnly) throw new Error('Файл базы данных не найден')
    if (this.readOnly) throw error
    const copies = [ `${this.filePath}.previous`, ...this._backupFiles().reverse().map(name => path.join(this.backupDirectory, name)) ]
    for (const copy of copies) {
      try {
        const bytes = fs.readFileSync(copy); validateBytes(bytes)
        if (fs.existsSync(this.filePath)) atomicWrite(`${this.filePath}.damaged-${Date.now()}`, fs.readFileSync(this.filePath))
        atomicWrite(this.filePath, bytes)
        this.backupStatus.recoveredFrom = copy
        return bytes
      } catch (e) {
        // Invalid candidates can be skipped; a failed publication must stop startup.
        if (fs.existsSync(copy)) {
          try { validateBytes(fs.readFileSync(copy)) } catch { continue }
          throw e
        }
      }
    }
    const basename = path.basename(this.filePath)
    const pending = fs.readdirSync(path.dirname(this.filePath)).some(name => name.startsWith(`${basename}.pending-`) || name.startsWith(`${basename}.previous.pending-`))
    if (error || pending || fs.existsSync(this.backupDirectory) || copies.some(copy => fs.existsSync(copy))) throw new Error('Не удалось открыть базу. Сохранённые файлы оставлены для восстановления из резервной копии.', { cause: error })
    return null
  }

  _backupFiles(strict = false) {
    try {
      if (!fs.existsSync(this.backupDirectory)) return []
      return fs.readdirSync(this.backupDirectory).filter(name => /^auto-\d{13}-[a-f0-9]+\.bossshop$/.test(name)).sort()
    } catch (error) { this.backupStatus.error = error.message; if (strict) throw error; return [] }
  }

  _autoBackup(bytes) {
    if (!this.autoBackup || Date.now() - this.lastBackupTime < this.backupIntervalMs) return
    try {
      fs.mkdirSync(this.backupDirectory, { recursive: true })
      const previousStamp = Number(this._backupFiles(true).at(-1)?.slice(5, 18)) || 0
      const stamp = Math.max(Date.now(), previousStamp + 1)
      const destination = path.join(this.backupDirectory, `auto-${stamp}-${crypto.randomBytes(6).toString('hex')}.bossshop`)
      atomicWrite(destination, bytes)
      this.backupStatus.lastBackup = destination
      for (const name of this._backupFiles(true).slice(0, -this.backupLimit)) fs.rmSync(path.join(this.backupDirectory, name))
      this.lastBackupTime = Date.now()
      this.backupStatus.error = ''
    } catch (error) { this.backupStatus.error = error.message }
  }

  getBackupStatus() {
    const files = this._backupFiles()
    return { ...this.backupStatus, enabled: this.autoBackup, count: files.length, lastBackup: this.backupStatus.lastBackup || (files.length ? path.join(this.backupDirectory, files.at(-1)) : null) }
  }

  _export() {
    if (this.inTransaction) throw new Error('Нельзя экспортировать незавершённую транзакцию')
    try { return Buffer.from(this.inner.export()) } finally { this._configure() }
  }

  _restoreSnapshot(bytes) {
    this.inner.close()
    this.inner = new SQL.Database(bytes)
    this._configure()
    this.inTransaction = false
    this.dirty = false
    this.transactionSnapshot = null
    this.migrating = false
  }

  // SQLite table reconstruction needs FKs disabled before BEGIN. This is only
  // for startup migrations: validate all links before commit and always enable
  // enforcement again on commit, rollback or persistence snapshot restoration.
  beginMigration() {
    if (this.readOnly || this.inTransaction) throw new Error('Нельзя начать миграцию')
    this.transactionSnapshot = this._export()
    this.inner.exec('PRAGMA foreign_keys=OFF')
    try {
      this.inner.exec('BEGIN IMMEDIATE')
      this.inTransaction = true
      this.migrating = true
    } catch (error) { this._configure(); this.transactionSnapshot = null; throw error }
  }

  exec(sql) {
    const normalized = sql.trim().toUpperCase()
    if (normalized.startsWith('PRAGMA WAL_CHECKPOINT')) return []
    if (this.readOnly && !normalized.startsWith('SELECT') && !normalized.startsWith('PRAGMA')) throw new Error('База открыта только для чтения')
    if (/^BEGIN\b/.test(normalized)) {
      if (this.inTransaction) throw new Error('Транзакция уже открыта')
      this.transactionSnapshot = this._export()
      const result = this.inner.exec(sql)
      this.inTransaction = true
      return result
    }
    if (/^COMMIT\b/.test(normalized)) {
      const snapshot = this.transactionSnapshot
      if (this.migrating && this.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Ошибка миграции связей истории')
      const result = this.inner.exec(sql)
      this.inTransaction = false
      this.migrating = false
      this._configure()
      try { this._persist() } catch (error) { this._restoreSnapshot(snapshot); throw error }
      this.transactionSnapshot = null
      return result
    }
    if (/^ROLLBACK\b/.test(normalized)) {
      const result = this.inner.exec(sql)
      this.inTransaction = false; this.dirty = false; this.transactionSnapshot = null
      this.migrating = false
      this._configure()
      return result
    }
    // Only a single SELECT/PRAGMA is read-only; schema batches can begin with PRAGMA.
    if (/^(SELECT|PRAGMA)\b/.test(normalized) && !normalized.replace(/;\s*$/, '').includes(';')) return this.inner.exec(sql)
    return this._mutate(() => this.inner.exec(sql))
  }

  prepare(sql) { return new StatementSync(this, sql) }

  _mutate(fn) {
    if (this.readOnly) throw new Error('База открыта только для чтения')
    const snapshot = this.inTransaction ? null : this._export()
    try {
      const result = fn()
      this.dirty = true
      if (!this.inTransaction) this._persist()
      return result
    } catch (error) {
      if (snapshot) this._restoreSnapshot(snapshot)
      throw error
    }
  }

  _persist() {
    if (this.readOnly || !this.dirty) return
    const bytes = this._export()
    replaceDatabaseFile(this.filePath, bytes)
    this.dirty = false
    this._autoBackup(bytes)
  }

  exportTo(destinationPath) {
    atomicWrite(destinationPath, this._export())
  }

  restoreFrom(sourcePath) {
    if (this.readOnly || this.inTransaction) throw new Error('Нельзя восстановить базу в текущем состоянии')
    const bytes = fs.readFileSync(sourcePath)
    validateBytes(bytes)
    // Prepare the replacement connection before publishing. A failed disk
    // replacement leaves both the old file and the usable old connection intact.
    const restored = new SQL.Database(bytes)
    try {
      restored.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
      replaceDatabaseFile(this.filePath, bytes)
    } catch (error) { restored.close(); throw error }
    this.inner.close()
    this.inner = restored
    this.dirty = false
    this.transactionSnapshot = null
  }

  close() {
    if (this.inTransaction) this.exec('ROLLBACK')
    this._persist()
    this.inner.close()
  }
}

async function backup(database, destinationPath) {
  database.exportTo(destinationPath)
}

module.exports = { DatabaseSync, backup, initializeSqlite, atomicWrite, replaceDatabaseFile }
