const crypto = require('node:crypto')
const { hashPassword, verifyPassword } = require('./database.cjs')

const sessions = new Map()
const isoNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const documentNo = prefix => `${prefix}-${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}-${Math.floor(Math.random() * 900 + 100)}`
const rows = (statement, ...args) => (Array.isArray(statement) ? statement : statement.all(...args)).map(x => ({ ...x }))

function createRepository(db) {
  function auth(token, roles = ['admin', 'seller']) {
    const user = sessions.get(token)
    if (!user) throw new Error('Сессия истекла. Войдите снова.')
    if (!roles.includes(user.role)) throw new Error('Недостаточно прав для этой операции')
    return user
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result } catch (e) { db.exec('ROLLBACK'); throw e }
  }

  function audit(userId, action, entityType, entityId, details = '') {
    db.prepare('INSERT INTO audit_log(user_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?)')
      .run(userId, action, entityType, entityId ?? null, details)
  }

  function periodWhere(column) { return `${column} >= ? AND ${column} < datetime(?, '+1 day')` }

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
      const revenue = Number(sales.revenue) - Number(returns.revenue)
      const cost = Number(sales.cost) - Number(returns.cost)
      const expense = Number(expenses.amount)
      const metrics = {
        salesCount: Number(sales.sales_count), units: Number(sales.units) - Number(returns.units), revenue,
        cost, grossProfit: revenue - cost, expenses: expense, netProfit: revenue - cost - expense,
        margin: revenue ? ((revenue - cost) / revenue) * 100 : 0
      }
      const trend = rows(db.prepare(`SELECT day, SUM(revenue) revenue, SUM(cost) cost FROM (
        SELECT date(s.sold_at) day, si.revenue revenue, si.cost cost FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE ${periodWhere('s.sold_at')}
        UNION ALL SELECT date(r.returned_at), -ri.revenue, -ri.cost FROM returns r JOIN return_items ri ON ri.return_id=r.id WHERE ${periodWhere('r.returned_at')}
      ) GROUP BY day ORDER BY day`), from, to, from, to)
      const lowStock = rows(db.prepare(`SELECT pv.id variantId,p.article,p.name,COALESCE(sz.name,'—') size,pv.color,pv.quantity,p.low_stock_threshold threshold
        FROM product_variants pv JOIN products p ON p.id=pv.product_id LEFT JOIN sizes sz ON sz.id=pv.size_id
        WHERE p.active=1 AND pv.active=1 AND pv.quantity<=p.low_stock_threshold ORDER BY pv.quantity,p.name LIMIT 8`))
      const stock = db.prepare('SELECT COALESCE(SUM(quantity),0) total, COUNT(CASE WHEN quantity>0 THEN 1 END) positions FROM product_variants WHERE active=1').get()
      if (user.role === 'seller') {
        metrics.cost = null; metrics.grossProfit = null; metrics.expenses = null; metrics.netProfit = null; metrics.margin = null
        trend.forEach(x => { delete x.cost })
      }
      return { metrics, trend, lowStock, stock: { total: Number(stock.total), positions: Number(stock.positions) } }
    },

    listProducts({ _token, search = '', categoryId = '', sizeId = '', brand = '', stock = '' }) {
      const user = auth(_token)
      const params = []
      const where = ['p.active=1', 'pv.active=1']
      if (search) { where.push('(p.article LIKE ? OR p.name LIKE ? OR p.brand LIKE ? OR pv.barcode LIKE ?)'); for (let i=0;i<4;i++) params.push(`%${search}%`) }
      if (categoryId) { where.push('p.category_id=?'); params.push(categoryId) }
      if (sizeId) { where.push('pv.size_id=?'); params.push(sizeId) }
      if (brand) { where.push('p.brand=?'); params.push(brand) }
      if (stock === 'available') where.push('pv.quantity>0')
      if (stock === 'low') where.push('pv.quantity>0 AND pv.quantity<=p.low_stock_threshold')
      if (stock === 'none') where.push('pv.quantity=0')
      const result = rows(db.prepare(`SELECT pv.id variantId,p.id productId,p.article,p.name,p.brand,p.category_id categoryId,
        c.name category, p.subcategory_id subcategoryId,sc.name subcategory,p.supplier_id supplierId,sup.name supplier,
        pv.size_id sizeId,COALESCE(sz.name,'—') size,pv.color,pv.quantity,pv.purchase_price purchasePrice,pv.retail_price retailPrice,
        pv.barcode,p.arrival_date arrivalDate,p.note,p.low_stock_threshold lowStockThreshold
        FROM product_variants pv JOIN products p ON p.id=pv.product_id
        LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN subcategories sc ON sc.id=p.subcategory_id
        LEFT JOIN sizes sz ON sz.id=pv.size_id LEFT JOIN suppliers sup ON sup.id=p.supplier_id
        WHERE ${where.join(' AND ')} ORDER BY p.name,sz.sort_order,pv.color`).all(...params))
      if (user.role === 'seller') result.forEach(x => delete x.purchasePrice)
      return result
    },

    saveProduct(payload) {
      const user = auth(payload._token, ['admin'])
      const p = payload.product
      if (!p.article?.trim() || !p.name?.trim()) throw new Error('Укажите артикул и название')
      if (Number(p.retailPrice) < 0 || Number(p.purchasePrice) < 0) throw new Error('Цена не может быть отрицательной')
      return transaction(() => {
        let productId = p.productId
        if (productId) {
          db.prepare(`UPDATE products SET article=?,name=?,category_id=?,subcategory_id=?,brand=?,supplier_id=?,arrival_date=?,note=?,low_stock_threshold=?,updated_at=datetime('now','localtime') WHERE id=?`)
            .run(p.article.trim(),p.name.trim(),p.categoryId||null,p.subcategoryId||null,p.brand||'',p.supplierId||null,p.arrivalDate||null,p.note||'',Number(p.lowStockThreshold)||2,productId)
        } else {
          const existing = db.prepare('SELECT id FROM products WHERE article=?').get(p.article.trim())
          if (existing) {
            productId = Number(existing.id)
            db.prepare(`UPDATE products SET name=?,category_id=?,subcategory_id=?,brand=?,supplier_id=?,arrival_date=?,note=?,low_stock_threshold=?,active=1,updated_at=datetime('now','localtime') WHERE id=?`)
              .run(p.name.trim(),p.categoryId||null,p.subcategoryId||null,p.brand||'',p.supplierId||null,p.arrivalDate||null,p.note||'',Number(p.lowStockThreshold)||2,productId)
          } else {
            productId = Number(db.prepare(`INSERT INTO products(article,name,category_id,subcategory_id,brand,supplier_id,arrival_date,note,low_stock_threshold) VALUES (?,?,?,?,?,?,?,?,?)`)
              .run(p.article.trim(),p.name.trim(),p.categoryId||null,p.subcategoryId||null,p.brand||'',p.supplierId||null,p.arrivalDate||null,p.note||'',Number(p.lowStockThreshold)||2).lastInsertRowid)
          }
        }
        let variantId = p.variantId
        if (variantId) {
          db.prepare('UPDATE product_variants SET size_id=?,color=?,purchase_price=?,retail_price=?,barcode=? WHERE id=?')
            .run(p.sizeId||null,p.color||'',Number(p.purchasePrice)||0,Number(p.retailPrice)||0,p.barcode||'',variantId)
        } else {
          variantId = Number(db.prepare('INSERT INTO product_variants(product_id,size_id,color,purchase_price,retail_price,barcode) VALUES (?,?,?,?,?,?)')
            .run(productId,p.sizeId||null,p.color||'',Number(p.purchasePrice)||0,Number(p.retailPrice)||0,p.barcode||'').lastInsertRowid)
        }
        audit(user.id, p.variantId ? 'UPDATE' : 'CREATE', 'product', productId, `${p.article} / ${p.name}`)
        return { productId, variantId }
      })
    },

    archiveProduct({ _token, variantId }) {
      const user = auth(_token, ['admin'])
      const item = db.prepare('SELECT quantity,product_id FROM product_variants WHERE id=?').get(variantId)
      if (!item) throw new Error('Товар не найден')
      if (item.quantity > 0) throw new Error('Нельзя архивировать позицию с ненулевым остатком')
      db.prepare('UPDATE product_variants SET active=0 WHERE id=?').run(variantId)
      audit(user.id, 'ARCHIVE', 'variant', variantId)
      return true
    },

    createReceipt({ _token, receipt }) {
      const user = auth(_token, ['admin'])
      if (!receipt.items?.length) throw new Error('Добавьте товары в поступление')
      return transaction(() => {
        const id = Number(db.prepare('INSERT INTO receipts(receipt_no,receipt_date,supplier_id,comment,created_by) VALUES (?,?,?,?,?)')
          .run(documentNo('ПСТ'),receipt.date,receipt.supplierId||null,receipt.comment||'',user.id).lastInsertRowid)
        const add = db.prepare('INSERT INTO receipt_items(receipt_id,variant_id,quantity,purchase_price,total) VALUES (?,?,?,?,?)')
        const update = db.prepare('UPDATE product_variants SET quantity=quantity+?,purchase_price=? WHERE id=?')
        const move = db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,document_id,note,created_by) VALUES (?,?,?,?,?,?,?)')
        for (const item of receipt.items) {
          const qty=Number(item.quantity), price=Number(item.purchasePrice)
          if (!(qty>0) || price<0) throw new Error('Проверьте количество и закупочную цену')
          add.run(id,item.variantId,qty,price,qty*price); update.run(qty,price,item.variantId)
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
      if (!sale.items?.length) throw new Error('Корзина пуста')
      return transaction(() => {
        const id = Number(db.prepare('INSERT INTO sales(sale_no,sold_at,payment_method,employee_id,created_by,comment) VALUES (?,?,?,?,?,?)')
          .run(documentNo('ПРД'),sale.date,sale.paymentMethod||'Наличные',sale.employeeId||null,user.id,sale.comment||'').lastInsertRowid)
        const info = db.prepare(`SELECT pv.*,p.article,p.name,p.brand,c.name category,sz.name size FROM product_variants pv
          JOIN products p ON p.id=pv.product_id LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN sizes sz ON sz.id=pv.size_id WHERE pv.id=?`)
        const add = db.prepare(`INSERT INTO sale_items(sale_id,variant_id,article_snapshot,product_snapshot,category_snapshot,brand_snapshot,size_snapshot,color_snapshot,quantity,purchase_price,sale_price,revenue,cost,gross_profit)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        const take = db.prepare('UPDATE product_variants SET quantity=quantity-? WHERE id=?')
        const move = db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,document_id,note,created_by) VALUES (?,?,?,?,?,?,?)')
        for (const item of sale.items) {
          const v=info.get(item.variantId), qty=Number(item.quantity), price=Number(item.salePrice)
          if (!v || qty<=0 || qty>v.quantity) throw new Error(`Недостаточно товара: ${v?.name || 'позиция'}`)
          const revenue=qty*price,cost=qty*Number(v.purchase_price)
          add.run(id,item.variantId,v.article,v.name,v.category||'',v.brand||'',v.size||'',v.color||'',qty,v.purchase_price,price,revenue,cost,revenue-cost)
          take.run(qty,item.variantId); move.run(sale.date,item.variantId,'sale',-qty,id,'Продажа',user.id)
        }
        audit(user.id,'CREATE','sale',id); return { id }
      })
    },

    listSales({ _token, from, to, search = '', paymentMethod = '', employeeId = '' }) {
      const user = auth(_token)
      const params=[from,to], where=[periodWhere('s.sold_at')]
      if(search){where.push('(s.sale_no LIKE ? OR si.article_snapshot LIKE ? OR si.product_snapshot LIKE ?)');params.push(`%${search}%`,`%${search}%`,`%${search}%`)}
      if(paymentMethod){where.push('s.payment_method=?');params.push(paymentMethod)}
      if(employeeId){where.push('s.employee_id=?');params.push(employeeId)}
      const result=rows(db.prepare(`SELECT s.id,s.sale_no saleNo,s.sold_at soldAt,s.payment_method paymentMethod,e.name employee,
        SUM(si.quantity) quantity,SUM(si.revenue) revenue,SUM(si.cost) cost,SUM(si.gross_profit) grossProfit,
        SUM(si.returned_quantity) returnedQuantity FROM sales s JOIN sale_items si ON si.sale_id=s.id LEFT JOIN employees e ON e.id=s.employee_id
        WHERE ${where.join(' AND ')} GROUP BY s.id ORDER BY s.sold_at DESC,s.id DESC`).all(...params))
      if(user.role==='seller') result.forEach(x=>{delete x.cost;delete x.grossProfit})
      return result
    },

    getSale({ _token, saleId }) {
      const user=auth(_token)
      const sale={...db.prepare('SELECT id,sale_no saleNo,sold_at soldAt,payment_method paymentMethod,comment FROM sales WHERE id=?').get(saleId)}
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
        const updStock=db.prepare('UPDATE product_variants SET quantity=quantity+? WHERE id=?')
        const move=db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,document_id,note,created_by) VALUES (?,?,?,?,?,?,?)')
        for(const item of data.items){const si=find.get(item.saleItemId,data.saleId),qty=Number(item.quantity)
          if(!si||qty<=0||qty>si.quantity-si.returned_quantity) throw new Error('Некорректное количество возврата')
          add.run(id,si.id,si.variant_id,qty,qty*si.sale_price,qty*si.purchase_price);updItem.run(qty,si.id);updStock.run(qty,si.variant_id)
          move.run(data.date,si.variant_id,'return',qty,id,'Возврат',user.id)
        }
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
        const find=db.prepare('SELECT quantity,purchase_price FROM product_variants WHERE id=?'),add=db.prepare('INSERT INTO writeoff_items(writeoff_id,variant_id,quantity,cost) VALUES (?,?,?,?)')
        const take=db.prepare('UPDATE product_variants SET quantity=quantity-? WHERE id=?'),move=db.prepare('INSERT INTO stock_movements(moved_at,variant_id,movement_type,quantity_delta,document_id,note,created_by) VALUES (?,?,?,?,?,?,?)')
        for(const item of data.items){const v=find.get(item.variantId),qty=Number(item.quantity);if(!v||qty<=0||qty>v.quantity)throw new Error('Недостаточный остаток для списания')
          add.run(id,item.variantId,qty,qty*v.purchase_price);take.run(qty,item.variantId);move.run(data.date,item.variantId,'writeoff',-qty,id,data.reason,user.id)}
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
      return rows(db.prepare(`SELECT COALESCE(NULLIF(label,''),'Не указано') label,SUM(quantity) quantity,SUM(revenue) revenue,SUM(cost) cost,SUM(revenue-cost) profit,
        CASE WHEN SUM(revenue)=0 THEN 0 ELSE ROUND(SUM(revenue-cost)*100.0/SUM(revenue),1) END margin FROM (
        SELECT si.${col} label,si.quantity,si.revenue,si.cost FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE ${periodWhere('s.sold_at')}
        UNION ALL SELECT si.${col},-ri.quantity,-ri.revenue,-ri.cost FROM returns r JOIN return_items ri ON ri.return_id=r.id JOIN sale_items si ON si.id=ri.sale_item_id WHERE ${periodWhere('r.returned_at')}
      ) GROUP BY label ORDER BY revenue DESC`).all(from,to,from,to))
    },

    inventorySummary({ _token }) {
      auth(_token)
      return {
        byCategory: rows(db.prepare(`SELECT COALESCE(c.name,'Без категории') label,SUM(pv.quantity) quantity,SUM(pv.quantity*pv.retail_price) retailValue
          FROM product_variants pv JOIN products p ON p.id=pv.product_id LEFT JOIN categories c ON c.id=p.category_id WHERE p.active=1 AND pv.active=1 GROUP BY c.id ORDER BY quantity DESC`)),
        bySize: rows(db.prepare(`SELECT COALESCE(sz.name,'Без размера') label,SUM(pv.quantity) quantity FROM product_variants pv LEFT JOIN sizes sz ON sz.id=pv.size_id WHERE pv.active=1 GROUP BY sz.id ORDER BY quantity DESC`)),
        byColor: rows(db.prepare(`SELECT COALESCE(NULLIF(color,''),'Не указан') label,SUM(quantity) quantity FROM product_variants WHERE active=1 GROUP BY color ORDER BY quantity DESC`))
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

    operationHistory({ _token, from, to }) { auth(_token,['admin']);return rows(db.prepare(`SELECT sm.id,sm.moved_at movedAt,sm.movement_type type,p.article,p.name,sz.name size,pv.color,sm.quantity_delta quantity,sm.note
      FROM stock_movements sm JOIN product_variants pv ON pv.id=sm.variant_id JOIN products p ON p.id=pv.product_id LEFT JOIN sizes sz ON sz.id=pv.size_id
      WHERE ${periodWhere('sm.moved_at')} ORDER BY sm.moved_at DESC,sm.id DESC LIMIT 1000`).all(from,to)) }
  }
  return api
}

module.exports = { createRepository }
