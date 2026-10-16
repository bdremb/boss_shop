const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {initializeSqlite}=require('../electron/sqlite.cjs')
const {openDatabase}=require('../electron/database.cjs')
const {createRepository}=require('../electron/repository.cjs')
const {sortVariants}=require('../src/productSort.ts')
;(async()=>{
  await initializeSqlite();const root=fs.mkdtempSync(path.join(os.tmpdir(),'boss-model-'));const db=openDatabase(path.join(root,'test.sqlite'))
  try{
    const api=createRepository(db),token=api.login({login:'admin',password:'admin123'}).token,catalog=api.bootstrap({_token:token})
    const categoryId=catalog.categories[0].id
    const model={article:'MODEL',name:'Модель',brand:'Brand',categoryId,variants:[{sizeName:' 48 ',quantity:2,purchasePrice:101,retailPrice:500,color:'Черный'},{sizeName:'S',quantity:1,purchasePrice:200,retailPrice:600},{sizeName:'Новый',quantity:0,purchasePrice:0,retailPrice:0}]}
    const result=api.saveProduct({_token:token,product:model})
    let rows=api.listProducts({_token:token,categoryId,brand:'Brand'})
    assert.equal(rows.length,3);assert.equal(new Set(rows.map(x=>x.productId)).size,1);assert.equal(rows[0].productId,result.productId)
    assert.equal(new Set(rows.map(x=>x.sizeId)).size,3)
    assert.equal(db.prepare('SELECT SUM(stock_cost) total FROM product_variants').get().total,402)
    assert.equal(api.listProducts({_token:token,sizeId:rows.find(x=>x.size==='48').sizeId}).length,1)
    const snapshot=()=>['products','product_variants','sizes','stock_movements','audit_log'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())
    const before=snapshot()
    for(const variants of [[],[{sizeName:'',quantity:1,purchasePrice:1,retailPrice:1}],[...model.variants,{...model.variants[0],sizeName:'48',color:'черный'}],[model.variants[0],{sizeName:'Should Roll Back',quantity:-1,purchasePrice:1,retailPrice:1}]]){
      assert.throws(()=>api.saveProduct({_token:token,product:{...model,article:'FAIL',variants}}))
      assert.deepEqual(snapshot(),before)
    }
    // Preserve existing single-variant card editing and add another variant.
    const first=rows[0]
    api.saveProduct({_token:token,product:{...first,name:'Обновлено',retailPrice:777}})
    const added=api.saveProduct({_token:token,product:{...first,variantId:undefined,sizeId:undefined,color:'Белый',initialQty:3}})
    assert.equal(added.productId,result.productId)
    assert.throws(()=>api.saveProduct({_token:token,product:{...first,variantId:undefined}}),/уже есть/)
    assert.equal(api.listProducts({_token:token,brand:'Brand'}).length,4)
    const sizes=['XXL','XL','M','S','XS','L','50','48','10','2','XXXL']
    const items=sizes.map((size,i)=>({variantId:i+1,productId:1,size,quantity:i%3,retailPrice:100-i}))
    assert.deepEqual(sortVariants(items,'size',1).map(x=>x.size),['2','10','48','50','XS','S','M','L','XL','XXL','XXXL'])
    assert.deepEqual(sortVariants(items,'size',-1).map(x=>x.size),['XXXL','XXL','XL','L','M','S','XS','50','48','10','2'])
    const sorted=sortVariants(items,'quantity',-1)
    assert.ok(sorted.every((x,i)=>!i||sorted[i-1].quantity>=x.quantity))
    assert.deepEqual(sorted.filter(x=>x.quantity===0).map(x=>x.variantId),[1,4,7,10])
    assert.deepEqual(items.map(x=>x.size),sizes,'Sorting must not mutate source')
    const withUnknown=[...items,{variantId:99,size:'New'},{variantId:100,size:'—'}]
    assert.deepEqual(sortVariants(withUnknown,'size',1).slice(-2).map(x=>x.size),['New','—'])
    assert.deepEqual(api.listProductBrands({_token:token}),['Brand'])
    console.log('Model/sorting passed: atomic multi-size stock, new sizes, duplicates/rollback, filters, single card/add variant, numeric/letter sizes and stable direction')
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1})
