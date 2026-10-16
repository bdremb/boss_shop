import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Trash2, Boxes, ChevronDown, ChevronRight, FileSpreadsheet, Layers3, PackagePlus, Palette, Pencil, Plus, RotateCcw, Ruler, Upload } from 'lucide-react'
import { call, commitProductImport, exportRows, selectProductImport, selectProductPhoto } from '../api'
import { Button, Empty, ExportMenu, Field, Input, Modal, PageHeader, Pill, SearchInput, Select } from '../components'
import type { Catalogs, Product, User } from '../types'
import { money, number, rubles, toCents, today } from '../utils'
import { sortVariants, type VariantSortKey } from '../productSort'
import { InlineField } from '../InlineField'

export default function Products({user,catalogs,refreshCatalogs}:{user:User;catalogs:Catalogs;refreshCatalogs:()=>void}){
  const [products,setProducts]=useState<Product[]>([]),[search,setSearch]=useState(''),[categoryId,setCategory]=useState(''),[sizeId,setSize]=useState(''),[stock,setStock]=useState(''),[brand,setBrand]=useState(''),[cost,setCost]=useState(''),[editing,setEditing]=useState<Product|null|undefined>(undefined),[summary,setSummary]=useState<any>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[importPreview,setImportPreview]=useState<any|undefined>(undefined),[importReport,setImportReport]=useState<any|undefined>(undefined),[importBusy,setImportBusy]=useState(false),[expanded,setExpanded]=useState<Set<number>>(new Set()),[sort,setSort]=useState<{key:SortKey;direction:1|-1}>({key:'name',direction:1})
  const [variantSort,setVariantSort]=useState<{key:VariantSortKey;direction:1|-1}>({key:'size',direction:1})
  const [includeHidden,setIncludeHidden]=useState(false),[viewPhoto,setViewPhoto]=useState<{data:string;name:string}|null>(null)
  const [brands,setBrands]=useState<string[]>([])
  const [activeField,setActiveField]=useState<string|null>(null)
  const [details,setDetails]=useState<Set<number>>(new Set())
  const load=()=>Promise.all([call<Product[]>('listProducts',{search,categoryId,sizeId,stock,brand,cost,includeHidden}),call<string[]>('listProductBrands')]).then(([items,brands])=>{setProducts(items);setBrands(brands)}).catch(e=>setError(e.message))
  const loadSummary=()=>call('inventorySummary').then(setSummary)
  useEffect(()=>{const id=setTimeout(load,120);return()=>clearTimeout(id)},[search,categoryId,sizeId,stock,brand,cost,includeHidden])
  useEffect(()=>{loadSummary()},[])
  const groups=useMemo(()=>{
    const map=new Map<number,Product[]>()
    for(const product of products){const list=map.get(product.productId)||[];list.push(product);map.set(product.productId,list)}
    return Array.from(map.values()).map(list=>sortVariants(list,variantSort.key,variantSort.direction)).sort((a,b)=>{
      const first=a[0],second=b[0]
      const values:Record<SortKey,(list:Product[])=>string|number>={name:list=>list[0].name,category:list=>list[0].category||'',brand:list=>list[0].brand||'',quantity:list=>list.reduce((sum,item)=>sum+item.quantity,0),purchase:list=>Math.min(...list.map(item=>item.purchasePrice||0)),retail:list=>Math.min(...list.map(item=>item.retailPrice))}
      const left=values[sort.key](a),right=values[sort.key](b)
      const comparison=typeof left==='number'&&typeof right==='number'?left-right:String(left).localeCompare(String(right),'ru',{sensitivity:'base',numeric:true})
      return comparison*sort.direction || first.productId-second.productId
    })
  },[products,sort,variantSort])
  const hasFilters=Boolean(search||categoryId||sizeId||stock||brand||cost)
  function resetFilters(){setSearch('');setCategory('');setSize('');setStock('');setBrand('');setCost('')}
  function changeSort(key:SortKey){setSort(current=>({key,direction:current.key===key&&current.direction===1?-1:1}))}
  function toggleGroup(id:number){setExpanded(current=>{const next=new Set(current);next.has(id)?next.delete(id):next.add(id);return next})}
  function toggleDetails(id:number){setDetails(current=>{const next=new Set(current);next.has(id)?next.delete(id):next.add(id);return next})}
  async function quickEdit(scope:'product'|'variant'|'allVariants',id:number,field:string,value:string){
    let parsed:string|number=value
    if(field==='purchasePrice'||field==='retailPrice'){
      const numeric=Number(value.trim().replace(',','.'))
      if(!value.trim()||!Number.isFinite(numeric)||numeric<0)throw new Error('Укажите корректную цену')
      parsed=Math.round(numeric*100)
    }else if(field==='quantity'||field==='lowStockThreshold'){
      parsed=Number(value)
      if(!value.trim()||!Number.isSafeInteger(parsed)||parsed<0)throw new Error('Укажите целое неотрицательное число')
    }
    await call('quickEditProduct',{scope,id,field,value:parsed})
    await Promise.all([load(),loadSummary()])
  }
  function inline(scope:'product'|'variant'|'allVariants',id:number,field:string,label:string,value:string,display:ReactNode,options?:{value:string;label:string}[],hint?:string){
    const key=`${scope}:${id}:${field}`
    return <InlineField key={key} label={label} value={value} display={display} options={options} hint={hint} editable={user.role==='admin'} active={activeField===key} onActivate={()=>setActiveField(key)} onClose={()=>setActiveField(null)} onCommit={next=>quickEdit(scope,id,field,next)}/>
  }
  async function removeModel(first:Product){
    try {
      const all=await call<Product[]>('listProducts',{includeHidden:true})
      const group=all.filter(x=>x.productId===first.productId),quantity=group.reduce((sum,x)=>sum+x.quantity,0)
      if(!confirm(`Полностью удалить модель «${first.name}» (${first.autoNumber!=null?'№ товара':'Артикул'} ${first.article})?\nВариантов: ${group.length}; остаток: ${quantity} шт.\nБудут удалены все размеры, цвета, фото и остатки. Это необратимо. Исторические документы сохранятся; возврат удалённых позиций будет недоступен.`))return
      await call('deleteProduct',{productId:first.productId});await Promise.all([load(),loadSummary()])
    }catch(e){setError((e as Error).message)}
  }
  async function chooseImport(){setImportBusy(true);setError('');setMessage('');try{const result=await selectProductImport();if(!result.canceled)setImportPreview(result)}catch(e){setError((e as Error).message)}finally{setImportBusy(false)}}
  async function runImport(options:{priceMode:'retail'|'purchase'|'both';stockMode:'set'|'add'|'keep'}){setImportBusy(true);setError('');try{const preview=importPreview;const result=await commitProductImport(preview.importId,options);setImportPreview(undefined);setImportReport({preview,result});setMessage(`Импорт завершён: ${result.products} товаров, создано ${result.createdVariants} позиций, изменение остатка ${result.unitsChanged>0?'+':''}${result.unitsChanged} шт.`);await Promise.all([load(),loadSummary()]);refreshCatalogs()}catch(e){setError((e as Error).message)}finally{setImportBusy(false)}}
  async function doExport(format:'excel'|'csv'|'pdf'){await exportRows(format,'Остатки',products.map(p=>({'№ товара':p.autoNumber??'', 'Прежний артикул':p.autoNumber==null?p.article:'',Товар:p.name,Категория:p.category,Бренд:p.brand,Размер:p.size,Цвет:p.color,Остаток:p.quantity,'Розничная цена':money(p.retailPrice)})))}
  return <div className="page products-page"><PageHeader eyebrow="Склад" title="Товары и остатки" subtitle={`${number(groups.length)} товаров · ${number(products.reduce((a,p)=>a+p.quantity,0))} ед. по выбранным фильтрам`} actions={<>{user.role==='admin'&&<Button variant="soft" icon={<Upload size={17}/>} disabled={importBusy} onClick={chooseImport}>{importBusy?'Читаем файл…':'Загрузить файл'}</Button>}{user.role==='admin'&&<Button icon={<Plus size={17}/>} onClick={()=>setEditing(null)}>Добавить товар</Button>}<ExportMenu onExport={doExport}/></>}/>
    {error&&<div className="notice error" onClick={()=>setError('')}>{error}</div>}
    {message&&<div className="notice success" onClick={()=>setMessage('')}>{message}</div>}
    {summary&&<div className="mini-summary"><div><Boxes/><span><b>{number(summary.byCategory.reduce((a:number,x:any)=>a+Number(x.quantity),0))}</b>общий остаток</span></div><div><Layers3/><span><b>{summary.byCategory.length}</b>категорий</span></div><div><Ruler/><span><b>{summary.bySize.length}</b>размеров на складе</span></div><div><Palette/><span><b>{summary.byColor.length}</b>цветов</span></div></div>}
    {user.role==='admin'&&Boolean(summary?.missingCost?.variants)&&<div className="notice cost-warning"><Boxes/><div><b>Нет закупочной цены у {summary.missingCost.variants} позиций</b><span>Прибыль по их продажам нельзя рассчитать достоверно.</span></div><button onClick={()=>{setCost('missing');setStock('available')}}>Показать позиции</button></div>}
    {importReport&&<section className="panel import-report"><div className="panel-head"><div><span className="eyebrow">Загрузка завершена</span><h2>Отчёт об импорте: {importReport.preview.fileName}</h2></div><button className="text-button" onClick={()=>setImportReport(undefined)}>Закрыть</button></div><div className="import-report-stats"><span>Товаров: <b>{importReport.result.products}</b></span><span>Новых вариантов: <b>{importReport.result.createdVariants}</b></span><span>Обновлено: <b>{importReport.result.updatedVariants}</b></span><span>Пропущено строк: <b>{importReport.preview.skippedRows}</b></span></div>{Boolean(importReport.preview.skipped?.length)&&<><div className="panel-head"><h3>Пропущенные строки</h3><Button variant="ghost" onClick={()=>exportRows('csv','Ошибки импорта',importReport.preview.skipped.map((x:any)=>({Лист:x.sheet,Строка:x.row,Товар:x.name,Причина:x.reason})))}>Сохранить CSV</Button></div><div className="table-scroll issue-list"><table><thead><tr><th>Лист</th><th>Строка</th><th>Товар</th><th>Причина</th></tr></thead><tbody>{importReport.preview.skipped.slice(0,100).map((x:any,index:number)=><tr key={index}><td>{x.sheet}</td><td>{x.row}</td><td>{x.name||'—'}</td><td>{x.reason}</td></tr>)}</tbody></table></div>{importReport.preview.skippedRows>100&&<p className="import-report-note">На экране показаны первые 100 строк. В CSV доступно до 1000 строк.</p>}</>}{Boolean(importReport.preview.warnings?.length)&&<div className="import-warnings">{importReport.preview.warnings.slice(0,10).map((x:string,index:number)=><p key={index}>{x}</p>)}</div>}</section>}
    <section className="panel table-panel"><div className="filters"><SearchInput placeholder="Название, номер / прежний артикул, цвет, размер или бренд" value={search} onChange={e=>setSearch(e.target.value)}/><Select value={categoryId} onChange={e=>setCategory(e.target.value)}><option value="">Все категории</option>{catalogs.categories.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</Select><Select value={sizeId} onChange={e=>setSize(e.target.value)}><option value="">Все размеры</option>{catalogs.sizes.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</Select><Select value={brand} onChange={e=>setBrand(e.target.value)}><option value="">Все бренды</option>{brands.map(x=><option key={x} value={x}>{x}</option>)}</Select><Select value={stock} onChange={e=>setStock(e.target.value)}><option value="">Любой остаток</option><option value="available">В наличии</option><option value="low">Заканчивается</option><option value="none">Нет в наличии</option></Select>{user.role==='admin'&&<Select value={cost} onChange={e=>setCost(e.target.value)}><option value="">Любая себестоимость</option><option value="missing">Без закупочной цены</option></Select>}{user.role==='admin'&&<label className="hidden-products"><input type="checkbox" checked={includeHidden} onChange={e=>setIncludeHidden(e.target.checked)}/>Показать ранее скрытые позиции</label>}{hasFilters&&<button className="reset-filters" onClick={resetFilters}><RotateCcw size={15}/>Сбросить фильтры</button>}</div>
      {user.role==='admin'&&<p className="quick-edit-help">Нажмите на значение, чтобы изменить его прямо в таблице. Enter — сохранить, Esc — отменить. Цена в строке товара применяется ко всем его размерам и цветам.</p>}
      {groups.length?<div className="table-scroll products-table-scroll" data-role={user.role}><table><thead><tr><SortHeader label="Товар" sortKey="name" sort={sort} onSort={changeSort}/><SortHeader label="Категория" sortKey="category" sort={sort} onSort={changeSort}/><SortHeader label="Бренд" sortKey="brand" sort={sort} onSort={changeSort}/><SortHeader label="Остаток" sortKey="quantity" sort={sort} onSort={changeSort} right/>{user.role==='admin'&&<SortHeader label="Закупка" sortKey="purchase" sort={sort} onSort={changeSort} right/>}<SortHeader label="Розница" sortKey="retail" sort={sort} onSort={changeSort} right/>{user.role==='admin'&&<th/>}</tr></thead><tbody>
      {groups.map(group=>{
        const first=group[0],open=expanded.has(first.productId),quantity=group.reduce((sum,item)=>sum+item.quantity,0),low=group.some(item=>item.quantity<=item.lowStockThreshold)
        const onePurchase=group.every(item=>item.purchasePrice===first.purchasePrice),oneRetail=group.every(item=>item.retailPrice===first.retailPrice)
        const allHint=group.length===1?'Изменить цену этой позиции':`Применить ко всем вариантам товара (${group.length})`
        return <Fragment key={first.productId}>
          <tr className={`product-group ${low?'low-stock':''}`}>
            <td><div className="product-heading"><button className="product-expander" onClick={()=>toggleGroup(first.productId)} aria-label={open?'Свернуть варианты':'Показать размеры и цвета'} aria-expanded={open}>{open?<ChevronDown/>:<ChevronRight/>}</button><ProductPhoto product={first} onView={data=>setViewPhoto({data,name:first.name})}/><div className="primary-cell">
              {inline('product',first.productId,'name','Название',first.name,<b>{first.name}</b>)}
              <small>{first.autoNumber!=null?'№ товара':'Артикул'}: {first.article}{(!first.productActive||!first.variantActive)&&' · Ранее скрыт'}</small>
            </div></div></td>
            <td><div className="primary-cell">
              {inline('product',first.productId,'categoryId','Категория',String(first.categoryId||''),<span className="dark">{first.category||'Без категории'}</span>,[{value:'',label:'Без категории'},...catalogs.categories.map(x=>({value:String(x.id),label:x.name}))])}
              </div></td><td><div className="primary-cell">{inline('product',first.productId,'brand','Бренд',first.brand||'',<small>{first.brand||'Бренд не указан'}</small>)}
            </div></td>
            <td className="right"><Pill tone={quantity===0?'bad':low?'warn':'good'}>{quantity} шт.</Pill></td>
            {user.role==='admin'&&<td className="right muted-money">{inline('allVariants',first.productId,'purchasePrice','Закупочная цена',onePurchase?String((first.purchasePrice||0)/100):'',<span className={!group.some(item=>item.purchasePrice)?'missing-price':''}>{priceRange(group.map(item=>item.purchasePrice||0),true)}</span>,undefined,allHint)}</td>}
            <td className="right price">{inline('allVariants',first.productId,'retailPrice','Розничная цена',oneRetail?String(first.retailPrice/100):'',priceRange(group.map(item=>item.retailPrice)),undefined,allHint)}</td>
            {user.role==='admin'&&<td className="row-actions"><button title="Удалить модель полностью" onClick={()=>removeModel(first)}><Trash2/></button><button title="Карточка модели / фото" onClick={()=>setEditing(first)}><Pencil/></button><button className="quick-details-toggle" title="Дополнительные поля без открытия карточки" onClick={()=>toggleDetails(first.productId)} aria-expanded={details.has(first.productId)}>{details.has(first.productId)?'Скрыть':'Ещё поля'}</button><button title="Добавить вариант модели" onClick={()=>setEditing({...first,variantId:0,quantity:0,sizeId:undefined,color:'',barcode:''})}><Plus/></button></td>}
          </tr>
          {user.role==='admin'&&details.has(first.productId)&&<tr className="quick-details-row"><td colSpan={user.role==='admin'?7:5}><div className="quick-details-grid">
            <div><span>Подкатегория</span>{inline('product',first.productId,'subcategoryId','Подкатегория',String(first.subcategoryId||''),first.subcategory||'Не выбрана',[{value:'',label:'Не выбрана'},...catalogs.subcategories.filter(x=>String(x.categoryId)===String(first.categoryId)).map(x=>({value:String(x.id),label:x.name}))])}</div>
            <div><span>Поставщик</span>{inline('product',first.productId,'supplierId','Поставщик',String(first.supplierId||''),first.supplier||'Не выбран',[{value:'',label:'Не выбран'},...catalogs.suppliers.map(x=>({value:String(x.id),label:x.name}))])}</div>
            <div><span>Дата поступления</span>{inline('product',first.productId,'arrivalDate','Дата поступления',first.arrivalDate||'',first.arrivalDate||'Не указана')}</div>
            <div><span>Порог низкого остатка</span>{inline('product',first.productId,'lowStockThreshold','Порог низкого остатка',String(first.lowStockThreshold),`${first.lowStockThreshold} шт.`)}</div>
            <div className="quick-details-note"><span>Примечание</span>{inline('product',first.productId,'note','Примечание',first.note||'',first.note||'Не указано')}</div>
          </div></td></tr>}
          {open&&<tr className="variant-sort-row">{(['size','color'] as VariantSortKey[]).map(key=><VariantHeader key={key} field={key} sort={variantSort} onSort={key=>setVariantSort(current=>({key,direction:current.key===key&&current.direction===1?-1:1}))}/>)}<td/>{(['quantity',...(user.role==='admin'?['purchasePrice']:[]),'retailPrice'] as VariantSortKey[]).map(key=><VariantHeader key={key} field={key} sort={variantSort} onSort={key=>setVariantSort(current=>({key,direction:current.key===key&&current.direction===1?-1:1}))}/>)}{user.role==='admin'&&<td/>}</tr>}
          {open&&group.map(item=><tr key={item.variantId} className="product-variant-row" data-variant-id={item.variantId}>
            <td>{inline('variant',item.variantId,'sizeId','Размер',String(item.sizeId||''),<Pill tone="blue">{item.size}</Pill>,[{value:'',label:'Без размера'},...catalogs.sizes.map(x=>({value:String(x.id),label:x.name}))])}</td>
            <td><span className="color-dot" style={{background:cssColor(item.color)}}/>{inline('variant',item.variantId,'color','Цвет',item.color||'',item.color||'Без цвета')}</td>
            <td/>
            <td className="right">{inline('variant',item.variantId,'quantity','Остаток',String(item.quantity),<Pill tone={item.quantity===0?'bad':item.quantity<=item.lowStockThreshold?'warn':'good'}>{item.quantity} шт.</Pill>)}</td>
            {user.role==='admin'&&<td className="right muted-money">{inline('variant',item.variantId,'purchasePrice','Закупочная цена',String((item.purchasePrice||0)/100),item.purchasePrice?money(item.purchasePrice):<span className="missing-price">Не указана</span>)}</td>}
            <td className="right price">{inline('variant',item.variantId,'retailPrice','Розничная цена',String(item.retailPrice/100),money(item.retailPrice))}</td>
            {user.role==='admin'&&<td className="row-actions"><button title="Изменить остальные поля" onClick={()=>setEditing(item)}><Pencil/></button></td>}
          </tr>)}
        </Fragment>
      })}</tbody></table></div>:<Empty title="Товары не найдены" text="Измените фильтры или добавьте новую товарную позицию."/>}
    </section><Modal open={Boolean(viewPhoto)} title={viewPhoto?.name||'Фото товара'} onClose={()=>setViewPhoto(null)} wide>{viewPhoto&&<div className="photo-view"><img src={viewPhoto.data} alt={viewPhoto.name}/></div>}</Modal><ProductModal value={editing} onClose={()=>setEditing(undefined)} catalogs={catalogs} onSaved={()=>{setEditing(undefined);load();loadSummary();refreshCatalogs()}}/><ImportModal preview={importPreview} busy={importBusy} onClose={()=>setImportPreview(undefined)} onImport={runImport}/>
  </div>
}

type SortKey='name'|'category'|'brand'|'quantity'|'purchase'|'retail'
const photoCache=new Map<string,string>()
function ProductPhoto({product,onView}:{product:Product;onView:(data:string)=>void}){
  const key=`${product.productId}:${product.photoKey||''}`
  const [data,setData]=useState(photoCache.get(key)||'')
  useEffect(()=>{
    let active=true
    setData(photoCache.get(key)||'')
    if(product.photoKey&&!photoCache.has(key))call<{data:string;photoKey:string}>('getProductPhoto',{productId:product.productId}).then(result=>{
      if(result.photoKey!==product.photoKey)return
      if(photoCache.size>=48)photoCache.delete(photoCache.keys().next().value!)
      photoCache.set(key,result.data);if(active)setData(result.data)
    }).catch(()=>{})
    return()=>{active=false}
  },[key,product.productId,product.photoKey])
  return data?<button className="product-photo" title={`Посмотреть фото: ${product.name}`} onClick={()=>onView(data)}><img src={data} alt={product.name}/></button>:null
}
function SortHeader({label,sortKey,sort,onSort,right=false}:{label:string;sortKey:SortKey;sort:{key:SortKey;direction:1|-1};onSort:(key:SortKey)=>void;right?:boolean}){return <th className={right?'right':''} aria-sort={sort.key===sortKey?(sort.direction===1?'ascending':'descending'):'none'}><button className="sort-header" onClick={()=>onSort(sortKey)}>{label}{sort.key===sortKey?<span>{sort.direction===1?'↑':'↓'}</span>:null}</button></th>}
function VariantHeader({field,sort,onSort}:{field:VariantSortKey;sort:{key:VariantSortKey;direction:1|-1};onSort:(key:VariantSortKey)=>void}){const labels={size:'Размер',color:'Цвет',barcode:'Штрихкод',quantity:'Остаток',purchasePrice:'Закупка',retailPrice:'Розница'};return <th aria-sort={sort.key===field?(sort.direction===1?'ascending':'descending'):'none'}><button type="button" className="sort-header" onClick={()=>onSort(field)}>{labels[field]} {sort.key===field?(sort.direction===1?'↑':'↓'):''}</button></th>}
function priceRange(values:number[],missing=false){const known=values.filter(value=>!missing||value>0);if(!known.length)return 'Не указана';const low=Math.min(...known),high=Math.max(...known);return low===high?money(low):`${money(low)} – ${money(high)}`}

function ImportModal({preview,busy,onClose,onImport}:{preview:any|undefined;busy:boolean;onClose:()=>void;onImport:(options:{priceMode:'retail'|'purchase'|'both';stockMode:'set'|'add'|'keep'})=>Promise<void>}){
  const [priceMode,setPriceMode]=useState<'retail'|'purchase'|'both'>('retail'),[stockMode,setStockMode]=useState<'set'|'add'|'keep'>('set')
  useEffect(()=>{if(preview){setPriceMode('retail');setStockMode('set')}},[preview])
  return <Modal open={Boolean(preview)} title="Импорт товаров" subtitle={preview?.fileName} onClose={onClose} wide><div className="modal-body form-stack">{preview&&<><div className="import-summary"><div><FileSpreadsheet/><span><b>{preview.positions}</b>складских позиций</span></div><div><b>{preview.sourceRows}</b><span>строк товаров</span></div><div><b>{preview.sheetCount}</b><span>листов</span></div><div><b>{preview.skippedRows}</b><span>пропущено</span></div></div><div className="import-options"><Field label="Цена из файла"><Select value={priceMode} onChange={e=>setPriceMode(e.target.value as any)}><option value="retail">Розничная</option><option value="purchase">Закупочная</option><option value="both">Закупочная и розничная</option></Select></Field><Field label="Остатки"><Select value={stockMode} onChange={e=>setStockMode(e.target.value as any)}><option value="set">Установить как в файле</option><option value="add">Добавить к текущим</option><option value="keep">Не менять остатки</option></Select></Field></div><p className="import-hint">Одинаковые строки суммируются. При разных ценах закупочная стоимость суммируется точно, розничная цена берётся из последней строки. «Добавить к текущим» усредняет стоимость с закупочной ценой новых единиц. «Установить как в файле» и «Не менять остатки» с закупочной ценой переоценивают весь итоговый остаток. Импорт только розничной цены сохраняет стоимость оставшихся единиц; добавленные оцениваются по текущей средней. Для загрузки только закупочных цен выберите «Закупочная» и «Не менять остатки». Подробные причины пропуска появятся после импорта.</p>{Boolean(preview.skipped?.length)&&<div className="import-preview-issues"><b>Будут пропущены строки:</b>{preview.skipped.slice(0,5).map((x:any,index:number)=><span key={index}>{x.sheet}, строка {x.row}: {x.reason}</span>)}</div>}<div className="table-scroll import-preview"><table><thead><tr><th>Товар</th><th>Категория</th><th>Размер / цвет</th><th className="right">Цена</th><th className="right">Кол-во</th></tr></thead><tbody>{preview.preview.map((row:any,index:number)=><tr key={`${row.article}-${row.size}-${row.color}-${index}`}><td><div className="primary-cell"><b>{row.name}</b><span>{row.article}</span></div></td><td>{row.category}</td><td>{row.size||'—'} · {row.color||'—'}</td><td className="right">{priceMode==='retail'?money(row.priceCents):priceMode==='purchase'?money(row.purchasePriceCents??row.priceCents):`Закупка ${money(row.purchasePriceCents??row.priceCents)} / розница ${money(row.priceCents)}`}</td><td className="right">{row.quantity}</td></tr>)}</tbody></table></div></>}</div><footer className="modal-footer"><Button variant="ghost" onClick={onClose} disabled={busy}>Отмена</Button><Button icon={<Upload/>} disabled={busy} onClick={()=>onImport({priceMode,stockMode})}>{busy?'Импортируем…':'Импортировать'}</Button></footer></Modal>
}

function cssColor(color:string){const c=color.toLowerCase();const map:Record<string,string>={черный:'#1a1c1f',белый:'#eee',синий:'#315b88',голубой:'#79add4',серый:'#8a8f94',бежевый:'#cab998',коричневый:'#72503b',красный:'#a84343',зеленый:'#51725a'};return map[c]||'#c9a45f'}

function ProductModal({value,onClose,catalogs,onSaved}:{value:Product|null|undefined;onClose:()=>void;catalogs:Catalogs;onSaved:()=>void}){
  const open=value!==undefined,isNew=value===null,isAdding=Boolean(value&&!value.variantId)
  const [sizeList,setSizeList]=useState(''),[variants,setVariants]=useState<any[]>([])
  const [photo,setPhoto]=useState(''),[photoChanged,setPhotoChanged]=useState(false),[photoBusy,setPhotoBusy]=useState(false)
  const [form,setForm]=useState<any>({}),[busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{setPhoto('');setPhotoChanged(false);setSizeList('');setVariants([]);setError('');if(open)setForm(value?{...value,purchasePrice:rubles(value.purchasePrice),retailPrice:rubles(value.retailPrice),initialQty:0}:{article:'',name:'',categoryId:'',subcategoryId:'',brand:'',supplierId:'',sizeId:'',color:'',purchasePrice:'',retailPrice:'',barcode:'',arrivalDate:today(),note:'',lowStockThreshold:2,initialQty:0})},[value,open])
  useEffect(()=>{let active=true;setPhotoBusy(Boolean(value?.productId));if(value?.productId)call<{data:string}>('getProductPhoto',{productId:value.productId}).then(x=>{if(active)setPhoto(x.data)}).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setPhotoBusy(false)});return()=>{active=false}},[value])
  async function choosePhoto(){setPhotoBusy(true);setError('');try{const result=await selectProductPhoto();if(!result.canceled){setPhoto(result.data||'');setPhotoChanged(true)}}catch(e){setError((e as Error).message)}finally{setPhotoBusy(false)}}
  const set=(k:string,v:any)=>setForm((f:any)=>({...f,[k]:v}))
  function distributeSizes(){
    const names=sizeList.split(/[,;\n]+/).map(x=>x.trim()).filter(Boolean)
    if(!names.length){setError('Введите размеры через запятую или выберите из списка');return}
    const known=new Set(variants.map(x=>x.sizeName.toLocaleUpperCase('ru-RU')))
    const added=names.filter(x=>{const key=x.toLocaleUpperCase('ru-RU');if(known.has(key))return false;known.add(key);return true}).map(sizeName=>({sizeName,quantity:form.initialQty||0,color:form.color||'',purchasePrice:form.purchasePrice||'0',retailPrice:form.retailPrice||'0',barcode:''}))
    setVariants(current=>[...current,...added]);setSizeList('');setError('')
  }
  async function save(e:React.FormEvent){e.preventDefault();if(busy)return;setBusy(true);setError('');try{
    if(isNew&&sizeList.trim())throw new Error('Сначала нажмите «Распределить размеры», чтобы проверить таблицу вариантов')
    await call('saveProduct',{product:{...form,...(photoChanged?{photoData:photo}:{}),purchasePrice:toCents(form.purchasePrice),retailPrice:toCents(form.retailPrice),...(isNew&&variants.length?{variants:variants.map(x=>({...x,quantity:Number(x.quantity),purchasePrice:toCents(x.purchasePrice),retailPrice:toCents(x.retailPrice)}))}:{})}})
    onSaved()
  }catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  const subcats=catalogs.subcategories.filter(x=>!form.categoryId||String(x.categoryId)===String(form.categoryId))
  return <Modal open={open} title={isNew?'Новый товар':isAdding?'Новый вариант модели':'Карточка товара'} subtitle="Размер и цвет образуют отдельную складскую позицию" onClose={onClose} wide><form onSubmit={save}><div className="modal-body form-grid">
    <Field label={form.autoNumber!=null||isNew?"№ товара":"Прежний артикул"}><Input readOnly value={isNew?"Будет присвоен при сохранении":form.article||''}/></Field><Field label="Название *" className="span-2"><Input required value={form.name||''} onChange={e=>set('name',e.target.value)}/></Field>
    <div className="span-3 photo-editor"><div>{photo?<img src={photo} alt="Превью фото товара"/>:<span>Фото не добавлено</span>}</div><Button type="button" variant="soft" disabled={photoBusy} onClick={choosePhoto}>{photoBusy?'Обрабатываем…':photo?'Заменить фото':'Добавить фото'}</Button>{photo&&<Button type="button" variant="ghost" disabled={photoBusy} onClick={()=>{setPhoto('');setPhotoChanged(true)}}>Убрать фото</Button>}<small>JPEG, PNG или WebP до 10 МБ; максимум 12000 px и 40 Мп. Фото общее для всех размеров и цветов, сохраняется вместе с карточкой.</small></div>
    <Field label="Категория"><Select value={form.categoryId||''} onChange={e=>{set('categoryId',e.target.value);set('subcategoryId','')}}><option value="">Не выбрана</option>{catalogs.categories.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="Подкатегория"><Select value={form.subcategoryId||''} onChange={e=>set('subcategoryId',e.target.value)}><option value="">Не выбрана</option>{subcats.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="Бренд"><Input value={form.brand||''} onChange={e=>set('brand',e.target.value)}/></Field>
    {isNew&&<div className="span-3 multi-size-editor"><h3>Размеры модели</h3><p>Введите размеры через запятую или добавьте из справочника. Повторы в списке объединяются. Затем задайте остаток, цвет и цены для каждого варианта.</p><p>Цвет, цены и начальный остаток из общих полей копируются при распределении. Уже созданные строки изменяйте в таблице ниже.</p><div className="inline-form"><Field label="Список размеров"><textarea className="input" aria-label="Список размеров" value={sizeList} onChange={e=>setSizeList(e.target.value)} placeholder="46, 48, 50, S, M, XL"/></Field><Field label="Добавить размер"><Select aria-label="Добавить размер" value="" onChange={e=>{if(e.target.value)setSizeList(current=>current?current+', '+e.target.value:e.target.value)}}><option value="">Выбрать…</option>{catalogs.sizes.map(x=><option key={x.id} value={x.name}>{x.name}</option>)}</Select></Field><Button type="button" variant="soft" onClick={distributeSizes}>Распределить размеры</Button></div>{variants.length>0&&<div className="table-scroll"><table className="multi-size-table"><thead><tr><th>Размер</th><th>Цвет</th><th>Остаток</th><th>Закупка, ₽</th><th>Розница, ₽</th><th>Штрихкод</th><th/></tr></thead><tbody>{variants.map((row,index)=><tr key={index}>{['sizeName','color','quantity','purchasePrice','retailPrice','barcode'].map(key=><td key={key}><Input aria-label={key+' '+(index+1)} required={key==='sizeName'} type={['quantity','purchasePrice','retailPrice'].includes(key)?'number':'text'} min="0" step={key==='quantity'?'1':'0.01'} value={row[key]} onChange={e=>setVariants(current=>current.map((x,i)=>i===index?{...x,[key]:e.target.value}:x))}/></td>)}<td><button type="button" aria-label="Убрать размер" onClick={()=>setVariants(current=>current.filter((_,i)=>i!==index))}>×</button></td></tr>)}</tbody></table></div>}</div>}
    <Field label={variants.length?'Размер (только для одного варианта)':'Размер'}><Select disabled={variants.length>0} value={form.sizeId||''} onChange={e=>set('sizeId',e.target.value)}><option value="">Без размера</option>{catalogs.sizes.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="Цвет"><Input value={form.color||''} onChange={e=>set('color',e.target.value)} placeholder="Например, черный"/></Field><Field label="Штрихкод"><Input value={form.barcode||''} onChange={e=>set('barcode',e.target.value)}/></Field>
    <p className="import-hint">Закупочная цена — средняя стоимость текущего остатка. Её ручное изменение переоценивает весь остаток; сохранение той же цены оставляет точную стоимость без изменений. Новые поставки с другой ценой оформляйте поступлением. История продаж и возвратов сохраняется.</p><Field label="Закупочная цена, ₽"><Input type="number" min="0" step="0.01" value={form.purchasePrice||''} onChange={e=>set('purchasePrice',e.target.value)}/></Field><Field label="Розничная цена, ₽"><Input required={!variants.length} type="number" min="0" step="0.01" value={form.retailPrice||''} onChange={e=>set('retailPrice',e.target.value)}/></Field>{(isNew||isAdding)&&<Field label="Начальный остаток, шт."><Input type="number" min="0" value={form.initialQty||0} onChange={e=>set('initialQty',e.target.value)}/></Field>}
    <Field label="Поставщик"><Select value={form.supplierId||''} onChange={e=>set('supplierId',e.target.value)}><option value="">Не выбран</option>{catalogs.suppliers.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="Дата поступления"><Input type="date" value={form.arrivalDate||''} onChange={e=>set('arrivalDate',e.target.value)}/></Field><Field label="Порог низкого остатка"><Input type="number" min="0" value={form.lowStockThreshold??2} onChange={e=>set('lowStockThreshold',e.target.value)}/></Field><Field label="Примечание" className="span-3"><textarea className="input" value={form.note||''} onChange={e=>set('note',e.target.value)}/></Field>
    {error&&<div className="form-error span-3">{error}</div>}
  </div><footer className="modal-footer"><Button type="button" variant="ghost" onClick={onClose}>Отмена</Button><Button type="submit" disabled={busy||photoBusy} icon={isNew?<PackagePlus size={17}/>:undefined}>{busy?'Сохраняем…':isNew?'Создать товар':'Сохранить изменения'}</Button></footer></form></Modal>
}
