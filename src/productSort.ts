import type { Product } from './types'

export type VariantSortKey = 'size' | 'color' | 'quantity' | 'purchasePrice' | 'retailPrice' | 'barcode'
const letters = ['XXXS','XXS','XS','S','M','L','XL','XXL','XXXL','4XL','5XL','6XL','7XL','8XL']
export function compareSizes(a:string,b:string) {
  const normalize=(x:string)=>x.trim().toUpperCase().replace(/^2XL$/,'XXL').replace(/^3XL$/,'XXXL')
  const left=normalize(a),right=normalize(b),li=letters.indexOf(left),ri=letters.indexOf(right)
  const rank=(value:string,index:number)=>!value||value==='—'?3:index>=0?1:/^\d/.test(value)?0:2
  const lr=rank(left,li),rr=rank(right,ri)
  if(lr!==rr)return lr-rr
  if(li>=0&&ri>=0)return li-ri
  return left.localeCompare(right,'ru',{numeric:true,sensitivity:'base'})
}
export function sortVariants(items:Product[],key:VariantSortKey,direction:1|-1):Product[] {
  return [...items].sort((a,b)=>{
    const left=a[key]??'',right=b[key]??''
    const comparison=key==='size'?compareSizes(String(left),String(right)):typeof left==='number'&&typeof right==='number'?left-right:String(left).localeCompare(String(right),'ru',{numeric:true,sensitivity:'base'})
    return comparison*direction||a.variantId-b.variantId
  })
}
