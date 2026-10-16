const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { DatabaseSync, backup, initializeSqlite } = require('./sqlite.cjs')
const { zipSync, strToU8 } = require('fflate')
const { openDatabase } = require('./database.cjs')
const { createRepository } = require('./repository.cjs')
const { parseImportFile } = require('./importer.cjs')
const { normalizePhoto, preparePhoto, MAX_SOURCE } = require('./product-photo.cjs')

let mainWindow
let repository
let database
let databasePath
const pendingImports = new Map()
// Acquire before whenReady/initializeDatabase. A second sql.js process would
// otherwise overwrite the first process's data with its own in-memory copy.
const singleInstance = app.requestSingleInstanceLock()
let focusPending = false
if (!singleInstance) app.quit()
else app.on('second-instance', () => {
  if (!mainWindow) {
    focusPending = true
    if (repository && app.isReady()) createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

function initializeDatabase() {
  database = openDatabase(databasePath, { autoBackup: true })
  repository = createRepository(database)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d141b',
    title: 'Boss Shop',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
  if (focusPending) { mainWindow.show(); mainWindow.focus(); focusPending = false }
}

if (singleInstance) app.whenReady().then(async () => {
  const dataDir = app.getPath('userData')
  fs.mkdirSync(dataDir, { recursive: true })
  databasePath = path.join(dataDir, 'boss-shop.sqlite')
  await initializeSqlite()
  initializeDatabase()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(error => {
  dialog.showErrorBox('Не удалось открыть Boss Shop', error.message)
  app.quit()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { if (database) { database.close(); database = null } })

ipcMain.handle('boss-shop:api', async (_event, request) => {
  try {
    const handler = repository?.[request.action]
    if (!handler) throw new Error(`Неизвестная операция: ${request.action}`)
    if (request.action === 'saveProduct' && request.payload?.product?.photoData) {
      repository.authorizeAdmin(request.payload)
      const photo = request.payload.product.photoData
      if (typeof photo !== 'string' || photo.length > 820000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo)) throw new Error('Некорректное фото')
      request.payload.product.photoData = normalizePhoto(Buffer.from(photo.slice(23),'base64'), nativeImage)
    }
    return { ok: true, data: handler(request.payload || {}) }
  } catch (error) {
    return { ok: false, error: error?.message || 'Неизвестная ошибка' }
  }
})

ipcMain.handle('boss-shop:photo-select', async (_event, { token }) => {
  try {
    repository.authorizeAdmin({ _token:token })
    const result = await dialog.showOpenDialog(mainWindow, { title:'Выберите фото товара', properties:['openFile'], filters:[{name:'Фото JPEG, PNG, WebP',extensions:['jpg','jpeg','png','webp']}] })
    if (result.canceled || !result.filePaths[0]) return {ok:true,canceled:true}
    const file = result.filePaths[0]
    if (!/\.(jpe?g|png|webp)$/i.test(file)) throw new Error('Выберите фото JPEG, PNG или WebP')
    const fd = fs.openSync(file,'r')
    try {
      const size = fs.fstatSync(fd).size
      if (!size || size > MAX_SOURCE) throw new Error('Фото должно быть не больше 10 МБ')
      const bytes = Buffer.alloc(size)
      if (fs.readSync(fd,bytes,0,size,0) !== size) throw new Error('Не удалось полностью прочитать фото')
      return {ok:true,data:await preparePhoto(bytes,{nativeImage,BrowserWindow})}
    } finally { fs.closeSync(fd) }
  } catch (error) { return {ok:false,error:error.message} }
})

function validateBackupFile(filePath) {
  let candidate
  try {
    candidate = new DatabaseSync(filePath, { readOnly: true })
    const check = candidate.prepare('PRAGMA quick_check').get()
    if (!check || Object.values(check)[0] !== 'ok') throw new Error('Файл базы данных поврежден')
    const required = ['users', 'products', 'product_variants', 'sales', 'expenses', 'stock_movements']
    const found = candidate.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name IN (${required.map(() => '?').join(',')})`).get(...required)
    if (Number(found.count) !== required.length) throw new Error('Выбранный файл не является резервной копией Boss Shop')
  } finally {
    candidate?.close()
  }
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

ipcMain.handle('boss-shop:backup', async (_event, { token }) => {
  let temporaryPath = ''
  try {
    repository.authorizeAdmin({ _token: token })
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Сохранить резервную копию',
      defaultPath: `BossShop-backup-${new Date().toISOString().slice(0, 10)}.bossshop`,
      filters: [{ name: 'Резервная копия Boss Shop', extensions: ['bossshop'] }]
    })
    if (result.canceled || !result.filePath) return { ok: true, canceled: true }
    if (path.resolve(result.filePath).toLowerCase() === path.resolve(databasePath).toLowerCase()) throw new Error('Нельзя сохранить копию поверх рабочей базы')
    temporaryPath = `${result.filePath}.tmp-${process.pid}-${Date.now()}`
    database.exec('PRAGMA wal_checkpoint(FULL)')
    await backup(database, temporaryPath)
    validateBackupFile(temporaryPath)
    fs.renameSync(temporaryPath, result.filePath)
    temporaryPath = ''
    return { ok: true, path: result.filePath }
  } catch (error) {
    if (temporaryPath) { try { fs.rmSync(temporaryPath, { force: true }) } catch {} }
    return { ok: false, error: error?.message || 'Ошибка резервного копирования' }
  }
})

ipcMain.handle('boss-shop:restore', async (_event, { token }) => {
  let temporaryPath = ''
  try {
    repository.authorizeAdmin({ _token: token })
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите резервную копию Boss Shop',
      properties: ['openFile'],
      filters: [
        { name: 'Резервная копия Boss Shop', extensions: ['bossshop', 'sqlite', 'db'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return { ok: true, canceled: true }
    const sourcePath = result.filePaths[0]
    if (path.resolve(sourcePath).toLowerCase() === path.resolve(databasePath).toLowerCase()) throw new Error('Выбрана текущая рабочая база')
    validateBackupFile(sourcePath)

    const dataDir = path.dirname(databasePath)
    const stamp = safeTimestamp()
    const safetyPath = path.join(dataDir, `BossShop-before-restore-${stamp}.bossshop`)
    temporaryPath = path.join(dataDir, `boss-shop-restore-${process.pid}-${Date.now()}.tmp`)

    database.exec('PRAGMA wal_checkpoint(FULL)')
    await backup(database, safetyPath)
    fs.copyFileSync(sourcePath, temporaryPath)
    validateBackupFile(temporaryPath)

    database.restoreFrom(temporaryPath)
    repository = null
    for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) { try { fs.rmSync(sidecar, { force: true }) } catch {} }
    try { fs.rmSync(temporaryPath, { force: true }) } catch {}
    temporaryPath = ''

    setTimeout(() => { app.relaunch(); app.exit(0) }, 700)
    return { ok: true, safetyPath }
  } catch (error) {
    if (temporaryPath) { try { fs.rmSync(temporaryPath, { force: true }) } catch {} }
    return { ok: false, error: error?.message || 'Ошибка восстановления данных' }
  }
})

ipcMain.handle('boss-shop:import-select', async (_event, { token }) => {
  try {
    repository.authorizeAdmin({ _token: token })
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите файл с товарами',
      properties: ['openFile'],
      filters: [
        { name: 'Excel и CSV', extensions: ['xlsx', 'csv'] },
        { name: 'Excel', extensions: ['xlsx'] },
        { name: 'CSV', extensions: ['csv'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return { ok: true, canceled: true }
    const parsed = parseImportFile(result.filePaths[0])
    const importId = crypto.randomBytes(18).toString('hex')
    pendingImports.clear()
    pendingImports.set(importId, { token, rows: parsed.rows, fileName: parsed.fileName, createdAt: Date.now() })
    return { ok: true, importId, fileName: parsed.fileName, sheetCount: parsed.sheetCount, sourceRows: parsed.sourceRows, skippedRows: parsed.skippedRows, skipped: parsed.skipped, warnings: parsed.warnings, positions: parsed.rows.length, preview: parsed.preview }
  } catch (error) {
    return { ok: false, error: error?.message || 'Не удалось прочитать файл' }
  }
})

ipcMain.handle('boss-shop:import-commit', async (_event, { token, importId, priceMode, stockMode }) => {
  try {
    repository.authorizeAdmin({ _token: token })
    const pending = pendingImports.get(importId)
    if (!pending || pending.token !== token || Date.now() - pending.createdAt > 15 * 60 * 1000) throw new Error('Предпросмотр импорта устарел. Выберите файл снова.')
    const data = repository.importProducts({ _token: token, importRows: pending.rows, priceMode, stockMode, fileName: pending.fileName })
    pendingImports.delete(importId)
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: error?.message || 'Не удалось импортировать товары' }
  }
})

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))
const xmlEsc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))
const columnName = number => { let name = ''; while (number > 0) { number--; name = String.fromCharCode(65 + number % 26) + name; number = Math.floor(number / 26) } return name }

function createXlsx(rows) {
  const keys = Object.keys(rows[0])
  const sheetRows = [keys, ...rows.map(row => keys.map(key => row[key]))].map((values, rowIndex) => {
    const cells = values.map((value, columnIndex) => {
      const ref = `${columnName(columnIndex + 1)}${rowIndex + 1}`
      if (rowIndex > 0 && typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`
      return `<c r="${ref}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`
    }).join('')
    return `<row r="${rowIndex + 1}">${cells}</row>`
  }).join('')
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Отчет" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1D2832"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${columnName(keys.length)}${rows.length + 1}"/></worksheet>`)
  }
  return Buffer.from(zipSync(files, { level: 6 }))
}

ipcMain.handle('boss-shop:export', async (_event, { format, title, rows }) => {
  try {
    if (!Array.isArray(rows) || !rows.length) throw new Error('Нет данных для выгрузки')
    const extension = format === 'excel' ? 'xlsx' : format
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Сохранить отчет',
      defaultPath: `${title || 'Отчет'}.${extension}`,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
    })
    if (result.canceled || !result.filePath) return { ok: true, canceled: true }
    if (format === 'excel') {
      fs.writeFileSync(result.filePath, createXlsx(rows))
    } else if (format === 'csv') {
      const keys = Object.keys(rows[0])
      const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`
      const csv = [keys.map(csvCell).join(';'), ...rows.map(row => keys.map(key => csvCell(row[key])).join(';'))].join('\r\n')
      fs.writeFileSync(result.filePath, '\uFEFF' + csv, 'utf8')
    } else if (format === 'pdf') {
      const keys = Object.keys(rows[0])
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font:12px Arial;padding:28px;color:#1a2027}h1{font-size:22px;margin:0 0 18px}table{border-collapse:collapse;width:100%}
        th,td{border:1px solid #ccd1d6;padding:7px;text-align:left}th{background:#eef1f3}tr:nth-child(even){background:#f8f9fa}
        </style></head><body><h1>${esc(title)}</h1><table><thead><tr>${keys.map(k=>`<th>${esc(k)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(row=>`<tr>${keys.map(k=>`<td>${esc(row[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`
      const printWindow = new BrowserWindow({ show: false })
      await printWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      const pdf = await printWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4', landscape: keys.length > 6 })
      fs.writeFileSync(result.filePath, pdf)
      printWindow.destroy()
    }
    return { ok: true, path: result.filePath }
  } catch (error) { return { ok: false, error: error?.message || 'Ошибка экспорта' } }
})
