const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { zipSync, strToU8 } = require('fflate')
const { openDatabase } = require('./database.cjs')
const { createRepository } = require('./repository.cjs')

let mainWindow
let repository

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
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData')
  fs.mkdirSync(dataDir, { recursive: true })
  repository = createRepository(openDatabase(path.join(dataDir, 'boss-shop.sqlite')))
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

ipcMain.handle('boss-shop:api', async (_event, request) => {
  try {
    const handler = repository?.[request.action]
    if (!handler) throw new Error(`Неизвестная операция: ${request.action}`)
    return { ok: true, data: handler(request.payload || {}) }
  } catch (error) {
    return { ok: false, error: error?.message || 'Неизвестная ошибка' }
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
