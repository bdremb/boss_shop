const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { initializeSqlite } = require('../electron/sqlite.cjs')
const { openDatabase } = require('../electron/database.cjs')
const { createRepository } = require('../electron/repository.cjs')

;(async()=>{
  await initializeSqlite()
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'boss-sale-edit-')),file=path.join(root,'test.sqlite')
  let db,api,token
  const connect=()=>{db=openDatabase(file);api=createRepository(db);token=api.login({login:'admin',password:'admin123'}).token}
  const invoke=(method,payload)=>api[method]({_token:token,...payload})
  const stock=id=>db.prepare('SELECT quantity,stock_cost FROM product_variants WHERE id=?').get(id)
  const state=()=>Object.fromEntries(['sales','sale_items','returns','return_items','product_variants','stock_movements','audit_log'].map(t=>[t,db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()]))
  const get=id=>invoke('getSale',{saleId:id})
  const update=(id,change)=>{const s=get(id);return invoke('updateSale',{sale:{id,date:s.soldAt,paymentMethod:s.paymentMethod,employeeId:s.employeeId,comment:s.comment,expectedVersion:s.editVersion,...change}})}
  const line=s=>s.items.map(x=>({id:x.id,variantId:x.variantId,quantity:x.quantity,salePrice:x.salePrice}))
  try{
    connect()
    const a=invoke('saveProduct',{product:{article:'A',name:'A',purchasePrice:100,retailPrice:1000}}).variantId
    const b=invoke('saveProduct',{product:{article:'B',name:'B',purchasePrice:400,retailPrice:1500,initialQty:5}}).variantId
    for(const [quantity,purchasePrice] of [[2,100],[1,301]])invoke('createReceipt',{receipt:{date:'2026-10-01',items:[{variantId:a,quantity,purchasePrice}]}})
    const sale=invoke('createSale',{sale:{date:'2026-10-01T23:59',requestKey:'one-sale',items:[{variantId:a,quantity:2,salePrice:1000}]}})
    assert.equal(get(sale.id).soldAt,'2026-10-01')
    assert.equal(get(sale.id).items[0].cost,334)
    assert.deepEqual(stock(a),{quantity:1,stock_cost:167})
    invoke('createReceipt',{receipt:{date:'2026-10-02',items:[{variantId:a,quantity:1,purchasePrice:1000}]}})
    update(sale.id,{date:'2026-10-02',paymentMethod:'Карта',comment:'исправлено',items:line(get(sale.id)).map(x=>({...x,salePrice:1200}))})
    assert.equal(get(sale.id).items[0].cost,334,'Price edit repriced history')
    assert.deepEqual(stock(a),{quantity:2,stock_cost:1167})
    update(sale.id,{items:line(get(sale.id)).map(x=>({...x,quantity:3}))})
    assert.equal(get(sale.id).items[0].cost,918,'Only the extra unit should cost today’s 584')
    assert.deepEqual(stock(a),{quantity:1,stock_cost:583})
    update(sale.id,{items:line(get(sale.id)).map(x=>({...x,quantity:2}))})
    assert.equal(get(sale.id).items[0].cost,612)
    assert.deepEqual(stock(a),{quantity:2,stock_cost:889})
    const originalId=get(sale.id).items[0].id
    update(sale.id,{items:line(get(sale.id)).map(x=>({...x,variantId:b}))})
    assert.equal(get(sale.id).items[0].id,originalId)
    assert.equal(get(sale.id).items[0].product,'B')
    assert.equal(get(sale.id).items[0].cost,800)
    assert.deepEqual(stock(a),{quantity:4,stock_cost:1501})
    assert.deepEqual(stock(b),{quantity:3,stock_cost:1200})
    let metrics=invoke('dashboard',{from:'2026-10-02',to:'2026-10-02'}).metrics
    assert.equal(metrics.revenue,2400);assert.equal(metrics.cost,800);assert.equal(metrics.grossProfit,1600)
    assert.equal(invoke('dashboard',{from:'2026-10-01',to:'2026-10-01'}).metrics.revenue,0)
    assert.ok(invoke('operationHistory',{from:'2026-10-02',to:'2026-10-02'}).some(x=>x.type==='sale_edit'))
    const stale=get(sale.id)
    invoke('createReturn',{data:{saleId:sale.id,date:'2026-10-03',items:[{saleItemId:originalId,quantity:1}]}})
    assert.deepEqual(stock(b),{quantity:4,stock_cost:1600})
    const returned=db.prepare('SELECT * FROM return_items').all()
    update(sale.id,{date:'2026-10-04',comment:'безопасная правка'})
    assert.deepEqual(db.prepare('SELECT * FROM return_items').all(),returned)
    assert.equal(get(sale.id).items[0].returnedQuantity,1)
    const before=state()
    for(const change of [ {quantity:0}, {quantity:1}, {quantity:3}, {salePrice:999}, {variantId:a} ]){
      assert.throws(()=>update(sale.id,{items:line(get(sale.id)).map(x=>({...x,...change}))}))
      assert.deepEqual(state(),before)
    }
    assert.throws(()=>update(sale.id,{items:[]}),/Добавьте/)
    assert.throws(()=>update(sale.id,{expectedVersion:stale.editVersion}),/уже изменена/)
    // A separate line remains editable in a sale containing a returned line.
    update(sale.id,{items:[...line(get(sale.id)),{variantId:a,quantity:1,salePrice:500}]})
    update(sale.id,{items:line(get(sale.id)).map(x=>x.variantId===a?{...x,quantity:2,salePrice:600}:x)})
    const saved=state()
    assert.throws(()=>update(sale.id,{items:line(get(sale.id)).map(x=>x.variantId===a?{...x,quantity:999}:x)}),/Недостаточно/)
    assert.deepEqual(state(),saved,'Stock error must roll back every table')
    assert.throws(()=>update(sale.id,{items:[...line(get(sale.id)).map(x=>x.variantId===a?{...x,quantity:1}:x),{variantId:999999,quantity:1,salePrice:1}]}),/Недостаточно/)
    assert.deepEqual(state(),saved,'Failure after releasing historical stock must restore that release')
    assert.throws(()=>update(sale.id,{date:'2026-02-30'}),/дату/)
    assert.throws(()=>update(sale.id,{items:[...line(get(sale.id)),line(get(sale.id))[0]]}),/Повтор/)
    assert.throws(()=>invoke('createSale',{sale:{date:'2026-10-04',requestKey:'one-sale',items:[{variantId:a,quantity:1,salePrice:1}]}}),/уже проведена/)
    assert.throws(()=>invoke('createSale',{sale:{date:'2026-10-04',items:[{variantId:a,quantity:1,salePrice:Number.MAX_SAFE_INTEGER},{variantId:b,quantity:1,salePrice:1}]}}),/диапазон/)
    assert.deepEqual(state(),saved)
    // Inject an actual persistence failure after all accounting work.
    const rename=fs.renameSync
    fs.renameSync=(src,dst)=>{if(dst===file)throw new Error('injected sale write failure');return rename(src,dst)}
    try{assert.throws(()=>update(sale.id,{comment:'must roll back',items:line(get(sale.id)).map(x=>x.variantId===a?{...x,quantity:1}:x)}),/injected sale write failure/)}finally{fs.renameSync=rename}
    assert.deepEqual(state(),saved)
    const seller=api.login({login:'seller',password:'seller123'}).token
    assert.throws(()=>api.updateSale({_token:seller,sale:{id:sale.id}}),/прав/)
    const safe=api.getSale({_token:seller,saleId:sale.id})
    for(const item of safe.items)for(const key of ['purchasePrice','cost','grossProfit'])assert.equal(key in item,false)
    db.close();connect()
    assert.deepEqual(state(),saved,'Reopen must preserve edited sale, return links, costs and audit')
    // Final return fully restores the unchanged returned line's historical cost.
    invoke('createReturn',{data:{saleId:sale.id,date:'2026-10-05',items:[{saleItemId:originalId,quantity:1}]}})
    assert.equal(db.prepare('SELECT SUM(cost) total FROM return_items WHERE sale_item_id=?').get(originalId).total,800)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log WHERE entity_type=? AND action=?').get('sale','UPDATE').n,7)
    metrics=invoke('dashboard',{from:'2026-10-01',to:'2026-10-05'}).metrics
    assert.equal(metrics.revenue,1200);assert.equal(metrics.cost,get(sale.id).items.find(x=>x.variantId===a).cost)
    update(sale.id,{items:line(get(sale.id)).filter(x=>x.variantId===b)})
    assert.deepEqual(stock(a),{quantity:4,stock_cost:1501},'Removing a line restores its exact historical value')
    console.log('Sale editing passed: historical cost/deltas/replacement, reports, partial returns, safe edits, rejected changes/duplicates/stale saves, persistence rollback, roles, reopen')
  }finally{if(db)db.close();fs.rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1})
