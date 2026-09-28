import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useEffect } from 'react'
import { CalendarDays, ChevronDown, Download, Search, X } from 'lucide-react'
import type { Period } from './types'
import { presetPeriod } from './utils'

export function Button({ variant = 'primary', icon, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary'|'ghost'|'danger'|'soft'; icon?: ReactNode }) {
  return <button className={`button ${variant}`} {...props}>{icon}{children}</button>
}

export function Field({ label, hint, children, className='' }: { label?: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`}>{label && <span className="field-label">{label}</span>}{children}{hint && <span className="field-hint">{hint}</span>}</label>
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input className="input" {...props}/> }

export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) { return <div className="select-wrap"><select className="input select" {...props}>{children}</select><ChevronDown size={15}/></div> }

export function SearchInput(props: InputHTMLAttributes<HTMLInputElement>) { return <div className="search-input"><Search size={17}/><input {...props}/>{props.value && <X size={15} className="clear" onClick={() => props.onChange?.({ target: { value: '' } } as any)}/>}</div> }

export function Modal({ open, title, subtitle, onClose, children, wide=false }: { open: boolean; title: string; subtitle?: string; onClose:()=>void; children:ReactNode; wide?:boolean }) {
  useEffect(()=>{const f=(e:KeyboardEvent)=>e.key==='Escape'&&onClose();if(open)window.addEventListener('keydown',f);return()=>window.removeEventListener('keydown',f)},[open,onClose])
  if(!open)return null
  return <div className="modal-layer" onMouseDown={e=>e.currentTarget===e.target&&onClose()}><section className={`modal ${wide?'wide':''}`}>
    <header><div><h2>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose}><X/></button></header>{children}
  </section></div>
}

export function PeriodPicker({ value, onChange }: { value: Period; onChange:(p:Period)=>void }) {
  return <div className="period-picker">
    <div className="period-presets">{[['day','День'],['week','Неделя'],['month','Месяц'],['quarter','Квартал'],['year','Год']].map(([k,l])=><button key={k} className={value.label===presetPeriod(k).label?'active':''} onClick={()=>onChange(presetPeriod(k))}>{l}</button>)}</div>
    <div className="date-range"><CalendarDays size={16}/><input type="date" value={value.from} onChange={e=>onChange({...value,from:e.target.value,label:'Период'})}/><span>—</span><input type="date" value={value.to} onChange={e=>onChange({...value,to:e.target.value,label:'Период'})}/></div>
  </div>
}

export function Empty({ title='Здесь пока пусто', text='Добавьте первую запись, чтобы начать работу.' }: { title?:string;text?:string }) { return <div className="empty"><div className="empty-mark">B</div><h3>{title}</h3><p>{text}</p></div> }
export function Loader() { return <div className="loader"><span/><span/><span/></div> }
export function Pill({ children, tone='neutral' }: {children:ReactNode;tone?:'good'|'warn'|'bad'|'neutral'|'blue'}) { return <span className={`pill ${tone}`}>{children}</span> }
export function PageHeader({ eyebrow, title, subtitle, actions }: {eyebrow?:string;title:string;subtitle?:string;actions?:ReactNode}) { return <div className="page-header"><div>{eyebrow&&<span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{subtitle&&<p>{subtitle}</p>}</div><div className="page-actions">{actions}</div></div> }

export function ExportMenu({ onExport }: { onExport:(format:'excel'|'csv'|'pdf')=>void }) {
  return <div className="export-menu"><Download size={16}/><span>Экспорт</span><select aria-label="Экспорт" defaultValue="" onChange={e=>{if(e.target.value){onExport(e.target.value as any);e.target.value=''}}}><option value="" disabled>Формат</option><option value="excel">Excel</option><option value="csv">CSV</option><option value="pdf">PDF</option></select></div>
}
