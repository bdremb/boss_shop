/// <reference types="vite/client" />

interface Window {
  bossShop: {
    invoke: (action: string, payload?: Record<string, unknown>) => Promise<{ ok: boolean; data?: any; error?: string }>
    exportFile: (format: 'excel' | 'csv' | 'pdf', title: string, rows: Record<string, unknown>[]) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  }
}
