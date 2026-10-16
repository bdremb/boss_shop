import { useEffect, useState, type ReactNode } from 'react'
import { Check, Pencil, X } from 'lucide-react'

export function InlineField({label,value,display,options,hint,editable,active,onActivate,onClose,onCommit}:{label:string;value:string;display:ReactNode;options?:{value:string;label:string}[];hint?:string;editable:boolean;active:boolean;onActivate:()=>void;onClose:()=>void;onCommit:(value:string)=>Promise<void>}){
  const [draft,setDraft]=useState(value),[busy,setBusy]=useState(false),[localError,setLocalError]=useState('')
  useEffect(()=>{if(active){setDraft(value);setLocalError('')}},[active])
  if(!editable)return <span className="quick-value-static">{display}</span>
  if(!active)return <button type="button" className="quick-value" onClick={onActivate} title={`Изменить: ${label}${hint?` — ${hint}`:''}`} aria-label={`Изменить: ${label}`}>{display}<Pencil size={12} className="quick-pencil"/></button>
  async function save(event:React.FormEvent){event.preventDefault();if(busy)return;setBusy(true);setLocalError('');try{if(draft!==value)await onCommit(draft);onClose()}catch(error){setLocalError((error as Error).message)}finally{setBusy(false)}}
  const numeric=label==='Закупочная цена'||label==='Розничная цена'||label==='Остаток'||label==='Порог низкого остатка'
  return <form className="quick-editor" onSubmit={save} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();onClose()}}}>
    {(hint||label==='Закупочная цена')&&<span className="quick-editor-hint">{hint}{label==='Закупочная цена'&&' Цена вручную переоценивает весь текущий остаток. Новые поставки учитывайте через поступление.'}</span>}
    <div className="quick-editor-line">{options?<select aria-label={label} autoFocus value={draft} onChange={event=>setDraft(event.target.value)} disabled={busy}>{options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>:<input aria-label={label} autoFocus type={label.startsWith('Дата')?'date':numeric?'number':'text'} min={numeric?'0':undefined} step={numeric?(label==='Остаток'||label==='Порог низкого остатка'?'1':'0.01'):undefined} value={draft} onChange={event=>setDraft(event.target.value)} disabled={busy}/>}
      <button type="submit" title="Сохранить" aria-label="Сохранить" disabled={busy}><Check size={15}/></button><button type="button" title="Отменить" aria-label="Отменить" onClick={onClose} disabled={busy}><X size={15}/></button>
    </div>{localError&&<span className="quick-editor-error" role="alert">{localError}</span>}
  </form>
}
