import { BarChart3, Boxes, ChevronLeft, CircleDollarSign, ClipboardList, LayoutDashboard, LogOut, PackagePlus, ReceiptText, RotateCcw, Settings, ShoppingBag, Tags, UserRound, WalletCards } from 'lucide-react'
import type { ReactNode } from 'react'
import type { User } from './types'
import { BrandMark } from './components'

export type PageKey = 'dashboard'|'products'|'receipts'|'sales'|'returns'|'writeoffs'|'expenses'|'reports'|'profit'|'history'|'settings'

const items: {key:PageKey;label:string;icon:any;admin?:boolean;group?:string}[]=[
  {key:'dashboard',label:'Главная',icon:LayoutDashboard,group:'Работа'},
  {key:'products',label:'Товары и остатки',icon:Boxes},
  {key:'receipts',label:'Поступления',icon:PackagePlus,admin:true},
  {key:'sales',label:'Продажи',icon:ShoppingBag},
  {key:'returns',label:'Возвраты',icon:RotateCcw,admin:true},
  {key:'writeoffs',label:'Списания',icon:ClipboardList,admin:true},
  {key:'expenses',label:'Расходы',icon:WalletCards,admin:true,group:'Финансы'},
  {key:'reports',label:'Аналитика',icon:BarChart3,admin:true},
  {key:'profit',label:'Прибыль и убытки',icon:CircleDollarSign,admin:true},
  {key:'history',label:'История операций',icon:ReceiptText,admin:true},
  {key:'settings',label:'Настройки',icon:Settings,admin:true,group:'Система'}
]

export default function Layout({user,page,onPage,onLogout,children}:{user:User;page:PageKey;onPage:(p:PageKey)=>void;onLogout:()=>void;children:ReactNode}){
  let lastGroup=''
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><BrandMark/><strong>Учет магазина</strong></div><nav>
    {items.filter(i=>!i.admin||user.role==='admin').map(item=>{const group=item.group&&item.group!==lastGroup?item.group:'';if(item.group)lastGroup=item.group;const Icon=item.icon;return <div key={item.key}>{group&&<div className="nav-group">{group}</div>}<button className={page===item.key?'active':''} onClick={()=>onPage(item.key)}><Icon size={19}/><span>{item.label}</span>{page===item.key&&<ChevronLeft className="active-arrow" size={14}/>}</button></div>})}
  </nav><div className="sidebar-user"><div className="avatar"><UserRound/></div><div><b>{user.displayName}</b><span>{user.role==='admin'?'Администратор':'Продавец'}</span></div><button onClick={onLogout} title="Выйти"><LogOut size={18}/></button></div></aside><section className="main-content">{children}</section></div>
}
