const costing = require('./stock-cost.cjs')

function saleDay(value) {
  // Read the calendar portion directly. Never convert a shop date through UTC.
  const day = String(value || '').slice(0, 10)
  const parsed = new Date(`${day}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) throw new Error('Укажите корректную дату продажи')
  return day
}

function saleHeader(db, sale) {
  const date = saleDay(sale.date)
  const payment = String(sale.paymentMethod || 'Наличные')
  if (!['Наличные', 'Карта', 'Перевод', 'Смешанная'].includes(payment)) throw new Error('Неизвестный способ оплаты')
  const employee = sale.employeeId ? costing.integer(sale.employeeId, 'Сотрудник', true) : null
  if (employee && !db.prepare('SELECT id FROM employees WHERE id=? AND active=1').get(employee)) throw new Error('Сотрудник не найден')
  return [date, payment, employee, String(sale.comment || '').trim()]
}

function validateLines(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Добавьте товары в продажу')
  const variants = new Set(), ids = new Set()
  let total = 0
  return items.map(item => {
    const line = { id: item.id == null ? null : costing.integer(item.id, 'Строка', true), variantId: item.variantId == null && item.id ? null : costing.integer(item.variantId, 'Товар', true), quantity: costing.integer(item.quantity, 'Количество продажи', true), salePrice: costing.integer(item.salePrice, 'Цена продажи') }
    if ((line.variantId != null && variants.has(line.variantId)) || (line.id && ids.has(line.id))) throw new Error('Повтор товара или строки в продаже')
    if (line.variantId != null) variants.add(line.variantId); if (line.id) ids.add(line.id)
    total = costing.sum(total, costing.multiply(line.quantity, line.salePrice))
    return line
  })
}

// Called inside the repository's durable transaction. Existing line IDs and
// snapshots survive edits; only added units use the current weighted stock cost.
function editSale(db, user, sale, setStock, variant, audit) {
  const before = db.prepare('SELECT * FROM sales WHERE id=?').get(sale.id)
  if (!before) throw new Error('Продажа не найдена')
  if (sale.expectedVersion !== before.edit_version) throw new Error('Продажа уже изменена или оформлен возврат. Откройте её заново.')
  const header = saleHeader(db, sale)
  const old = db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(before.id)
  const lines = sale.items === undefined ? old.map(x => ({ id: x.id, variantId: x.variant_id, quantity: x.quantity, salePrice: x.sale_price })) : validateLines(sale.items)
  const byId = new Map(old.map(x => [x.id, x]))
  for (const line of lines) if (line.id && !byId.has(line.id)) throw new Error('Строка не принадлежит этой продаже')
  for (const previous of old) {
    const next = lines.find(x => x.id === previous.id)
    if (previous.variant_id == null && (!next || next.variantId != null || next.quantity !== previous.quantity || next.salePrice !== previous.sale_price)) throw new Error('Товар полностью удалён: состав и цена этой строки защищены. Реквизиты и другие строки можно менять.')
    if (previous.returned_quantity && (!next || next.variantId !== previous.variant_id || next.quantity !== previous.quantity || next.salePrice !== previous.sale_price)) {
      throw new Error('У строки есть возвраты: нельзя менять товар, количество, цену или удалять строку. Дата, оплата, сотрудник, комментарий и строки без возвратов доступны для правки.')
    }
  }
  const move = (id, delta) => {
    if (delta) db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,document_id,note,created_by) VALUES (?,?,?,?,?,?,?)')
      .run(header[0], id, 'sale_edit', delta, before.id, `Правка продажи ${before.sale_no}`, user.id)
  }
  // Release historical units first, then reserve additions. Failure in either
  // phase rolls back stock, movements, rows, version and audit together.
  const keptCost = new Map()
  for (const previous of old) {
    const next = lines.find(x => x.id === previous.id)
    const retained = next?.variantId === previous.variant_id ? Math.min(previous.quantity, next.quantity) : 0
    const cost = costing.allocate(previous.cost, previous.quantity, retained)
    keptCost.set(previous.id, cost)
    const released = previous.quantity - retained
    if (released) { setStock(previous.variant_id, costing.receive(variant(previous.variant_id), released, previous.cost - cost)); move(previous.variant_id, released) }
    if (!next) db.prepare('DELETE FROM sale_items WHERE id=?').run(previous.id)
  }
  let totalCost = 0
  for (const line of lines) {
    const previous = byId.get(line.id)
    const same = previous?.variant_id === line.variantId
    const extra = line.quantity - (same ? Math.min(previous.quantity, line.quantity) : 0)
    let cost = same ? keptCost.get(previous.id) : 0
    let purchase = same ? previous.purchase_price : 0
    let snapshot
    if (extra) {
      const v = db.prepare(`SELECT pv.*,p.article,p.name,p.brand,p.active product_active,c.name category,sz.name size FROM product_variants pv
        JOIN products p ON p.id=pv.product_id LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN sizes sz ON sz.id=pv.size_id WHERE pv.id=?`).get(line.variantId)
      if (!v || !v.active || !v.product_active || extra > v.quantity) throw new Error(`Недостаточно товара или позиция недоступна: ${v?.name || line.variantId}`)
      const taken = costing.take(v, extra)
      cost = costing.sum(cost, taken.cost)
      // A zero snapshot continues to mean unknown cost in existing reports.
      purchase = same && (!purchase || !v.purchase_price) ? 0 : costing.allocate(cost, line.quantity, 1)
      setStock(v.id, taken); move(v.id, -extra)
      snapshot = [v.article, v.name, v.category || '', v.brand || '', v.size || '', v.color || '']
    }
    const revenue = costing.multiply(line.quantity, line.salePrice)
    totalCost = costing.sum(totalCost, cost)
    if (previous) {
      db.prepare('UPDATE sale_items SET variant_id=?,quantity=?,purchase_price=?,sale_price=?,revenue=?,cost=?,gross_profit=? WHERE id=?')
        .run(line.variantId, line.quantity, purchase, line.salePrice, revenue, cost, revenue - cost, previous.id)
      if (!same) db.prepare('UPDATE sale_items SET article_snapshot=?,product_snapshot=?,category_snapshot=?,brand_snapshot=?,size_snapshot=?,color_snapshot=? WHERE id=?').run(...snapshot, previous.id)
    } else {
      db.prepare(`INSERT INTO sale_items(sale_id,variant_id,article_snapshot,product_snapshot,category_snapshot,brand_snapshot,size_snapshot,color_snapshot,quantity,purchase_price,sale_price,revenue,cost,gross_profit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(before.id, line.variantId, ...snapshot, line.quantity, purchase, line.salePrice, revenue, cost, revenue - cost)
    }
  }
  db.prepare('UPDATE sales SET sold_at=?,payment_method=?,employee_id=?,comment=?,edit_version=edit_version+1 WHERE id=?').run(...header, before.id)
  // Date edits move the original sale and its corrections into the same period.
  db.prepare("UPDATE stock_movements SET moved_at=? WHERE document_id=? AND movement_type IN ('sale','sale_edit')").run(header[0], before.id)
  audit(user.id, 'UPDATE', 'sale', before.id, JSON.stringify({ before: { ...before, items: old }, after: { date: header[0], paymentMethod: header[1], employeeId: header[2], comment: header[3], items: lines } }))
  return { id: before.id, version: before.edit_version + 1 }
}

module.exports = { saleDay, saleHeader, validateLines, editSale }
