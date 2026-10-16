const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { initializeSqlite, DatabaseSync } = require('../electron/sqlite.cjs')

;(async () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html')), 'Run npm run build before the Electron test')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-electron-'))
  fs.writeFileSync(path.join(root, 'mixed.csv'), '\uFEFFАртикул;Товар;Количество;Цена\nGUI-MIX;GUI Mix;2;100.00\nGUI-MIX;GUI Mix;1;101.00\n')
  const executable = process.env.BOSS_SHOP_TEST_EXECUTABLE || require('electron')
  fs.copyFileSync(path.join(__dirname,'fixtures/product.jpg'),path.join(root,'photo.jpg'))
  const fixture = path.join(__dirname, 'electron-runtime-fixture.cjs')
  const children = []
  let succeeded = false
  const events = id => {
    const file = path.join(root, `${id}.jsonl`)
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  }
  const waitFor = async predicate => {
    const until = Date.now() + 30000
    while (Date.now() < until) {
      for (const id of ['first','second']) {
        const failed = events(id).find(event => ['fatal', 'failure', 'renderer-gone'].includes(event.event))
        if (failed) throw new Error(JSON.stringify(failed))
      }
      const result = await predicate()
      if (result) return result
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Electron test timeout; events: ${JSON.stringify([...events('first'), ...events('second')])}`)
  }
  const launch = id => {
    const env = { ...process.env, BOSS_SHOP_TEST_ROOT: root, BOSS_SHOP_TEST_INSTANCE: id }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.VITE_DEV_SERVER_URL
    const child = spawn(executable, [fixture], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.output = ''
    child.stdout.on('data', bytes => { child.output += bytes.toString() })
    child.stderr.on('data', bytes => { child.output += bytes.toString() })
    child.on('error', error => { child.launchError = error })
    child.finished = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    children.push(child)
    return child
  }
  try {
    const first = launch('first')
    await waitFor(() => events('first').find(event => event.event === 'ready'))
    assert.ok(events('first').some(event=>event.event==='features-ui'),'New feature renderer checks did not run')
    assert.equal(events('first')[0].event, 'lock')
    assert.equal(events('first')[0].locked, true)
    const database = path.join(root, 'profile', 'boss-shop.sqlite')
    const before = fs.readFileSync(database)
    const second = launch('second')
    let exitTimer
    let secondExit
    try { secondExit = await Promise.race([second.finished, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('Second process did not exit')), 20000) })]) }
    finally { clearTimeout(exitTimer) }
    assert.equal(secondExit.code, 0, second.output)
    assert.equal(events('second').find(event => event.event === 'lock').locked, false)
    assert.equal(events('second').some(event => event.event === 'database-open'), false)
    assert.deepEqual(fs.readFileSync(database), before, 'Second process modified the database')
    const focus = await waitFor(() => events('first').find(event => event.event === 'second-instance-observed'))
    assert.equal(focus.minimized, false); assert.equal(focus.visible, true); assert.equal(focus.focused, true)
    fs.writeFileSync(path.join(root, 'command.json'), JSON.stringify({ command: 'restore' }))
    const restored = await waitFor(() => events('first').find(event => event.event === 'restored'))
    await waitFor(() => events('first').some(event => event.event === 'will-quit' && event.pid === restored.pid))
    assert.notEqual(restored.pid, first.pid, 'Restore did not relaunch Electron')
    await first.finished
    await initializeSqlite()
    const opened = new DatabaseSync(database, { readOnly: true })
    const safetyName = fs.readdirSync(path.dirname(database)).find(name => name.startsWith('BossShop-before-restore-'))
    assert.ok(safetyName)
    const safety = new DatabaseSync(path.join(path.dirname(database), safetyName), { readOnly: true })
    try {
      assert.equal(opened.prepare('SELECT name FROM products WHERE name=?').get('Before restore').name, 'Before restore')
      assert.equal(safety.prepare('SELECT name FROM products WHERE name=?').get('After backup').name, 'After backup')
      assert.equal(Object.values(opened.prepare('PRAGMA quick_check').get())[0], 'ok')
      assert.equal(opened.prepare('SELECT stock_cost FROM product_variants JOIN products ON products.id=product_variants.product_id WHERE article=?').get('GUI-MIX').stock_cost, 30100)
    } finally { opened.close(); safety.close() }
    succeeded = true
    console.log('Electron passed: isolated profile; separate category/brand columns and inline edit; multi-size model and stock; click sort within model; inline sale edit and composition/prices/stock; automatic numbers/photo picker-preview-save-reopen/full backup restore/hard delete confirm-cancel/history/seller columns; date-only form/table/export; return locks and stale-save error; weighted import; single instance; backup/restore and actual relaunch')
  } catch (error) {
    console.error(`Isolated test artifacts: ${root}`)
    for (const child of children) if (child.output) console.error(child.output)
    throw error
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    // A relaunch is a new process: kill only PIDs recorded by this isolated fixture
    // if a failed test left it alive. Never target real Boss Shop processes.
    if (!succeeded) {
      for (const pid of new Set(events('first').map(event => event.pid))) { try { process.kill(pid) } catch {} }
    }
    if (succeeded) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
