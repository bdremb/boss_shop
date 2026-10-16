const { DatabaseSync } = require('./sqlite.cjs')
const crypto = require('node:crypto')

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, saved) {
  const [salt, hash] = String(saved).split(':')
  if (!salt || !hash) return false
  const candidate = crypto.scryptSync(password, salt, 64)
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'))
}

function openDatabase(filePath, options = {}) {
  const db = new DatabaseSync(filePath, options)
  db.beginMigration()
  try {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS subcategories (
      id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id),
      name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(category_id, name)
    );
    CREATE TABLE IF NOT EXISTS sizes (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '', note TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','seller')), active INTEGER NOT NULL DEFAULT 1,
      employee_id INTEGER REFERENCES employees(id), created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, article TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      category_id INTEGER REFERENCES categories(id), subcategory_id INTEGER REFERENCES subcategories(id),
      brand TEXT DEFAULT '', supplier_id INTEGER REFERENCES suppliers(id), arrival_date TEXT,
      note TEXT DEFAULT '', low_stock_threshold INTEGER NOT NULL DEFAULT 2, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), size_id INTEGER REFERENCES sizes(id),
      color TEXT DEFAULT '', quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
      purchase_price INTEGER NOT NULL DEFAULT 0, retail_price INTEGER NOT NULL DEFAULT 0,
      barcode TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(product_id, size_id, color)
    );
    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY, receipt_no TEXT NOT NULL UNIQUE, receipt_date TEXT NOT NULL,
      supplier_id INTEGER REFERENCES suppliers(id), comment TEXT DEFAULT '', created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS receipt_items (
      id INTEGER PRIMARY KEY, receipt_id INTEGER NOT NULL REFERENCES receipts(id), variant_id INTEGER NOT NULL REFERENCES product_variants(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0), purchase_price INTEGER NOT NULL, total INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY, sale_no TEXT NOT NULL UNIQUE, sold_at TEXT NOT NULL,
      payment_method TEXT NOT NULL, employee_id INTEGER REFERENCES employees(id), created_by INTEGER REFERENCES users(id),
      comment TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), variant_id INTEGER NOT NULL REFERENCES product_variants(id),
      article_snapshot TEXT NOT NULL, product_snapshot TEXT NOT NULL, category_snapshot TEXT DEFAULT '', brand_snapshot TEXT DEFAULT '', size_snapshot TEXT DEFAULT '', color_snapshot TEXT DEFAULT '',
      quantity INTEGER NOT NULL CHECK(quantity > 0), purchase_price INTEGER NOT NULL, sale_price INTEGER NOT NULL,
      revenue INTEGER NOT NULL, cost INTEGER NOT NULL, gross_profit INTEGER NOT NULL, returned_quantity INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS returns (
      id INTEGER PRIMARY KEY, return_no TEXT NOT NULL UNIQUE, sale_id INTEGER NOT NULL REFERENCES sales(id), returned_at TEXT NOT NULL,
      reason TEXT DEFAULT '', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS return_items (
      id INTEGER PRIMARY KEY, return_id INTEGER NOT NULL REFERENCES returns(id), sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
      variant_id INTEGER NOT NULL REFERENCES product_variants(id), quantity INTEGER NOT NULL CHECK(quantity > 0), revenue INTEGER NOT NULL, cost INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS writeoffs (
      id INTEGER PRIMARY KEY, writeoff_no TEXT NOT NULL UNIQUE, written_at TEXT NOT NULL, reason TEXT NOT NULL,
      comment TEXT DEFAULT '', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS writeoff_items (
      id INTEGER PRIMARY KEY, writeoff_id INTEGER NOT NULL REFERENCES writeoffs(id), variant_id INTEGER NOT NULL REFERENCES product_variants(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0), cost INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expense_categories (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, group_name TEXT NOT NULL DEFAULT 'Прочие', active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY, expense_date TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES expense_categories(id),
      description TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0), period_from TEXT, period_to TEXT,
      employee_id INTEGER REFERENCES employees(id), payment_type TEXT DEFAULT '', comment TEXT DEFAULT '', created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY, moved_at TEXT NOT NULL, variant_id INTEGER NOT NULL REFERENCES product_variants(id),
      movement_type TEXT NOT NULL, quantity_delta INTEGER NOT NULL, document_id INTEGER, note TEXT DEFAULT '', created_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY, event_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER, details TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_products_article ON products(article);
    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sold_at);
    CREATE INDEX IF NOT EXISTS idx_returns_date ON returns(returned_at);
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
    CREATE INDEX IF NOT EXISTS idx_stock_variant ON stock_movements(variant_id);
  `)

  if (!db.prepare('PRAGMA table_info(product_variants)').all().some(column => column.name === 'stock_cost')) {
    // Initialise only the current stock, never rewrite historical documents.
    const { multiply } = require('./stock-cost.cjs')
    const variants = db.prepare('SELECT id,quantity,purchase_price FROM product_variants').all()
    db.exec('ALTER TABLE product_variants ADD COLUMN stock_cost INTEGER NOT NULL DEFAULT 0 CHECK(stock_cost >= 0)')
    const update = db.prepare('UPDATE product_variants SET stock_cost=? WHERE id=?')
    for (const variant of variants) update.run(multiply(variant.quantity, variant.purchase_price), variant.id)
  }
  if (!db.prepare('PRAGMA table_info(sales)').all().some(column => column.name === 'edit_version')) db.exec('ALTER TABLE sales ADD COLUMN edit_version INTEGER NOT NULL DEFAULT 0')
  if (!db.prepare('PRAGMA table_info(sales)').all().some(column => column.name === 'request_key')) db.exec('ALTER TABLE sales ADD COLUMN request_key TEXT')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_request_key ON sales(request_key)')
  require('./catalog.cjs').migrateCatalog(db)
  require('./catalog.cjs').ensureHistorySnapshots(db)
  seed(db)
  db.exec('COMMIT')
  return db
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    db.close()
    throw error
  }
}

function seed(db) {
  const categories = ['Футболки','Поло','Рубашки','Брюки','Джинсы','Пиджаки','Куртки','Пальто','Свитера','Толстовки','Обувь','Аксессуары']
  const addCategory = db.prepare('INSERT OR IGNORE INTO categories(name) VALUES (?)')
  categories.forEach(x => addCategory.run(x))
  const sizes = ['S','M','L','XL','XXL','46','48','50','52','54']
  const addSize = db.prepare('INSERT OR IGNORE INTO sizes(name, sort_order) VALUES (?, ?)')
  sizes.forEach((x, i) => addSize.run(x, i + 1))
  const expenseCategories = [
    ['Аренда магазина','Постоянные'],['Зарплата','Постоянные'],['Коммунальные платежи','Постоянные'],
    ['Интернет','Постоянные'],['Бухгалтерия','Постоянные'],['Охрана','Постоянные'],['Обслуживание кассы','Постоянные'],
    ['Реклама','Переменные'],['Упаковка','Переменные'],['Доставка','Переменные'],['Ремонт','Переменные'],
    ['Банковские комиссии','Переменные'],['Хозяйственные расходы','Переменные'],['Транспорт','Переменные'],['Прочие расходы','Прочие']
  ]
  const addExpense = db.prepare('INSERT OR IGNORE INTO expense_categories(name, group_name) VALUES (?, ?)')
  expenseCategories.forEach(x => addExpense.run(...x))
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    db.prepare(`INSERT INTO users(login,password_hash,display_name,role) VALUES (?,?,?,?)`).run('admin', hashPassword('admin123'), 'Администратор', 'admin')
    db.prepare(`INSERT INTO users(login,password_hash,display_name,role) VALUES (?,?,?,?)`).run('seller', hashPassword('seller123'), 'Продавец', 'seller')
  }
}

module.exports = { openDatabase, hashPassword, verifyPassword }
