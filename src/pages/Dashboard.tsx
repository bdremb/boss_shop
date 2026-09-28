import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Boxes, CircleDollarSign, CreditCard, PackageCheck, ReceiptRussianRuble, ShoppingBag, TrendingUp, WalletCards } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { call } from '../api'
import { Loader, PageHeader, PeriodPicker, Pill } from '../components'
import type { Period, User } from '../types'
import { money, number, percent, presetPeriod, shortChartDate } from '../utils'

type DashboardData={metrics:any;trend:any[];lowStock:any[];stock:{total:number;positions:number}}

export default function Dashboard({user,onNavigate}:{user:User;onNavigate:(page:any)=>void}){
  const [period,setPeriod]=useState<Period>(presetPeriod('month')),[data,setData]=useState<DashboardData|null>(null),[error,setError]=useState('')
  useEffect(()=>{setData(null);call<DashboardData>('dashboard',period).then(setData).catch(e=>setError(e.message))},[period])
  const admin=user.role==='admin'
  return <div className="page dashboard-page"><PageHeader eyebrow="Обзор бизнеса" title="Главная" subtitle="Самое важное — на одном экране" actions={<PeriodPicker value={period} onChange={setPeriod}/>}/>
    {error&&<div className="notice error">{error}</div>}{!data?<Loader/>:<>
      <div className={`metrics-grid ${admin?'admin':''}`}>
        <Metric icon={<CreditCard/>} label="Выручка" value={money(data.metrics.revenue)} tone="gold" />
        <Metric icon={<ShoppingBag/>} label="Продано" value={`${number(data.metrics.units)} шт.`} note={`${number(data.metrics.salesCount)} продаж`} tone="blue" />
        {admin&&<Metric icon={<PackageCheck/>} label="Себестоимость" value={money(data.metrics.cost)} tone="neutral"/>}
        {admin&&<Metric icon={<TrendingUp/>} label="Валовая прибыль" value={money(data.metrics.grossProfit)} note={`Маржа ${percent(data.metrics.margin)}`} tone="green"/>}
        {admin&&<Metric icon={<WalletCards/>} label="Расходы" value={money(data.metrics.expenses)} tone="red"/>}
        {admin&&<Metric icon={<CircleDollarSign/>} label="Чистая прибыль" value={money(data.metrics.netProfit)} note={data.metrics.netProfit>=0?'Положительный результат':'Требует внимания'} tone={data.metrics.netProfit>=0?'green':'red'}/>} 
      </div>
      <div className="dashboard-columns"><section className="panel chart-panel"><div className="panel-head"><div><span className="eyebrow">Динамика</span><h2>Выручка и прибыль</h2></div><Pill tone="blue">{period.label}</Pill></div>
        {data.trend.length?<ResponsiveContainer width="100%" height={310}><AreaChart data={data.trend} margin={{left:8,right:8,top:16,bottom:0}}><defs><linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#c9a45f" stopOpacity={.38}/><stop offset="100%" stopColor="#c9a45f" stopOpacity={.02}/></linearGradient></defs><CartesianGrid strokeDasharray="4 5" vertical={false} stroke="#e6e9eb"/><XAxis dataKey="day" tickFormatter={shortChartDate} tickLine={false} axisLine={false} fontSize={12}/><YAxis tickFormatter={v=>`${Math.round(v/100000)}к`} tickLine={false} axisLine={false} fontSize={12}/><Tooltip formatter={(v:any)=>money(Number(v))} labelFormatter={v=>shortChartDate(String(v))}/><Area type="monotone" dataKey="revenue" name="Выручка" stroke="#a97f34" strokeWidth={2.5} fill="url(#revenueFill)"/>{admin&&<Area type="monotone" dataKey={(x:any)=>x.revenue-x.cost} name="Валовая прибыль" stroke="#397662" strokeWidth={2} fill="transparent"/>}</AreaChart></ResponsiveContainer>:<div className="chart-empty">За период еще нет продаж</div>}
      </section><section className="panel stock-panel"><div className="panel-head"><div><span className="eyebrow">Контроль склада</span><h2>Низкий остаток</h2></div><button className="text-button" onClick={()=>onNavigate('products')}>Все товары</button></div>
        <div className="stock-overview"><div><Boxes/><span><b>{number(data.stock.total)}</b>единиц на складе</span></div><div><ReceiptRussianRuble/><span><b>{number(data.stock.positions)}</b>активных позиций</span></div></div>
        <div className="low-list">{data.lowStock.length?data.lowStock.map(item=><div key={item.variantId}><div className="product-dot"><AlertTriangle/></div><div><b>{item.name}</b><span>{item.article} · {item.size} · {item.color||'без цвета'}</span></div><Pill tone={item.quantity===0?'bad':'warn'}>{item.quantity===0?'Нет в наличии':`${item.quantity} шт.`}</Pill></div>):<div className="all-good"><PackageCheck/><span><b>Все в порядке</b>Критичных остатков нет</span></div>}</div>
      </section></div>
      {admin&&<div className="insight-strip"><div className="insight-icon"><ArrowUpRight/></div><div><span>Валовая прибыль за период</span><b>{money(data.metrics.grossProfit)}</b></div><div className="separator"/><div><span>После расходов</span><b>{money(data.metrics.netProfit)}</b></div><div className={`net-badge ${data.metrics.netProfit>=0?'positive':'negative'}`}>{data.metrics.netProfit>=0?<ArrowUpRight/>:<ArrowDownRight/>}{percent(data.metrics.revenue?data.metrics.netProfit/data.metrics.revenue*100:0)} от выручки</div></div>}
    </>}
  </div>
}

function Metric({icon,label,value,note,tone}:{icon:any;label:string;value:string;note?:string;tone:string}){return <section className={`metric ${tone}`}><div className="metric-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong>{note&&<small>{note}</small>}</div></section>}
