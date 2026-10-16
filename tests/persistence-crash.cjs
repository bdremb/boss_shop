// Child process: deliberately terminate without finally/close after a disk step.
const fs = require('node:fs')
const { DatabaseSync, initializeSqlite } = require('../electron/sqlite.cjs')
;(async () => {
  await initializeSqlite()
  const [file, phase] = process.argv.slice(2)
  const db = new DatabaseSync(file)
  const open = fs.openSync, write = fs.writeFileSync, rename = fs.renameSync, sync = fs.fsyncSync
  const descriptors = new Map()
  const crash = () => { write.call(fs, `${file}.crash-stage`, phase); process.kill(process.pid, 'SIGKILL') }
  fs.openSync = function (name, ...args) { const fd = open.call(fs, name, ...args); descriptors.set(fd, String(name)); return fd }
  fs.writeFileSync = function (fd, bytes, ...args) {
    if (phase === 'partial' && descriptors.get(fd)?.startsWith(`${file}.pending-`)) {
      write.call(fs, fd, bytes.subarray(0, 32)); crash()
    }
    return write.call(fs, fd, bytes, ...args)
  }
  fs.fsyncSync = function (fd) {
    const result = sync.call(fs, fd)
    if (phase === 'flushed' && descriptors.get(fd)?.startsWith(`${file}.pending-`)) crash()
    return result
  }
  fs.renameSync = function (source, destination) {
    if (phase === 'before-replace' && destination === file) crash()
    const result = rename.call(fs, source, destination)
    if ((phase === 'after-replace' && destination === file) || (phase === 'previous' && destination === `${file}.previous`)) crash()
    return result
  }
  db.exec('BEGIN IMMEDIATE')
  db.prepare('UPDATE sample SET value=2').run()
  db.exec('COMMIT')
  throw new Error('Crash hook was not reached')
})().catch(error => { console.error(error); process.exitCode = 1 })
