export const FONT_SCALES = [
  { value: 0.9, label: 'Мелкий', hint: '90%' },
  { value: 1, label: 'Обычный', hint: '100%' },
  { value: 1.15, label: 'Крупный', hint: '115%' },
  { value: 1.3, label: 'Очень крупный', hint: '130%' }
] as const

const STORAGE_KEY = 'boss-shop-font-scale'

export function readFontScale() {
  const value = Number(localStorage.getItem(STORAGE_KEY))
  return FONT_SCALES.some(item => item.value === value) ? value : 1
}

export function applyFontScale(value: number) {
  const allowed = FONT_SCALES.find(item => item.value === value)?.value ?? 1
  localStorage.setItem(STORAGE_KEY, String(allowed))
  window.bossShop?.setFontScale(allowed)
  return allowed
}
