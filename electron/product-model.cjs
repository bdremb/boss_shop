const costing = require('./stock-cost.cjs')
const { nextNumber, photoFields } = require('./catalog.cjs')
const { saleDay } = require('./sale-edit.cjs')

function createModel(db, p, user, audit) {
  if (p.productId || p.variantId) throw new Error('Список размеров доступен для новой модели')
  const autoNumber = nextNumber(db)
  if (!Array.isArray(p.variants) || !p.variants.length || p.variants.length > 200) throw new Error('Добавьте от 1 до 200 вариантов')
  if (p.subcategoryId && !db.prepare('SELECT id FROM subcategories WHERE id=? AND category_id=? AND active=1').get(p.subcategoryId, p.categoryId || null)) throw new Error('Подкатегория не принадлежит категории')
  const now = new Date()
  const date = p.arrivalDate ? saleDay(p.arrivalDate) : [now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-')
  const productId = Number(db.prepare('INSERT INTO products(auto_number,article,name,category_id,subcategory_id,brand,supplier_id,arrival_date,note,low_stock_threshold) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(autoNumber,String(autoNumber),p.name.trim(),p.categoryId||null,p.subcategoryId||null,String(p.brand||'').trim(),p.supplierId||null,p.arrivalDate||null,p.note||'',costing.integer(p.lowStockThreshold??2,'Порог')).lastInsertRowid)
  photoFields(db, productId, p.photoData)
  const seen = new Set(), variantIds = []
  for (const row of p.variants) {
    const name = String(row.sizeName ?? '').normalize('NFC').trim()
    if (!name || name.length > 40) throw new Error('Укажите размер (до 40 символов) для каждого варианта')
    const color = String(row.color || '').trim()
    const key = `${name.toLocaleUpperCase('ru-RU')}\0${color.toLocaleLowerCase('ru-RU')}`
    if (seen.has(key)) throw new Error(`Повтор размера и цвета: ${name} / ${color || 'без цвета'}`)
    seen.add(key)
    let size = db.prepare('SELECT id FROM sizes WHERE upper(name)=upper(?) OR name=? COLLATE NOCASE').get(name, name)
    // JS case folding also handles Cyrillic names in SQLite's ASCII upper().
    size ||= db.prepare('SELECT id,name FROM sizes').all().find(x => x.name.toLocaleUpperCase('ru-RU') === name.toLocaleUpperCase('ru-RU'))
    if (!size) size = { id: Number(db.prepare('INSERT INTO sizes(name,sort_order) VALUES (?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM sizes))').run(name).lastInsertRowid) }
    else db.prepare('UPDATE sizes SET active=1 WHERE id=?').run(size.id)
    const qty = costing.integer(row.quantity, 'Начальный остаток'), price = costing.integer(row.purchasePrice, 'Закупочная цена'), retail = costing.integer(row.retailPrice, 'Розничная цена')
    const id = Number(db.prepare('INSERT INTO product_variants(product_id,size_id,color,quantity,purchase_price,retail_price,barcode,stock_cost) VALUES (?,?,?,?,?,?,?,?)')
      .run(productId,size.id,color,qty,price,retail,String(row.barcode||'').trim(),costing.multiply(qty,price)).lastInsertRowid)
    variantIds.push(id)
    if (qty) db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,note,created_by) VALUES (?,?,?,?,?,?)')
      .run(date,id,'adjustment',qty,'Начальный остаток новой модели',user.id)
  }
  audit(user.id,'CREATE','product',productId,JSON.stringify({ article:String(autoNumber),variantIds }))
  return { productId, article:String(autoNumber), autoNumber, variantId:variantIds[0], variantIds }
}
module.exports = { createModel }
