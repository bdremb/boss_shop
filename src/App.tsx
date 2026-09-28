import { useCallback, useEffect, useState } from 'react'
import { call, hasToken, logout } from './api'
import Layout, { type PageKey } from './Layout'
import Login from './Login'
import { Loader } from './components'
import type { Catalogs, User } from './types'
import Dashboard from './pages/Dashboard'
import Products from './pages/Products'
import { Receipts, Returns, Sales, Writeoffs } from './pages/Operations'
import Expenses from './pages/Expenses'
import { Analytics, ProfitLoss } from './pages/Reports'
import History from './pages/History'
import Settings from './pages/Settings'

export default function App(){
  const [user,setUser]=useState<User|null>(null),[catalogs,setCatalogs]=useState<Catalogs|null>(null),[page,setPage]=useState<PageKey>('dashboard'),[loading,setLoading]=useState(hasToken())
  const bootstrap=useCallback(async()=>{setLoading(true);try{const data=await call<Catalogs>('bootstrap');setUser(data.user);setCatalogs(data)}catch{sessionStorage.removeItem('boss-shop-token');setUser(null);setCatalogs(null)}finally{setLoading(false)}},[])
  useEffect(()=>{if(hasToken())bootstrap()},[bootstrap])
  async function signOut(){await logout();setUser(null);setCatalogs(null);setPage('dashboard')}
  if(loading)return <div className="splash"><div className="brand light"><span>B</span><strong>Boss Shop</strong></div><Loader/></div>
  if(!user||!catalogs)return <Login onLogin={bootstrap}/>
  const pages:Record<PageKey,React.ReactNode>={dashboard:<Dashboard user={user} onNavigate={setPage}/>,products:<Products user={user} catalogs={catalogs} refreshCatalogs={bootstrap}/>,receipts:<Receipts catalogs={catalogs}/>,sales:<Sales catalogs={catalogs}/>,returns:<Returns/>,writeoffs:<Writeoffs/>,expenses:<Expenses catalogs={catalogs}/>,reports:<Analytics/>,profit:<ProfitLoss/>,history:<History/>,settings:<Settings catalogs={catalogs} refresh={bootstrap}/>}
  return <Layout user={user} page={page} onPage={setPage} onLogout={signOut}>{pages[page]}</Layout>
}
