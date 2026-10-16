const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { unzipSync, strFromU8 } = require('fflate')
const costing = require('./stock-cost.cjs')

const MAX_FILE_SIZE = 25 * 1024 * 1024
const MAX_ROWS = 50000

function decodeXml(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function xmlText(value = '') {
  return decodeXml(Array.from(String(value).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g), match => match[1]).join(''))
}

function columnIndex(reference = '') {
  const letters = String(reference).match(/^[A-Z]+/i)?.[0]?.toUpperCase() || 'A'
  let result = 0
  for (const char of letters) result = result * 26 + char.charCodeAt(0) - 64
  return result - 1
}

function normalizeTarget(target) {
  const clean = String(target || '').replace(/^\//, '').replace(/\\/g, '/')
  if (clean.startsWith('xl/')) return clean
  return path.posix.normalize(`xl/${clean}`).replace(/^\.\//, '')
}

function parseXlsx(filePath) {
  const archive = unzipSync(new Uint8Array(fs.readFileSync(filePath)))
  const read = name => archive[name] ? strFromU8(archive[name]) : ''
  const workbook = read('xl/workbook.xml')
  const relations = read('xl/_rels/workbook.xml.rels')
  if (!workbook || !relations) throw new Error('Файл Excel не содержит рабочей книги')

  const relTargets = new Map()
  for (const match of relations.matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)) {
    const attrs = match[1]
    const id = attrs.match(/\bId="([^"]+)"/)?.[1]
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1]
    if (id && target) relTargets.set(id, normalizeTarget(decodeXml(target)))
  }

  const sharedStrings = []
  const sharedXml = read('xl/sharedStrings.xml')
  for (const match of sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) sharedStrings.push(xmlText(match[1]))

  const sheets = []
  for (const match of workbook.matchAll(/<sheet\b([^>]*?)\/?\s*>/g)) {
    const attrs = match[1]
    if (/\bstate="(?:hidden|veryHidden)"/.test(attrs)) continue
    const name = decodeXml(attrs.match(/\bname="([^"]*)"/)?.[1] || 'Лист')
    const relId = attrs.match(/\br:id="([^"]+)"/)?.[1]
    const sheetXml = read(relTargets.get(relId))
    if (!sheetXml) continue
    const rows = [], rowNumbers = []
    for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = []
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cellMatch[1]
        const body = cellMatch[2] || ''
        const ref = attrs.match(/\br="([^"]+)"/)?.[1] || 'A1'
        const type = attrs.match(/\bt="([^"]+)"/)?.[1] || ''
        const raw = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1]
        let value = ''
        if (type === 'inlineStr') value = xmlText(body)
        else if (type === 's') value = sharedStrings[Number(raw)] ?? ''
        else if (type === 'b') value = raw === '1'
        else if (raw != null && raw !== '') value = Number.isFinite(Number(raw)) ? Number(raw) : decodeXml(raw)
        row[columnIndex(ref)] = value
      }
      rows.push(row)
      rowNumbers.push(Number(rowMatch[0].match(/<row\b[^>]*\br="(\d+)"/)?.[1]) || rows.length)
      if (rows.length > MAX_ROWS) throw new Error(`На листе «${name}» слишком много строк`)
    }
    sheets.push({ name, rows, rowNumbers })
  }
  return sheets
}

function parseCsvLine(line, delimiter) {
  const result = []
  let value = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++ } else quoted = !quoted
    } else if (char === delimiter && !quoted) { result.push(value); value = '' }
    else value += char
  }
  result.push(value)
  return result
}

function parseCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/).filter(line => line.trim())
  const first = lines[0] || ''
  const delimiter = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ','
  return [{ name: path.basename(filePath, path.extname(filePath)), rows: lines.slice(0, MAX_ROWS).map(line => parseCsvLine(line, delimiter)), rowNumbers: lines.slice(0, MAX_ROWS).map((_, index) => index + 1) }]
}

const aliases = {
  article: ['артикул', 'код', 'sku'],
  name: ['товар', 'вид товара', 'название', 'наименование'],
  category: ['категория', 'группа'],
  color: ['цвет'],
  size: ['размер'],
  price: ['цена', 'стоимость', 'розничная цена', 'закупочная цена'],
  quantity: ['количество', 'кол-во', 'остаток', 'шт'],
  marked: ['дата продажи', 'оплата', 'статус']
}

const normalized = value => String(value ?? '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ')

function detectColumns(row) {
  const result = {}
  row.forEach((value, index) => {
    const key = normalized(value)
    for (const [field, names] of Object.entries(aliases)) {
      if (!names.includes(key)) continue
      if (field === 'marked') {
        if (!Array.isArray(result.marked)) result.marked = []
        result.marked.push(index)
      } else if (result[field] == null) result[field] = index
    }
  })
  return result
}

function sheetCategory(name, rows) {
  const explicit = rows.slice(0, 3).flat().find(value => typeof value === 'string' && value.trim() && !Object.values(aliases).flat().includes(normalized(value)))
  const source = normalized(explicit || name)
  const names = [
    [/куртк/, 'Куртки'], [/верх/, 'Верхняя одежда'], [/жилет/, 'Жилеты'], [/костюм/, 'Костюмы'],
    [/свитер|кардиган/, 'Свитера и кардиганы'], [/худи|свитшот/, 'Худи и свитшоты'],
    [/футбол/, 'Футболки'], [/^поло$/, 'Поло'], [/рубаш|лонг/, 'Рубашки и лонгсливы'],
    [/джинс/, 'Джинсы'], [/брюк|шорт/, 'Брюки и шорты'], [/бель|акс/, 'Бельё и аксессуары'],
    [/шап|головн/, 'Головные уборы']
  ]
  return names.find(([pattern]) => pattern.test(source))?.[1] || (source.startsWith('лист') ? 'Аксессуары' : String(explicit || name).trim())
}

function toNumber(value) {
  const cleaned = String(value ?? '').replace(/[\s\u00a0₽]/g, '').replace(',', '.').replace(/[^\d.-]/g, '')
  const number = Number(cleaned)
  return Number.isFinite(number) ? number : 0
}

function makeArticle(category, name) {
  return `IMP-${crypto.createHash('sha1').update(`${normalized(category)}|${normalized(name)}`).digest('hex').slice(0, 10).toUpperCase()}`
}

function extractRows(sheets) {
  const grouped = new Map()
  let sourceRows = 0, skippedRows = 0
  const skipped = [], warnings = []
  const addSkipped = (sheet, row, name, reason) => {
    skippedRows++
    if (skipped.length < 1000) skipped.push({ sheet, row, name, reason })
  }
  for (const sheet of sheets) {
    let headerIndex = -1, columns = {}
    for (let index = 0; index < Math.min(sheet.rows.length, 20); index++) {
      const detected = detectColumns(sheet.rows[index])
      if (detected.name != null) { headerIndex = index; columns = detected; break }
    }
    if (headerIndex < 0) { warnings.push(`Лист «${sheet.name}»: столбец «Товар» не найден`); continue }
    const categoryFallback = sheetCategory(sheet.name, sheet.rows.slice(0, headerIndex + 1))
    for (let index = headerIndex + 1; index < sheet.rows.length; index++) {
      const row = sheet.rows[index]
      const rowNumber = sheet.rowNumbers?.[index] || index + 1
      const name = String(row[columns.name] ?? '').trim()
      if (!name) {
        if (row.some(value => String(value ?? '').trim())) addSkipped(sheet.name, rowNumber, '', 'Нет названия товара')
        continue
      }
      sourceRows++
      const marked = (Array.isArray(columns.marked) ? columns.marked : []).some(index => String(row[index] ?? '').trim())
      if (marked) { addSkipped(sheet.name, rowNumber, name, 'Есть отметка о продаже, оплате или браке'); continue }
      const category = String(columns.category == null ? categoryFallback : row[columns.category] || categoryFallback).trim()
      const article = String(columns.article == null ? '' : row[columns.article] ?? '').trim() || makeArticle(category, name)
      const size = String(columns.size == null ? '' : row[columns.size] ?? '').trim()
      const color = String(columns.color == null ? '' : row[columns.color] ?? '').trim()
      const priceValue = columns.price == null ? '' : row[columns.price]
      const priceCents = Math.round(toNumber(priceValue) * 100)
      if (!Number.isSafeInteger(priceCents) || priceCents < 0 || !/\d/.test(String(priceValue ?? ''))) {
        addSkipped(sheet.name, rowNumber, name, 'Не указана корректная цена'); continue
      }
      const rawQuantity = columns.quantity == null ? 1 : toNumber(row[columns.quantity])
      const quantity = Math.round(rawQuantity)
      if (!Number.isSafeInteger(rawQuantity) || quantity < 0) { addSkipped(sheet.name, rowNumber, name, 'Некорректное количество'); continue }
      const purchaseTotalCents = costing.multiply(quantity, priceCents)
      const key = [normalized(article), normalized(size), normalized(color)].join('|')
      const current = grouped.get(key)
      if (current) {
        current.quantity = costing.sum(current.quantity, quantity)
        current.purchaseTotalCents = costing.sum(current.purchaseTotalCents, purchaseTotalCents)
        if (current.priceCents !== priceCents) {
          if (warnings.length < 1000) warnings.push(`${sheet.name}, строка ${rowNumber}: у «${name}» другая цена; для розницы используется последняя, закупочная стоимость суммируется`)
          current.priceCents = priceCents
        }
      }
      else grouped.set(key, { article, name, category, size, color, priceCents, quantity, purchaseTotalCents, sourceSheet: sheet.name })
    }
  }
  if (!grouped.size) throw new Error('Не найдены строки товаров. Нужен столбец «Товар» или «Название».')
  for (const row of grouped.values()) row.purchasePriceCents = row.quantity ? costing.allocate(row.purchaseTotalCents, row.quantity, 1) : row.priceCents
  return { rows: Array.from(grouped.values()), sourceRows, skippedRows, skipped, warnings }
}

function parseImportFile(filePath) {
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_FILE_SIZE) throw new Error('Файл слишком большой. Максимальный размер — 25 МБ.')
  const extension = path.extname(filePath).toLowerCase()
  const sheets = extension === '.csv' ? parseCsv(filePath) : extension === '.xlsx' ? parseXlsx(filePath) : null
  if (!sheets) throw new Error('Поддерживаются только файлы Excel .xlsx и CSV')
  const extracted = extractRows(sheets)
  return {
    fileName: path.basename(filePath),
    sheetCount: sheets.length,
    ...extracted,
    preview: extracted.rows.slice(0, 12)
  }
}

module.exports = { parseImportFile }
