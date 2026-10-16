// Execute the real main/preload/renderer with an isolated Electron profile.
// Only native file pickers and confirmation are substituted with test choices.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { app, dialog } = require('electron')
const root = path.resolve(process.env.BOSS_SHOP_TEST_ROOT || '')
assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('boss-electron-'), 'Temporary test root required')
const id = process.env.BOSS_SHOP_TEST_INSTANCE
const profile = path.join(root, 'profile')
fs.mkdirSync(profile, { recursive: true })
app.setName('Boss Shop isolated runtime test')
app.setPath('appData', root)
app.setPath('userData', profile)
app.setPath('logs', root)
app.setPath('crashDumps', root)
const log = (event, data = {}) => fs.appendFileSync(path.join(root, `${id}.jsonl`), JSON.stringify({ event, pid: process.pid, ...data }) + '\n')
let locked = false
const lock = app.requestSingleInstanceLock.bind(app)
app.requestSingleInstanceLock = (...args) => { locked = lock(...args); log('lock', { locked }); return locked }
const appRoot = process.env.BOSS_SHOP_TEST_APP_ROOT || path.join(__dirname, '..')
const databaseModule = require(path.join(appRoot, 'electron', 'database.cjs'))
const open = databaseModule.openDatabase
databaseModule.openDatabase = (...args) => { assert.equal(locked, true, 'Database opened before single-instance lock'); assert.equal(path.dirname(args[0]), profile); log('database-open'); return open(...args) }
dialog.showErrorBox = (title, message) => { log('fatal', { title, message }); app.exit(1) }
dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(root, 'manual.bossshop') })
dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [path.join(root, options.title === 'Выберите файл с товарами' ? 'mixed.csv' : options.title==='Выберите фото товара' ? 'photo.jpg' : 'manual.bossshop')] })
const waitFor = async predicate => {
  const until = Date.now() + 20000
  while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('Timed out waiting for renderer state')
}
let window
app.on('second-instance', () => setTimeout(() => log('second-instance-observed', { minimized: window?.isMinimized(), visible: window?.isVisible(), focused: window?.isFocused() }), 500))
app.on('browser-window-created', (_event, win) => {
  if (win.webContents.getLastWebPreferences().sandbox) return // isolated WebP decoder
  window = win
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)log('renderer-console',{message})})
  win.webContents.on('render-process-gone', (_event, details) => log('renderer-gone', details))
  win.webContents.once('did-finish-load', async () => {
    try {
      const js = code => win.webContents.executeJavaScript(code, true).catch(error=>{throw new Error(`${error.message}\nScript: ${code}`)})
      await waitFor(() => js('Boolean(document.querySelector(".login-panel button[type=submit]"))'))
      await js('document.querySelector(".login-panel button[type=submit]").click()')
      await waitFor(() => js('Boolean(document.querySelector(".sidebar"))'))
      await js('Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent.includes("Настройки")).click()')
      await waitFor(() => js('document.body.innerText.includes("Автокопий:")'))
      const status = await js('window.bossShop.invoke("backupStatus",{_token:sessionStorage.getItem("boss-shop-token")})')
      assert.equal(status.ok, true); assert.equal(status.data.enabled, true)
      assert.ok(status.data.count > 0); assert.equal(status.data.limit, 14)
      const invoke = (action, payload) => js(`window.bossShop.invoke(${JSON.stringify(action)},{...${JSON.stringify(payload)},_token:sessionStorage.getItem("boss-shop-token")})`)
      const stagePath = path.join(root, 'stage.json')
      if (fs.existsSync(stagePath)) {
        const products = await invoke('listProducts', { search: 'Before restore' })
        assert.equal(products.ok, true); assert.equal(products.data.length, 1)
        assert.equal(products.data[0].name, 'Before restore')
        assert.equal(products.data[0].quantity, 3)
        assert.equal(products.data[0].purchasePrice, 167)
        const expected=JSON.parse(fs.readFileSync(path.join(root,'photo-expected.json'),'utf8'))
        assert.deepEqual((await invoke('getProductPhoto',{productId:expected.productId})).data,expected.photo)
        await js('Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent.includes("Товары и остатки")).click()')
        await waitFor(()=>js('Boolean(document.querySelector(".product-photo img")?.naturalWidth)'))
        await js('document.querySelector(".product-photo").click()')
        await waitFor(()=>js('Boolean(document.querySelector(".photo-view img")?.naturalWidth)'))
        log('restored', { uiStatus: status.data.count, product: products.data[0].name })
        app.quit()
        return
      }
      await require('./electron-features.cjs')({js,invoke,waitFor,win,root,log})
      await js('Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent.includes("Товары и остатки")).click()')
      await waitFor(() => js('Boolean(Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("Загрузить файл")))'))
      await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("Загрузить файл")).click()')
      await waitFor(() => js('Boolean(document.querySelector(".import-options"))'))
      await js('const selects=document.querySelectorAll(".import-options select");selects[0].value="purchase";selects[0].dispatchEvent(new Event("change",{bubbles:true}));selects[1].value="add";selects[1].dispatchEvent(new Event("change",{bubbles:true}))')
      await waitFor(() => js('document.querySelector(".import-options select").value==="purchase"'))
      const preview = await js('document.querySelector(".import-preview tbody tr td:nth-child(4)").innerText')
      assert.ok(preview.includes('100'), `Wrong purchase preview: ${preview}`)
      assert.ok(!preview.includes('101'), `Retail price shown as purchase: ${preview}`)
      await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="Импортировать").click()')
      await waitFor(() => js('document.body.innerText.includes("Импорт завершён:")'))
      const mixed = await invoke('listProducts', { search: 'GUI-MIX' })
      assert.equal(mixed.ok, true); assert.equal(mixed.data[0].quantity, 3); assert.equal(mixed.data[0].purchasePrice, 10033)
      log('import-ui', { price: mixed.data[0].purchasePrice })
      await js('Array.from(document.querySelectorAll("nav button")).find(b=>b.textContent.includes("Настройки")).click()')
      await waitFor(() => js('document.body.innerText.includes("Автокопий:")'))
      const product = await invoke('saveProduct', { product: { article: 'ELECTRON-TEST', name: 'Before restore', purchasePrice: 100, retailPrice: 1000 } })
      assert.equal(product.ok, true)
      for (const [quantity, price] of [[2, 100], [1, 300]]) {
        const receipt = await invoke('createReceipt', { receipt: { date: '2026-10-04', items: [{ variantId: product.data.variantId, quantity, purchasePrice: price }] } })
        assert.equal(receipt.ok, true)
      }
      await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("Сохранить в файл")).click()')
      await waitFor(() => js('document.body.innerText.includes("Резервная копия сохранена:")'))
      assert.ok(fs.existsSync(path.join(root, 'manual.bossshop')))
      const overwritten = await js('window.bossShop.backupDatabase(sessionStorage.getItem("boss-shop-token"))')
      assert.equal(overwritten.ok, true, 'Cannot replace existing manual backup on Windows')
      const changed = await invoke('quickEditProduct', { scope: 'product', id: product.data.productId, field: 'name', value: 'After backup' })
      assert.equal(changed.ok, true)
      const rename = fs.renameSync
      fs.renameSync = (source, destination) => { if (destination === path.join(profile, 'boss-shop.sqlite')) throw new Error('injected Electron restore EACCES'); return rename(source, destination) }
      try {
        const failedRestore = await js('window.bossShop.restoreDatabase(sessionStorage.getItem("boss-shop-token"))')
        assert.equal(failedRestore.ok, false); assert.ok(failedRestore.error.includes('restore EACCES'))
      } finally { fs.renameSync = rename }
      const stillUsable = await invoke('listProducts', { search: product.data.article })
      assert.equal(stillUsable.ok, true); assert.equal(stillUsable.data[0].name, 'After backup')
      log('restore-error-preserved-database')
      win.minimize()
      await waitFor(() => win.isMinimized())
      log('ready', { userData: app.getPath('userData') })
      const commandFile = path.join(root, 'command.json')
      const timer = setInterval(async () => {
        if (!fs.existsSync(commandFile)) return
        clearInterval(timer)
        fs.writeFileSync(stagePath, JSON.stringify({ stage: 'restoring' }))
        try {
          await js('window.confirm=()=>true; Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("Восстановить из файла")).click()')
          await waitFor(() => js('document.body.innerText.includes("Данные восстановлены." )'))
          log('restore-requested')
        } catch (error) { log('failure', { message: error.stack }); app.exit(1) }
      }, 100)
    } catch (error) { log('failure', { message: error.stack }); app.exit(1) }
  })
})
app.on('will-quit', () => log('will-quit'))
require(path.join(appRoot, 'electron', 'main.cjs'))
