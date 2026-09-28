let token = sessionStorage.getItem('boss-shop-token') || ''

export async function call<T = any>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await window.bossShop.invoke(action, { ...payload, _token: token })
  if (!response.ok) throw new Error(response.error || 'Ошибка операции')
  return response.data as T
}

export async function login(loginValue: string, password: string) {
  const result = await call<{ token: string; user: any }>('login', { login: loginValue, password })
  token = result.token
  sessionStorage.setItem('boss-shop-token', token)
  return result
}

export async function logout() {
  try { await call('logout') } finally { token = ''; sessionStorage.removeItem('boss-shop-token') }
}

export async function exportRows(format: 'excel' | 'csv' | 'pdf', title: string, rows: Record<string, unknown>[]) {
  const result = await window.bossShop.exportFile(format, title, rows)
  if (!result.ok) throw new Error(result.error || 'Не удалось сохранить файл')
  return result
}

export const hasToken = () => Boolean(token)
