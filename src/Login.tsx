import { useState } from 'react'
import { ArrowRight, LockKeyhole, PackageCheck, ShieldCheck, TrendingUp } from 'lucide-react'
import { login } from './api'
import { BrandMark, Button, Field, Input } from './components'

export default function Login({ onLogin }: { onLogin:()=>void }) {
  const [loginValue,setLogin]=useState('admin'),[password,setPassword]=useState('admin123'),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{await login(loginValue,password);onLogin()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  return <main className="login-page">
    <section className="login-story">
      <div className="brand light"><BrandMark/><strong>Учет магазина</strong></div>
      <div className="story-content"><span className="eyebrow">Учет магазина одежды</span><h1>Все цифры бизнеса<br/>в одном месте.</h1><p>Остатки, продажи, расходы и реальная чистая прибыль — спокойно и без лишних таблиц.</p>
        <div className="story-features"><div><PackageCheck/><span><b>Точный склад</b>Движение каждого товара</span></div><div><TrendingUp/><span><b>Живая аналитика</b>От дня до полного года</span></div><div><ShieldCheck/><span><b>Доступ по ролям</b>Финансы видит только владелец</span></div></div>
      </div><div className="story-foot">Локальная база данных · работает без интернета</div>
    </section>
    <section className="login-panel"><form onSubmit={submit}>
      <div className="login-icon"><LockKeyhole/></div><h2>Добро пожаловать</h2><p>Войдите, чтобы продолжить работу</p>
      <Field label="Логин"><Input autoFocus value={loginValue} onChange={e=>setLogin(e.target.value)} /></Field>
      <Field label="Пароль"><Input type="password" value={password} onChange={e=>setPassword(e.target.value)} /></Field>
      {error&&<div className="form-error">{error}</div>}
      <Button type="submit" disabled={busy}>{busy?'Проверяем…':'Войти'}<ArrowRight size={18}/></Button>
      <div className="login-hint"><b>Первый вход</b><span>Администратор: admin / admin123</span><span>Продавец: seller / seller123</span></div>
    </form></section>
  </main>
}
