const crypto = require('node:crypto')

function migrateCatalog(db) {
  // Detached history and audit must never point at a newly reused catalog ID.
  for (const table of ['products','product_variants']) {
    const ddl=db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(table).sql
    if (/AUTOINCREMENT/i.test(ddl)) continue
    const objects=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table)
    const names=db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name).join(',')
    db.exec(ddl.replace(new RegExp(`CREATE TABLE ${table}`,'i'),`CREATE TABLE catalog_ids_${table}`).replace(/id INTEGER PRIMARY KEY/i,'id INTEGER PRIMARY KEY AUTOINCREMENT'))
    db.exec(`INSERT INTO catalog_ids_${table}(${names}) SELECT ${names} FROM ${table}`)
    db.exec(`DROP TABLE ${table}`)
    db.exec(`ALTER TABLE catalog_ids_${table} RENAME TO ${table}`)
    for(const object of objects) db.exec(object.sql)
    const type=table==='products'?'product':'variant'
    const high=db.prepare('SELECT COALESCE(MAX(entity_id),0) value FROM audit_log WHERE entity_type=?').get(type).value
    db.prepare('INSERT INTO sqlite_sequence(name,seq) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name=?)').run(table,high,table)
    db.prepare('UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?').run(high,table)
  }
  const columns = db.prepare('PRAGMA table_info(products)').all()
  if (!columns.some(x => x.name === 'auto_number')) db.exec('ALTER TABLE products ADD COLUMN auto_number INTEGER')
  if (!columns.some(x => x.name === 'photo_data')) db.exec("ALTER TABLE products ADD COLUMN photo_data TEXT NOT NULL DEFAULT ''")
  if (!columns.some(x => x.name === 'photo_key')) db.exec("ALTER TABLE products ADD COLUMN photo_key TEXT NOT NULL DEFAULT ''")
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_auto_number ON products(auto_number);
    CREATE TABLE IF NOT EXISTS catalog_sequence (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL CHECK(value>=0));
    INSERT OR IGNORE INTO catalog_sequence VALUES(1,0)`)
  // Persistent high water mark; legacy numeric articles are never renumbered.
  for (const row of db.prepare('SELECT article,auto_number FROM products').all()) reserveNumber(db, row.article, row.auto_number)
  const tables = ['sale_items','receipt_items','writeoff_items','stock_movements','return_items']
  if (!db.prepare('PRAGMA table_info(sale_items)').all().find(x => x.name === 'variant_id').notnull) return
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('index','trigger')").all().filter(x => tables.includes(x.tbl_name))
  const sequences = db.prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'").get() ? db.prepare('SELECT * FROM sqlite_sequence').all().filter(x=>tables.includes(x.name)) : []
  for (const table of tables) {
    let ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql
    ddl = ddl.replace(new RegExp(`CREATE TABLE ${table}`, 'i'), `CREATE TABLE catalog_new_${table}`)
      .replace(/variant_id INTEGER NOT NULL REFERENCES product_variants\(id\)/i, 'variant_id INTEGER REFERENCES product_variants(id) ON DELETE SET NULL')
    if (table !== 'sale_items') ddl = ddl.replace(/\)\s*$/, ", catalog_snapshot TEXT NOT NULL DEFAULT '')")
    db.exec(ddl)
    const names = db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name).join(',')
    db.exec(`INSERT INTO catalog_new_${table}(${names}) SELECT ${names} FROM ${table}`)
  }
  // Drop child first; migration validates all links before durable commit.
  for (const table of [...tables].reverse()) db.exec(`DROP TABLE ${table}`)
  for (const table of tables) db.exec(`ALTER TABLE catalog_new_${table} RENAME TO ${table}`)
  for (const object of objects) db.exec(object.sql)
  for (const row of sequences) db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(row.seq,row.name)
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Ошибка миграции связей истории')
}

function reserveNumber(db, article, number = 0) {
  const numeric = /^\d+$/.test(String(article)) ? Number(article) : 0
  const high = Math.max(Number(number)||0, Number.isSafeInteger(numeric) ? numeric : 0)
  if (high) db.prepare('UPDATE catalog_sequence SET value=MAX(value,?) WHERE id=1').run(high)
}

function nextNumber(db) {
  if (!db.inTransaction) throw new Error('Номер выделяется только в транзакции')
  let value = db.prepare('SELECT value FROM catalog_sequence WHERE id=1').get().value
  do {
    value++
    if (!Number.isSafeInteger(value)) throw new Error('Исчерпан диапазон номеров товаров')
  } while (db.prepare('SELECT id FROM products WHERE article=? OR auto_number=?').get(String(value),value))
  db.prepare('UPDATE catalog_sequence SET value=? WHERE id=1').run(value)
  return value
}

function photoFields(db, productId, data) {
  if (data === undefined) return
  const { validatePhotoData } = require('./product-photo.cjs')
  validatePhotoData(data)
  db.prepare('UPDATE products SET photo_data=?,photo_key=? WHERE id=?').run(data, data ? crypto.createHash('sha256').update(data).digest('hex') : '', productId)
}

function ensureHistorySnapshots(db) {
  for (const table of ['receipt_items','writeoff_items','stock_movements','return_items']) {
    const snapshot = `(SELECT json_object('article',p.article,'name',p.name,'size',COALESCE(sz.name,''),'color',pv.color,'variantId',pv.id,'productId',p.id)
      FROM product_variants pv JOIN products p ON p.id=pv.product_id LEFT JOIN sizes sz ON sz.id=pv.size_id WHERE pv.id=${table}.variant_id)`
    db.exec(`UPDATE ${table} SET catalog_snapshot=${snapshot} WHERE catalog_snapshot='' AND variant_id IS NOT NULL`)
    db.exec(`CREATE TRIGGER IF NOT EXISTS snapshot_${table} AFTER INSERT ON ${table} WHEN NEW.catalog_snapshot='' BEGIN
      UPDATE ${table} SET catalog_snapshot=${snapshot} WHERE id=NEW.id; END`)
  }
}

function deleteModel(db, productId, user, audit) {
  const product = db.prepare('SELECT id,article,name,auto_number FROM products WHERE id=?').get(productId)
  if (!product) throw new Error('Модель не найдена')
  const variants = db.prepare(`SELECT pv.*,COALESCE(sz.name,'') size FROM product_variants pv LEFT JOIN sizes sz ON sz.id=pv.size_id WHERE product_id=?`).all(productId)
  for (const v of variants) {
    const snapshot = JSON.stringify({ article:product.article,name:product.name,size:v.size,color:v.color,variantId:v.id,productId:product.id })
    for (const table of ['receipt_items','writeoff_items','stock_movements','return_items']) db.prepare(`UPDATE ${table} SET catalog_snapshot=? WHERE variant_id=? AND catalog_snapshot=''`).run(snapshot,v.id)
  }
  const saleIds = db.prepare('SELECT DISTINCT sale_id FROM sale_items WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id=?)').all(productId)
  for (const row of saleIds) db.prepare('UPDATE sales SET edit_version=edit_version+1 WHERE id=?').run(row.sale_id)
  db.prepare('DELETE FROM product_variants WHERE product_id=?').run(productId)
  db.prepare('DELETE FROM products WHERE id=?').run(productId)
  audit(user.id,'DELETE','product',productId,JSON.stringify({ ...product,variants:variants.map(v=>({id:v.id,size:v.size,color:v.color,quantity:v.quantity,stockCost:v.stock_cost})),quantityRemoved:variants.reduce((n,v)=>n+v.quantity,0),costRemoved:variants.reduce((n,v)=>n+v.stock_cost,0) }))
  return true
}

module.exports = { migrateCatalog, ensureHistorySnapshots, nextNumber, reserveNumber, photoFields, deleteModel }
