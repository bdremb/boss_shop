const crypto = require('node:crypto')
const { hashPassword, verifyPassword } = require('./database.cjs')
const costing = require('./stock-cost.cjs')
const { saleHeader, validateLines, editSale } = require('./sale-edit.cjs')
const { createModel } = require('./product-model.cjs')

const { nextNumber, reserveNumber, photoFields, deleteModel } = require('./catalog.cjs')

const sessions = new Map()
const isoNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const documentNo = prefix => `${prefix}-${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}-${Math.floor(Math.random() * 900 + 100)}`
const rows = (statement, ...args) => (Array.isArray(statement) ? statement : statement.all(...args)).map(x => ({ ...x }))
const searchText = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е')

function createRepository(db) {
  function auth(token, roles = ['admin', 'seller']) {
    const user = sessions.get(token)
    if (!user) throw new Error('Сессия истекла. Войдите снова.')
    if (!roles.includes(user.role)) throw new Error('Недостаточно прав для этой операции')
    return user
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result } catch (e) { if (db.inTransaction) db.exec('ROLLBACK'); throw e }
  }

  function setStock(id, stock) {
    db.prepare('UPDATE product_variants SET quantity=?,stock_cost=?,purchase_price=? WHERE id=?').run(stock.quantity, stock.total, stock.price, id)
  }

  function variant(id) {
    const item = db.prepare('SELECT * FROM product_variants WHERE id=?').get(id)
    if (!item) throw new Error('Складская позиция не найдена')
    return item
  }

  function audit(userId, action, entityType, entityId, details = '') {
    db.prepare('INSERT INTO audit_log(user_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?)')
      .run(userId, action, entityType, entityId ?? null, details)
  }

  function periodWhere(column) { return `${column} >= ? AND ${column} < date(?, '+1 day')` }

  const api = {
    login({ login, password }) {
      const user = db.prepare('SELECT * FROM users WHERE login=? AND active=1').get(String(login || '').trim())
      if (!user || !verifyPassword(String(password || ''), user.password_hash)) throw new Error('Неверный логин или пароль')
      const token = crypto.randomBytes(32).toString('hex')
      const safe = { id: Number(user.id), login: user.login, displayName: user.display_name, role: user.role }
      sessions.set(token, safe)
      return { token, user: safe }
    },
    logout({ _token }) { sessions.delete(_token); return true },
    authorizeAdmin({ _token }) { auth(_token, ['admin']); return true },
    backupStatus({ _token }) { auth(_token, ['admin']); return db.getBackupStatus() },

    bootstrap({ _token }) {
      const user = auth(_token)
      return {
        user,
        categories: rows(db.prepare('SELECT id,name FROM categories WHERE active=1 ORDER BY name')),
        subcategories: rows(db.prepare('SELECT id,category_id AS categoryId,name FROM subcategories WHERE active=1 ORDER BY name')),
        sizes: rows(db.prepare('SELECT id,name FROM sizes WHERE active=1 ORDER BY sort_order,name')),
        suppliers: rows(db.prepare('SELECT id,name,phone,note FROM suppliers WHERE active=1 ORDER BY name')),
        employees: rows(db.prepare('SELECT id,name,phone FROM employees WHERE active=1 ORDER BY name')),
        expenseCategories: rows(db.prepare('SELECT id,name,group_name AS groupName FROM expense_categories WHERE active=1 ORDER BY group_name,name'))
      }
    },

    dashboard({ _token, from, to }) {
      const user = auth(_token)
      const sales = db.prepare(`SELECT COUNT(DISTINCT s.id) sales_count, COALESCE(SUM(si.quantity),0) units,
        COALESCE(SUM(si.revenue),0) revenue, COALESCE(SUM(si.cost),0) cost
        FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE ${periodWhere('s.sold_at')}`).get(from, to)
      const returns = db.prepare(`SELECT COALESCE(SUM(ri.quantity),0) units, COALESCE(SUM(ri.revenue),0) revenue, COALESCE(SUM(ri.cost),0) cost
        FROM returns r JOIN return_items ri ON ri.return_id=r.id WHERE ${periodWhere('r.returned_at')}`).get(from, to)
      const expenses = db.prepare(`SELECT COALESCE(SUM(amount),0) amount FROM expenses WHERE ${periodWhere('expense_date')}`).get(from, to)
      const missingSaleCost = db.prepare(`SELECT COALESCE(SUM(si.quantity),0) units FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE ${periodWhere('s.sold_at')} AND si.purchase_price=0`).get(from, to)
      const missingReturnCost = db.prepare(`SELECT COALESCE(SUM(ri.quantity),0) units FROM returns r JOIN return_items ri ON ri.return_id=r.id JOIN sale_items si ON si.id=ri.sale_item_id WHERE ${periodWhere('r.returned_at')} AND si.purchase_price=0`).get(from, to)
      const missingCostUnits = Number(missingSaleCost.units) + Number(missingReturnCost.units)
      const revenue = Number(sales.revenue) - Number(returns.revenue)
      const cost = Number(sales.cost) - Number(returns.cost)
      const expense = Number(expenses.amount)
      const metrics = {
        salesCount: Number(sales.sales_count), units: Number(sales.units) - Number(returns.units), revenue,
        cost, grossProfit: revenue - cost, expenses: expense, netProfit: revenue - cost - expense,
        margin: revenue ? ((revenue - cost) / revenue) * 100 : 0, missingCostUnits
      }
      const trend = rows(db.prepare(`SELECT day, SUM(revenue) revenue, SUM(cost) cost FROM (
        SELECT date(s.sold_at) day, si.revenue revenue, si.cost cost FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE ${periodWhere('s.sold_at')}
        UNION ALL SELECT date(r.returned_at), -ri.revenue, -ri.cost FROM returns r JOIN return_items ri ON ri.return_id=r.id WHERE ${periodWhere('r.returned_at')}
      ) GROUP BY day ORDER BY day`), from, to, from, to)
      const lowStock = rows(db.prepare(`SELECT pv.id variantId,p.article,p.name,COALESCE(sz.name,'—') size,pv.color,pv.quantity,p.low_stock_threshold threshold
        FROM product_variants pv JOIN products p ON p.id=pv.product_id LEFT JOIN sizes sz ON sz.id=pv.size_id
        WHERE p.active=1 AND pv.active=1 AND pv.quantity<=p.low_stock_threshold ORDER BY pv.quantity,p.name LIMIT 8`))
      const stock = db.prepare('SELECT COALESCE(SUM(quantity),0) total, COUNT(CASE WHEN quantity>0 THEN 1 END) positions FROM product_variants WHERE active=1').get()
      const missingCost = db.prepare('SELECT COUNT(*) variants,COALESCE(SUM(pv.quantity),0) units FROM product_variants pv JOIN products p ON p.id=pv.product_id WHERE p.active=1 AND pv.active=1 AND pv.quantity>0 AND pv.purchase_price=0').get()
      if (missingCostUnits && user.role === 'admin') {
        metrics.cost = null; metrics.grossProfit = null; metrics.netProfit = null; metrics.margin = null
      }
      if (user.role === 'seller') {
        metrics.cost = null; metrics.grossProfit = null; metrics.expenses = null; metrics.netProfit = null; metrics.margin = null; metrics.missingCostUnits = null
        trend.forEach(x => { delete x.cost })
      }
      return { metrics, trend, lowStock, stock: { total: Number(stock.total), positions: Number(stock.positions) }, missingCost: user.role === 'admin' ? { variants: Number(missingCost.variants), units: Number(missingCost.units) } : null }
    },

    listProductBrands({ _token }) {
      auth(_token)
      return db.prepare("SELECT DISTINCT brand FROM products WHERE active=1 AND brand<>''").all().map(x=>x.brand).sort((a,b)=>a.localeCompare(b,'ru',{sensitivity:'base'}))
    },

    listProducts({ _token, search = '', categoryId = '', sizeId = '', brand = '', stock = '', cost = '', includeHidden = false }) {
      const user = auth(_token)
      const params = []
      const where = includeHidden && user.role==='admin' ? ['1=1'] : ['p.active=1', 'pv.active=1']
      if (categoryId) { where.push('p.category_id=?'); params.push(categoryId) }
      if (sizeId) { where.push('pv.size_id=?'); params.push(sizeId) }
      if (brand) { where.push('p.brand=?'); params.push(brand) }
      if (stock === 'available') where.push('pv.quantity>0')
      if (stock === 'low') where.push('pv.quantity>0 AND pv.quantity<=p.low_stock_threshold')
      if (stock === 'none') where.push('pv.quantity=0')
      if (cost === 'missing' && user.role === 'admin') where.push('pv.purchase_price=0')
      const result = rows(db.prepare(`SELECT pv.id variantId,p.id productId,p.article,p.auto_number autoNumber,p.photo_key photoKey,p.active productActive,pv.active variantActive,p.name,p.brand,p.category_id categoryId,
        c.name category, p.subcategory_id subcategoryId,sc.name subcategory,p.supplier_id supplierId,sup.name supplier,
        pv.size_id sizeId,COALESCE(sz.name,'—') size,pv.color,pv.quantity,pv.purchase_price purchasePrice,pv.retail_price retailPrice,
        pv.barcode,p.arrival_date arrivalDate,p.note,p.low_stock_threshold lowStockThreshold
        FROM product_variants pv JOIN products p ON p.id=pv.product_id
        LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN subcategories sc ON sc.id=p.subcategory_id
        LEFT JOIN sizes sz ON sz.id=pv.size_id LEFT JOIN suppliers sup ON sup.id=p.supplier_id
        WHERE ${where.join(' AND ')} ORDER BY p.name,sz.sort_order,pv.color`).all(...params))
      const query = searchText(String(search).trim())
      const filtered = query ? result.filter(item => [item.article,item.name,item.brand,item.barcode,item.category,item.size,item.color].some(value => searchText(value).includes(query))) : result
      if (user.role === 'seller') filtered.forEach(x => delete x.purchasePrice)
      return filtered
    },

    saveProduct(payload) {
      const user = auth(payload._token, ['admin'])
      const p = payload.product
      if (!p.name?.trim()) throw new Error('Укажите название')
      costing.integer(p.retailPrice || 0, 'Розничная цена'); costing.integer(p.purchasePrice || 0, 'Закупочная цена')
      return transaction(() => {
        if (p.variants) return createModel(db, p, user, audit)
        let productId = p.productId
        if (p.variantId && (!productId || variant(p.variantId).product_id !== Number(productId))) throw new Error('Вариант не принадлежит модели')
        if (p.subcategoryId && !db.prepare('SELECT id FROM subcategories WHERE id=? AND category_id=? AND active=1').get(p.subcategoryId, p.categoryId || null)) throw new Error('Подкатегория не принадлежит категории')
        if (productId && !db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(productId)) throw new Error('Модель не найдена')
        if (productId && db.prepare('SELECT id FROM product_variants WHERE product_id=? AND size_id IS ? AND color=? AND id<>?').get(productId,p.sizeId||null,p.color||'',p.variantId||0)) throw new Error('Такой размер и цвет уже есть у модели')
        if (productId) {
          const saved = db.prepare('SELECT article FROM products WHERE id=?').get(productId)
          if (p.article != null && p.article !== saved.article) throw new Error('Номер / прежний артикул нельзя менять')
          p.article = saved.article
          db.prepare(`UPDATE products SET article=?,name=?,category_id=?,subcategory_id=?,brand=?,supplier_id=?,arrival_date=?,note=?,low_stock_threshold=?,updated_at=datetime('now','localtime') WHERE id=?`)
            .run(p.article.trim(),p.name.trim(),p.categoryId||null,p.subcategoryId||null,p.brand||'',p.supplierId||null,p.arrivalDate||null,p.note||'',costing.integer(p.lowStockThreshold??2,'Порог'),productId)
        } else {
          const autoNumber = nextNumber(db)
          p.article = String(autoNumber)
          productId = Number(db.prepare(`INSERT INTO products(auto_number,article,name,category_id,subcategory_id,brand,supplier_id,arrival_date,note,low_stock_threshold) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(autoNumber,p.article,p.name.trim(),p.categoryId||null,p.subcategoryId||null,p.brand||'',p.supplierId||null,p.arrivalDate||null,p.note||'',costing.integer(p.lowStockThreshold??2,'Порог')).lastInsertRowid)
        }
        photoFields(db, productId, p.photoData)
        let variantId = p.variantId
        if (variantId) {
          const previous = variant(variantId)
          if (Number(p.purchasePrice || 0) !== previous.purchase_price) setStock(variantId, costing.stock(previous.quantity, costing.multiply(previous.quantity, p.purchasePrice || 0), Number(p.purchasePrice || 0)))
          db.prepare('UPDATE product_variants SET size_id=?,color=?,purchase_price=?,retail_price=?,barcode=? WHERE id=?')
            .run(p.sizeId||null,p.color||'',Number(p.purchasePrice)||0,Number(p.retailPrice)||0,p.barcode||'',variantId)
        } else {
          variantId = Number(db.prepare('INSERT INTO product_variants(product_id,size_id,color,purchase_price,retail_price,barcode) VALUES (?,?,?,?,?,?)')
            .run(productId,p.sizeId||null,p.color||'',Number(p.purchasePrice)||0,Number(p.retailPrice)||0,p.barcode||'').lastInsertRowid)
          const qty = costing.integer(p.initialQty || 0, 'Начальный остаток')
          if (qty) {
            setStock(variantId, costing.stock(qty, costing.multiply(qty,p.purchasePrice||0),p.purchasePrice||0))
            db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,note,created_by) VALUES (?,?,?,?,?,?)').run(p.arrivalDate||isoNow(),variantId,'adjustment',qty,'Начальный остаток',user.id)
          }
        }
        audit(user.id, p.variantId ? 'UPDATE' : 'CREATE', 'product', productId, `${p.article} / ${p.name}`)
        return { productId, variantId, article:p.article, autoNumber:db.prepare('SELECT auto_number FROM products WHERE id=?').get(productId).auto_number }
      })
    },

    quickEditProduct({ _token, scope, id, field, value }) {
      const user = auth(_token, ['admin'])
      const targetId = Number(id)
      if (!Number.isSafeInteger(targetId) || targetId <= 0) throw new Error('Некорректный товар')
      const productFields = { name: 'name', categoryId: 'category_id', subcategoryId: 'subcategory_id', brand: 'brand', supplierId: 'supplier_id', arrivalDate: 'arrival_date', note: 'note', lowStockThreshold: 'low_stock_threshold' }
      const variantFields = { sizeId: 'size_id', color: 'color', barcode: 'barcode', purchasePrice: 'purchase_price', retailPrice: 'retail_price', quantity: 'quantity' }
      if (scope === 'product') {
        const column = productFields[field]
        if (!column) throw new Error('Это поле нельзя быстро изменить')
        return transaction(() => {
          const item = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(targetId)
          if (!item) throw new Error('Товар не найден')
          let next = value
          if (field === 'article' || field === 'name') {
            next = String(value ?? '').trim()
            if (!next) throw new Error('Поле не может быть пустым')
          } else if (field === 'brand' || field === 'note') next = String(value ?? '').trim()
          else if (field === 'arrivalDate') {
            next = String(value ?? '').trim() || null
            if (next) {
              const parsedDate = new Date(next + 'T00:00:00Z')
              if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== next) throw new Error('Укажите корректную дату')
            }
          } else if (field === 'lowStockThreshold') {
            next = Number(value)
            if (!Number.isSafeInteger(next) || next < 0) throw new Error('Порог должен быть целым неотрицательным числом')
          } else if (value === '' || value == null) next = null
          else {
            next = Number(value)
            if (!Number.isSafeInteger(next) || next <= 0) throw new Error('Некорректное значение справочника')
            if (field === 'categoryId' && !db.prepare('SELECT id FROM categories WHERE id=? AND active=1').get(next)) throw new Error('Категория не найдена')
            if (field === 'subcategoryId' && !db.prepare('SELECT id FROM subcategories WHERE id=? AND category_id=? AND active=1').get(next, item.category_id)) throw new Error('Подкатегория не найдена в этой категории')
            if (field === 'supplierId' && !db.prepare('SELECT id FROM suppliers WHERE id=? AND active=1').get(next)) throw new Error('Поставщик не найден')
          }
          if (item[column] === next) return { changed: false }
          if (field === 'article' && db.prepare('SELECT id FROM products WHERE article=? AND id<>?').get(next, targetId)) throw new Error('Такой артикул уже существует')
          db.prepare(`UPDATE products SET ${column}=?,updated_at=datetime('now','localtime') WHERE id=?`).run(next, targetId)
          if (field === 'categoryId' && item.subcategory_id != null && !db.prepare('SELECT id FROM subcategories WHERE id=? AND category_id=?').get(item.subcategory_id, next)) {
            db.prepare('UPDATE products SET subcategory_id=NULL WHERE id=?').run(targetId)
          }
          audit(user.id, 'QUICK_UPDATE', 'product', targetId, `${field}: ${item[column] ?? ''} → ${next ?? ''}`)
          return { changed: true }
        })
      }
      if (scope === 'variant') {
        const column = variantFields[field]
        if (!column) throw new Error('Это поле нельзя быстро изменить')
        return transaction(() => {
          const item = db.prepare('SELECT pv.*,p.active product_active FROM product_variants pv JOIN products p ON p.id=pv.product_id WHERE pv.id=? AND pv.active=1').get(targetId)
          if (!item || !item.product_active) throw new Error('Складская позиция не найдена')
          let next = value
          if (field === 'color' || field === 'barcode') next = String(value ?? '').trim()
          else if (field === 'sizeId') {
            next = value === '' || value == null ? null : Number(value)
            if (next != null && (!Number.isSafeInteger(next) || !db.prepare('SELECT id FROM sizes WHERE id=? AND active=1').get(next))) throw new Error('Размер не найден')
          } else {
            next = Number(value)
            if (!Number.isSafeInteger(next) || next < 0) throw new Error('Введите неотрицательное целое число')
          }
          if (item[column] === next) return { changed: false }
          if ((field === 'sizeId' || field === 'color') && db.prepare('SELECT id FROM product_variants WHERE product_id=? AND size_id IS ? AND color=? AND id<>? AND active=1')
            .get(item.product_id, field === 'sizeId' ? next : item.size_id, field === 'color' ? next : item.color, targetId)) throw new Error('Такой размер и цвет уже есть у товара')
          if (field === 'purchasePrice') setStock(targetId, costing.stock(item.quantity, costing.multiply(item.quantity, next), next))
          else if (field === 'quantity') setStock(targetId, costing.adjust(item, next))
          else db.prepare(`UPDATE product_variants SET ${column}=? WHERE id=?`).run(next, targetId)
          if (field === 'quantity') db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,note,created_by) VALUES (?,?,?,?,?,?)')
            .run(isoNow(), targetId, 'adjustment', next - item.quantity, `Исправление остатка: ${item.quantity} → ${next}`, user.id)
          audit(user.id, 'QUICK_UPDATE', 'variant', targetId, `${field}: ${item[column] ?? ''} → ${next ?? ''}`)
          return { changed: true }
        })
      }
      if (scope === 'allVariants' && (field === 'purchasePrice' || field === 'retailPrice')) {
        const next = Number(value)
        if (!Number.isSafeInteger(next) || next < 0) throw new Error('Введите неотрицательную цену')
        return transaction(() => {
          const product = db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(targetId)
          if (!product) throw new Error('Товар не найден')
          const column = variantFields[field]
          let result
          if (field === 'purchasePrice') {
            const variants = db.prepare('SELECT * FROM product_variants WHERE product_id=? AND active=1 AND purchase_price<>?').all(targetId, next)
            for (const item of variants) setStock(item.id, costing.stock(item.quantity, costing.multiply(item.quantity, next), next))
            result = { changes: variants.length }
          } else result = db.prepare(`UPDATE product_variants SET ${column}=? WHERE product_id=? AND active=1 AND ${column}<>?`).run(next, targetId, next)
          if (result.changes) audit(user.id, 'QUICK_UPDATE_ALL', 'product', targetId, `${field}: ${result.changes} вариантов → ${next}`)
          return { changed: Boolean(result.changes), variants: result.changes }
        })
      }
      throw new Error('Недопустимое поле или область изменения')
    },

    importProducts({ _token, importRows, priceMode = 'retail', stockMode = 'set', fileName = '' }) {
      const user = auth(_token, ['admin'])
      if (!Array.isArray(importRows) || !importRows.length) throw new Error('В файле нет товаров для импорта')
      if (importRows.length > 50000) throw new Error('Слишком много товарных позиций для одного импорта')
      if (!['retail', 'purchase', 'both'].includes(priceMode)) throw new Error('Неизвестный режим цены')
      if (!['set', 'add', 'keep'].includes(stockMode)) throw new Error('Неизвестный режим остатков')
      return transaction(() => {
        const categoryCache = new Map()
        const sizeCache = new Map()
        const touchedProducts = new Set()
        let createdProducts = 0, createdVariants = 0, updatedVariants = 0, unitsChanged = 0
        const categoryId = name => {
          const value = String(name || 'Без категории').trim() || 'Без категории'
          if (categoryCache.has(value)) return categoryCache.get(value)
          let item = db.prepare('SELECT id FROM categories WHERE name=?').get(value)
          if (item) db.prepare('UPDATE categories SET active=1 WHERE id=?').run(item.id)
          else item = db.prepare('INSERT INTO categories(name) VALUES (?)').run(value)
          const id = Number(item.id ?? item.lastInsertRowid)
          categoryCache.set(value, id)
          return id
        }
        const sizeId = name => {
          const value = String(name || '').trim()
          if (!value) return null
          if (sizeCache.has(value)) return sizeCache.get(value)
          let item = db.prepare('SELECT id FROM sizes WHERE name=?').get(value)
          if (item) db.prepare('UPDATE sizes SET active=1 WHERE id=?').run(item.id)
          else {
            const order = Number(db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 value FROM sizes').get().value)
            item = db.prepare('INSERT INTO sizes(name,sort_order) VALUES (?,?)').run(value, order)
          }
          const id = Number(item.id ?? item.lastInsertRowid)
          sizeCache.set(value, id)
          return id
        }
        const move = db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,note,created_by) VALUES (?,?,?,?,?,?)')
        for (const source of importRows) {
          const article = String(source.article || '').trim()
          const name = String(source.name || '').trim()
          const color = String(source.color || '').trim()
          const price = costing.integer(source.priceCents ?? 0, 'Цена импорта')
          const quantity = costing.integer(source.quantity ?? 0, 'Количество импорта')
          const importedCost = source.purchaseTotalCents == null ? costing.multiply(quantity, price) : costing.integer(source.purchaseTotalCents, 'Закупочная стоимость импорта')
          if (!quantity && importedCost) throw new Error('Стоимость нулевого количества импорта должна быть нулевой')
          const importedPrice = quantity ? costing.allocate(importedCost, quantity, 1) : price
          if (!article || !name) throw new Error('В строке импорта отсутствует артикул или название')
          const catId = categoryId(source.category)
          reserveNumber(db, article)
          let product = db.prepare('SELECT id,auto_number FROM products WHERE article=?').get(article)
          if (product?.auto_number != null) throw new Error(`Артикул импорта ${article} совпал с автоматическим номером. Укажите внешний артикул, отличный от номера каталога.`)
          if (!product) {
            product = db.prepare(`INSERT INTO products(article,name,category_id,note,arrival_date) VALUES (?,?,?,?,date('now','localtime'))`)
              .run(article, name, catId, `Импорт из ${fileName || 'файла'}`)
            createdProducts++
          } else {
            db.prepare(`UPDATE products SET name=?,category_id=?,active=1,updated_at=datetime('now','localtime') WHERE id=?`)
              .run(name, catId, product.id)
          }
          const productId = Number(product.id ?? product.lastInsertRowid)
          touchedProducts.add(productId)
          const sid = sizeId(source.size)
          let importedVariant = db.prepare('SELECT * FROM product_variants WHERE product_id=? AND size_id IS ? AND color=?').get(productId, sid, color)
          if (!importedVariant) {
            const inserted = db.prepare('INSERT INTO product_variants(product_id,size_id,color,purchase_price,retail_price) VALUES (?,?,?,?,?)')
              .run(productId, sid, color, priceMode === 'retail' ? 0 : importedPrice, priceMode === 'purchase' ? 0 : price)
            importedVariant = variant(Number(inserted.lastInsertRowid))
            createdVariants++
          } else updatedVariants++
          const purchasePrice = priceMode === 'retail' ? Number(importedVariant.purchase_price) : importedPrice
          const retailPrice = priceMode === 'purchase' ? Number(importedVariant.retail_price) : price
          const currentQuantity = Number(importedVariant.quantity)
          const delta = stockMode === 'keep' ? 0 : stockMode === 'add' ? quantity : quantity - currentQuantity
          let stock
          if (stockMode === 'add') stock = costing.receive(importedVariant, quantity, priceMode === 'retail' ? costing.multiply(quantity, purchasePrice) : importedCost)
          else if (priceMode !== 'retail') stock = costing.stock(currentQuantity + delta, stockMode === 'set' ? importedCost : costing.multiply(currentQuantity, purchasePrice), purchasePrice)
          else stock = costing.adjust(importedVariant, currentQuantity + delta)
          setStock(importedVariant.id, stock)
          db.prepare('UPDATE product_variants SET retail_price=?,active=1 WHERE id=?').run(retailPrice, importedVariant.id)
          if (delta) move.run(isoNow(), importedVariant.id, 'import', delta, `Импорт: ${fileName || 'файл'}`, user.id)
          unitsChanged += delta
        }
        audit(user.id, 'IMPORT', 'products', null, `${fileName}: ${importRows.length} позиций, изменение остатка ${unitsChanged}`)
        return { products: touchedProducts.size, createdProducts, createdVariants, updatedVariants, unitsChanged }
      })
    },

    getProductPhoto({ _token, productId }) {
      auth(_token)
      const result = db.prepare('SELECT photo_data data,photo_key photoKey FROM products WHERE id=?').get(productId) || {data:'',photoKey:''}
      require('./product-photo.cjs').validatePhotoData(result.data)
      return result
    },

    deleteProduct({ _token, productId }) {
      const user = auth(_token, ['admin'])
      return transaction(() => deleteModel(db, productId, user, audit))
    },

    createReceipt({ _token, receipt }) {
      const user = auth(_token, ['admin'])
      if (!receipt.items?.length) throw new Error('Добавьте товары в поступление')
      return transaction(() => {
        const id = Number(db.prepare('INSERT INTO receipts(receipt_no,receipt_date,supplier_id,comment,created_by) VALUES (?,?,?,?,?)')
          .run(documentNo('ПСТ'),receipt.date,receipt.supplierId||null,receipt.comment||'',user.id).lastInsertRowid)
        const add = db.prepare('INSERT INTO receipt_items(receipt_id,variant_id,quantity,purchase_price,total) VALUES (?,?,?,?,?)')
        const move = db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,document_id,note,created_by) VALUES (?,?,?,?,?,?,?)')
        for (const item of receipt.items) {
          const qty=Number(item.quantity), price=Number(item.purchasePrice)
          costing.integer(qty, 'Количество поступления', true); costing.integer(price, 'Закупочная цена')
          const total = costing.multiply(qty, price)
          add.run(id,item.variantId,qty,price,total); setStock(item.variantId, costing.receive(variant(item.variantId), qty, total))
          move.run(receipt.date,item.variantId,'receipt',qty,id,'Поступление',user.id)
        }
        audit(user.id,'CREATE','receipt',id); return { id }
      })
    },

    listReceipts({ _token, from, to }) {
      auth(_token,['admin'])
      return rows(db.prepare(`SELECT r.id,r.receipt_no receiptNo,r.receipt_date date,s.name supplier,r.comment,
        SUM(ri.quantity) quantity,SUM(ri.total) total FROM receipts r LEFT JOIN suppliers s ON s.id=r.supplier_id
        JOIN receipt_items ri ON ri.receipt_id=r.id WHERE ${periodWhere('r.receipt_date')} GROUP BY r.id ORDER BY r.receipt_date DESC,r.id DESC`).all(from,to))
    },

    createSale({ _token, sale }) {
      const user = auth(_token)
      const header = saleHeader(db, sale), lines = validateLines(sale.items)
      if (lines.some(x=>x.variantId==null)) throw new Error('Выберите существующий товар')
      const requestKey = String(sale.requestKey || '').trim() || null
      if (requestKey && requestKey.length > 100) throw new Error('Некорректный ключ продажи')
      return transaction(() => {
        if (requestKey && db.prepare('SELECT id FROM sales WHERE request_key=?').get(requestKey)) throw new Error('Эта продажа уже проведена. Проверьте историю.')
        const id = Number(db.prepare('INSERT INTO sales(sale_no,sold_at,payment_method,employee_id,comment,created_by,request_key) VALUES (?,?,?,?,?,?,?)')
          .run(documentNo('ПРД'),...header,user.id,requestKey).lastInsertRowid)
        const info = db.prepare(`SELECT pv.*,p.article,p.name,p.brand,c.name category,sz.name size FROM product_variants pv
          JOIN products p ON p.id=pv.product_id LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN sizes sz ON sz.id=pv.size_id WHERE pv.id=? AND pv.active=1 AND p.active=1`)
        const add = db.prepare(`INSERT INTO sale_items(sale_id,variant_id,article_snapshot,product_snapshot,category_snapshot,brand_snapshot,size_snapshot,color_snapshot,quantity,purchase_price,sale_price,revenue,cost,gross_profit)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        const move = db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,document_id,note,created_by) VALUES (?,?,?,?,?,?,?)')
        let totalCost = 0
        for (const item of lines) {
          const v=info.get(item.variantId), qty=Number(item.quantity), price=Number(item.salePrice)
          costing.integer(qty, 'Количество продажи', true); costing.integer(price, 'Цена продажи')
          if (!v || qty>v.quantity) throw new Error(`Недостаточно товара: ${v?.name || 'позиция'}`)
          const remaining = costing.take(v, qty)
          const revenue=costing.multiply(qty,price),cost=remaining.cost
          totalCost = costing.sum(totalCost, cost)
          add.run(id,item.variantId,v.article,v.name,v.category||'',v.brand||'',v.size||'',v.color||'',qty,v.purchase_price,price,revenue,cost,revenue-cost)
          setStock(item.variantId, remaining); move.run(header[0],item.variantId,'sale',-qty,id,'Продажа',user.id)
        }
        audit(user.id,'CREATE','sale',id); return { id }
      })
    },

    updateSale({ _token, sale }) {
      const user = auth(_token, ['admin'])
      return transaction(() => editSale(db, user, sale, setStock, variant, audit))
    },

    listSales({ _token, from, to, search = '', paymentMethod = '', employeeId = '' }) {
      const user = auth(_token)
      const params=[from,to], where=[periodWhere('s.sold_at')]
      if(search){where.push('(s.sale_no LIKE ? OR EXISTS (SELECT 1 FROM sale_items hit WHERE hit.sale_id=s.id AND (hit.article_snapshot LIKE ? OR hit.product_snapshot LIKE ?)))');params.push(`%${search}%`,`%${search}%`,`%${search}%`)}
      if(paymentMethod){where.push('s.payment_method=?');params.push(paymentMethod)}
      if(employeeId){where.push('s.employee_id=?');params.push(employeeId)}
      const result=rows(db.prepare(`SELECT s.id,s.sale_no saleNo,s.sold_at soldAt,s.payment_method paymentMethod,s.employee_id employeeId,s.comment,s.edit_version editVersion,e.name employee,
        SUM(si.quantity) quantity,SUM(si.revenue) revenue,SUM(si.cost) cost,SUM(si.gross_profit) grossProfit,
        SUM(si.returned_quantity) returnedQuantity FROM sales s JOIN sale_items si ON si.sale_id=s.id LEFT JOIN employees e ON e.id=s.employee_id
        WHERE ${where.join(' AND ')} GROUP BY s.id ORDER BY s.sold_at DESC,s.id DESC`).all(...params))
      if(user.role==='seller') result.forEach(x=>{delete x.cost;delete x.grossProfit})
      return result
    },

    getSale({ _token, saleId }) {
      const user=auth(_token)
      const found=db.prepare('SELECT id,sale_no saleNo,sold_at soldAt,payment_method paymentMethod,employee_id employeeId,comment,edit_version editVersion FROM sales WHERE id=?').get(saleId)
      if (!found) throw new Error('Продажа не найдена')
      const sale={...found}
      sale.items=rows(db.prepare(`SELECT id,variant_id variantId,article_snapshot article,product_snapshot product,category_snapshot category,
        size_snapshot size,color_snapshot color,quantity,purchase_price purchasePrice,sale_price salePrice,revenue,cost,gross_profit grossProfit,returned_quantity returnedQuantity
        FROM sale_items WHERE sale_id=?`).all(saleId))
      if(user.role==='seller') sale.items.forEach(x=>{delete x.purchasePrice;delete x.cost;delete x.grossProfit})
      return sale
    },

    createReturn({ _token, data }) {
      const user=auth(_token,['admin'])
      if(!data.items?.length) throw new Error('Выберите позиции возврата')
      return transaction(()=>{
        const id=Number(db.prepare('INSERT INTO returns(return_no,sale_id,returned_at,reason,created_by) VALUES (?,?,?,?,?)')
          .run(documentNo('ВЗВ'),data.saleId,data.date,data.reason||'',user.id).lastInsertRowid)
        const find=db.prepare('SELECT * FROM sale_items WHERE id=? AND sale_id=?')
        const add=db.prepare('INSERT INTO return_items(return_id,sale_item_id,variant_id,quantity,revenue,cost) VALUES (?,?,?,?,?,?)')
        const updItem=db.prepare('UPDATE sale_items SET returned_quantity=returned_quantity+? WHERE id=?')
        const move=db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,document_id,note,created_by) VALUES (?,?,?,?,?,?,?)')
        for(const item of data.items){const si=find.get(item.saleItemId,data.saleId),qty=Number(item.quantity)
          costing.integer(qty, 'Количество возврата', true)
          if(si && si.variant_id == null) throw new Error('Товар полностью удалён из каталога. Возврат этой строки недоступен; история продажи сохранена.')
          if(!si||qty>si.quantity-si.returned_quantity) throw new Error('Некорректное количество возврата')
          const returnedCost = db.prepare('SELECT COALESCE(SUM(cost),0) total FROM return_items WHERE sale_item_id=?').get(si.id).total
          const cost = costing.allocate(si.cost, si.quantity, si.returned_quantity + qty) - returnedCost
          costing.integer(cost, 'Стоимость возврата')
          add.run(id,si.id,si.variant_id,qty,costing.multiply(qty,si.sale_price),cost);updItem.run(qty,si.id)
          setStock(si.variant_id, costing.receive(variant(si.variant_id), qty, cost))
          move.run(data.date,si.variant_id,'return',qty,id,'Возврат',user.id)
        }
        db.prepare('UPDATE sales SET edit_version=edit_version+1 WHERE id=?').run(data.saleId)
        audit(user.id,'CREATE','return',id);return{id}
      })
    },

    listReturns({ _token, from, to }) {
      auth(_token,['admin'])
      return rows(db.prepare(`SELECT r.id,r.return_no returnNo,r.returned_at returnedAt,s.sale_no saleNo,r.reason,
        SUM(ri.quantity) quantity,SUM(ri.revenue) revenue,SUM(ri.cost) cost FROM returns r JOIN sales s ON s.id=r.sale_id
        JOIN return_items ri ON ri.return_id=r.id WHERE ${periodWhere('r.returned_at')} GROUP BY r.id ORDER BY r.returned_at DESC,r.id DESC`).all(from,to))
    },

    createWriteoff({ _token, data }) {
      const user=auth(_token,['admin'])
      if(!data.items?.length) throw new Error('Добавьте товары для списания')
      return transaction(()=>{
        const id=Number(db.prepare('INSERT INTO writeoffs(writeoff_no,written_at,reason,comment,created_by) VALUES (?,?,?,?,?)')
          .run(documentNo('СПС'),data.date,data.reason,data.comment||'',user.id).lastInsertRowid)
        const find=db.prepare('SELECT * FROM product_variants WHERE id=?'),add=db.prepare('INSERT INTO writeoff_items(writeoff_id,variant_id,quantity,cost) VALUES (?,?,?,?)')
        const move=db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,document_id,note,created_by) VALUES (?,?,?,?,?,?,?)')
        for(const item of data.items){const v=find.get(item.variantId),qty=Number(item.quantity);costing.integer(qty, 'Количество списания', true);if(!v||qty>v.quantity)throw new Error('Недостаточный остаток для списания')
          const remaining=costing.take(v,qty)
          add.run(id,item.variantId,qty,remaining.cost);setStock(item.variantId,remaining);move.run(data.date,item.variantId,'writeoff',-qty,id,data.reason,user.id)}
        audit(user.id,'CREATE','writeoff',id);return{id}
      })
    },

    listWriteoffs({ _token, from, to }) { auth(_token,['admin']);return rows(db.prepare(`SELECT w.id,w.writeoff_no writeoffNo,w.written_at writtenAt,w.reason,w.comment,SUM(wi.quantity) quantity,SUM(wi.cost) cost
      FROM writeoffs w JOIN writeoff_items wi ON wi.writeoff_id=w.id WHERE ${periodWhere('w.written_at')} GROUP BY w.id ORDER BY w.written_at DESC,w.id DESC`).all(from,to)) },

    saveExpense({ _token, expense }) {
      const user=auth(_token,['admin']);if(!expense.description?.trim()||!(Number(expense.amount)>=0))throw new Error('Заполните описание и сумму')
      const values=[expense.date,expense.categoryId,expense.description.trim(),Number(expense.amount),expense.periodFrom||null,expense.periodTo||null,expense.employeeId||null,expense.paymentType||'',expense.comment||'',user.id]
      let id
      if(expense.id){db.prepare('UPDATE expenses SET expense_date=?,category_id=?,description=?,amount=?,period_from=?,period_to=?,employee_id=?,payment_type=?,comment=?,created_by=? WHERE id=?').run(...values,expense.id);id=expense.id}
      else id=Number(db.prepare('INSERT INTO expenses(expense_date,category_id,description,amount,period_from,period_to,employee_id,payment_type,comment,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...values).lastInsertRowid)
      audit(user.id,expense.id?'UPDATE':'CREATE','expense',id);return{id}
    },

    deleteExpense({ _token, id }) { const user=auth(_token,['admin']);db.prepare('DELETE FROM expenses WHERE id=?').run(id);audit(user.id,'DELETE','expense',id);return true },
    listExpenses({ _token, from, to, categoryId='' }) { auth(_token,['admin']);const params=[from,to],extra=categoryId?' AND e.category_id=?':'';if(categoryId)params.push(categoryId)
      return rows(db.prepare(`SELECT e.id,e.expense_date date,e.category_id categoryId,ec.name category,ec.group_name groupName,e.description,e.amount,
        e.period_from periodFrom,e.period_to periodTo,emp.name employee,e.payment_type paymentType,e.comment FROM expenses e
        JOIN expense_categories ec ON ec.id=e.category_id LEFT JOIN employees emp ON emp.id=e.employee_id WHERE ${periodWhere('e.expense_date')}${extra} ORDER BY e.expense_date DESC,e.id DESC`).all(...params)) },

    pnl({ _token, from, to }) {
      auth(_token,['admin'])
      const dash=api.dashboard({_token,from,to}).metrics
      const expenseRows=rows(db.prepare(`SELECT ec.name,COALESCE(SUM(e.amount),0) amount FROM expenses e JOIN expense_categories ec ON ec.id=e.category_id WHERE ${periodWhere('e.expense_date')} GROUP BY ec.id ORDER BY amount DESC`).all(from,to))
      return { ...dash, expenseRows }
    },

    analytics({ _token, from, to, dimension='category' }) {
      auth(_token,['admin'])
      const columns={category:'category_snapshot',product:'product_snapshot',size:'size_snapshot',brand:'brand_snapshot'}
      const col=columns[dimension]||columns.category
      return rows(db.prepare(`SELECT COALESCE(NULLIF(label,''),'Не указано') label,SUM(quantity) quantity,SUM(revenue) revenue,
        SUM(CASE WHEN unknown_cost=1 THEN ABS(quantity) ELSE 0 END) unknownCostUnits,
        CASE WHEN SUM(CASE WHEN unknown_cost=1 THEN ABS(quantity) ELSE 0 END)>0 THEN NULL ELSE SUM(cost) END cost,
        CASE WHEN SUM(CASE WHEN unknown_cost=1 THEN ABS(quantity) ELSE 0 END)>0 THEN NULL ELSE SUM(revenue-cost) END profit,
        CASE WHEN SUM(CASE WHEN unknown_cost=1 THEN ABS(quantity) ELSE 0 END)>0 THEN NULL WHEN SUM(revenue)=0 THEN 0 ELSE ROUND(SUM(revenue-cost)*100.0/SUM(revenue),1) END margin FROM (
        SELECT si.${col} label,si.quantity,si.revenue,si.cost,CASE WHEN si.purchase_price=0 THEN 1 ELSE 0 END unknown_cost FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE ${periodWhere('s.sold_at')}
        UNION ALL SELECT si.${col},-ri.quantity,-ri.revenue,-ri.cost,CASE WHEN si.purchase_price=0 THEN 1 ELSE 0 END FROM returns r JOIN return_items ri ON ri.return_id=r.id JOIN sale_items si ON si.id=ri.sale_item_id WHERE ${periodWhere('r.returned_at')}
      ) GROUP BY label ORDER BY revenue DESC`).all(from,to,from,to))
    },

    inventorySummary({ _token }) {
      const user=auth(_token)
      return {
        byCategory: rows(db.prepare(`SELECT COALESCE(c.name,'Без категории') label,SUM(pv.quantity) quantity,SUM(pv.quantity*pv.retail_price) retailValue
          FROM product_variants pv JOIN products p ON p.id=pv.product_id LEFT JOIN categories c ON c.id=p.category_id WHERE p.active=1 AND pv.active=1 GROUP BY c.id ORDER BY quantity DESC`)),
        bySize: rows(db.prepare(`SELECT COALESCE(sz.name,'Без размера') label,SUM(pv.quantity) quantity FROM product_variants pv LEFT JOIN sizes sz ON sz.id=pv.size_id WHERE pv.active=1 GROUP BY sz.id ORDER BY quantity DESC`)),
        byColor: rows(db.prepare(`SELECT COALESCE(NULLIF(color,''),'Не указан') label,SUM(quantity) quantity FROM product_variants WHERE active=1 GROUP BY color ORDER BY quantity DESC`)),
        missingCost: user.role==='admin' ? db.prepare(`SELECT COUNT(*) variants,COALESCE(SUM(pv.quantity),0) units FROM product_variants pv JOIN products p ON p.id=pv.product_id WHERE p.active=1 AND pv.active=1 AND pv.quantity>0 AND pv.purchase_price=0`).get() : null
      }
    },

    saveCatalog({ _token, type, item }) {
      const user=auth(_token,['admin'])
      const config={
        categories:{table:'categories',fields:['name']},sizes:{table:'sizes',fields:['name','sort_order']},suppliers:{table:'suppliers',fields:['name','phone','note']},
        employees:{table:'employees',fields:['name','phone']},expenseCategories:{table:'expense_categories',fields:['name','group_name']},subcategories:{table:'subcategories',fields:['category_id','name']}
      }[type]
      if(!config)throw new Error('Неизвестный справочник')
      const vals=config.fields.map(f=>item[f]??(f==='sort_order'?0:''));let id=item.id
      if(id){db.prepare(`UPDATE ${config.table} SET ${config.fields.map(f=>`${f}=?`).join(',')} WHERE id=?`).run(...vals,id)}
      else{id=Number(db.prepare(`INSERT INTO ${config.table}(${config.fields.join(',')}) VALUES (${config.fields.map(()=>'?').join(',')})`).run(...vals).lastInsertRowid)}
      audit(user.id,item.id?'UPDATE':'CREATE',config.table,id);return{id}
    },
    archiveCatalog({ _token, type, id }) { const user=auth(_token,['admin']);const tables={categories:'categories',sizes:'sizes',suppliers:'suppliers',employees:'employees',expenseCategories:'expense_categories',subcategories:'subcategories'};if(!tables[type])throw new Error('Неизвестный справочник');db.prepare(`UPDATE ${tables[type]} SET active=0 WHERE id=?`).run(id);audit(user.id,'ARCHIVE',tables[type],id);return true },

    listUsers({ _token }) { auth(_token,['admin']);return rows(db.prepare('SELECT id,login,display_name displayName,role,active FROM users ORDER BY display_name')) },
    saveUser({ _token, data }) { const user=auth(_token,['admin']);if(!data.login?.trim()||!data.displayName?.trim())throw new Error('Заполните логин и имя')
      let id=data.id;if(id){if(data.password)db.prepare('UPDATE users SET login=?,display_name=?,role=?,password_hash=? WHERE id=?').run(data.login,data.displayName,data.role,hashPassword(data.password),id);else db.prepare('UPDATE users SET login=?,display_name=?,role=? WHERE id=?').run(data.login,data.displayName,data.role,id)}
      else{if(!data.password)throw new Error('Укажите пароль');id=Number(db.prepare('INSERT INTO users(login,password_hash,display_name,role) VALUES (?,?,?,?)').run(data.login,hashPassword(data.password),data.displayName,data.role).lastInsertRowid)}audit(user.id,data.id?'UPDATE':'CREATE','user',id);return{id} },

    operationHistory({ _token, from, to }) { auth(_token,['admin']);return rows(db.prepare(`SELECT sm.id,sm.moved_at movedAt,sm.movement_type type,
      COALESCE(p.article,json_extract(NULLIF(sm.catalog_snapshot,''),'$.article')) article,
      COALESCE(p.name,json_extract(NULLIF(sm.catalog_snapshot,''),'$.name')) name,
      COALESCE(sz.name,json_extract(NULLIF(sm.catalog_snapshot,''),'$.size')) size,
      COALESCE(pv.color,json_extract(NULLIF(sm.catalog_snapshot,''),'$.color')) color,
      sm.quantity_delta quantity,sm.note,CASE WHEN sm.variant_id IS NULL THEN 1 ELSE 0 END deleted
      FROM stock_movements sm LEFT JOIN product_variants pv ON pv.id=sm.variant_id LEFT JOIN products p ON p.id=pv.product_id LEFT JOIN sizes sz ON sz.id=pv.size_id
      WHERE ${periodWhere('sm.moved_at')} ORDER BY sm.moved_at DESC,sm.id DESC LIMIT 1000`).all(from,to)) }

  }
  return api
}

module.exports = { createRepository }
