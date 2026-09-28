import { endOfMonth, endOfQuarter, endOfWeek, endOfYear, format, startOfMonth, startOfQuarter, startOfWeek, startOfYear, subDays } from 'date-fns'
import { ru } from 'date-fns/locale'
import type { Period } from './types'

export const money = (cents: number | null | undefined) => cents == null ? '—' : new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(cents / 100)
export const number = (value: number | null | undefined) => new Intl.NumberFormat('ru-RU').format(value || 0)
export const percent = (value: number | null | undefined) => value == null ? '—' : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value)}%`
export const rubles = (cents: number | null | undefined) => cents ? String(cents / 100) : ''
export const toCents = (value: string | number) => Math.round(Number(String(value).replace(',', '.')) * 100) || 0
export const today = () => format(new Date(), 'yyyy-MM-dd')
export const dateTimeLocal = () => format(new Date(), "yyyy-MM-dd'T'HH:mm")
export const displayDate = (value?: string) => value ? format(new Date(value.replace(' ', 'T')), 'dd.MM.yyyy HH:mm') : '—'
export const displayDay = (value?: string) => value ? format(new Date(value), 'dd.MM.yyyy') : '—'

export function presetPeriod(key: string): Period {
  const now = new Date()
  const map: Record<string, [Date, Date, string]> = {
    day: [now, now, 'Сегодня'],
    week: [startOfWeek(now, { weekStartsOn: 1 }), endOfWeek(now, { weekStartsOn: 1 }), 'Неделя'],
    month: [startOfMonth(now), endOfMonth(now), 'Месяц'],
    quarter: [startOfQuarter(now), endOfQuarter(now), 'Квартал'],
    year: [startOfYear(now), endOfYear(now), 'Год'],
    days30: [subDays(now, 29), now, '30 дней']
  }
  const p = map[key] || map.month
  return { from: format(p[0], 'yyyy-MM-dd'), to: format(p[1], 'yyyy-MM-dd'), label: p[2] }
}

export const shortChartDate = (value: string) => format(new Date(value), 'd MMM', { locale: ru })
