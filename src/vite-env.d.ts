/// <reference types="vite/client" />

interface Window {
  bossShop: {
    selectProductPhoto: (token: string) => Promise<{ok:boolean; data?:string; canceled?:boolean; error?:string}>
    invoke: (action: string, payload?: Record<string, unknown>) => Promise<{ ok: boolean; data?: any; error?: string }>
    exportFile: (format: 'excel' | 'csv' | 'pdf', title: string, rows: Record<string, unknown>[]) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
    backupDatabase: (token: string) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
    restoreDatabase: (token: string) => Promise<{ ok: boolean; safetyPath?: string; canceled?: boolean; error?: string }>
    selectProductImport: (token: string) => Promise<{ ok: boolean; importId?: string; fileName?: string; sheetCount?: number; sourceRows?: number; skippedRows?: number; skipped?: ProductImportIssue[]; warnings?: string[]; positions?: number; preview?: ProductImportRow[]; canceled?: boolean; error?: string }>
    commitProductImport: (token: string, importId: string, options: { priceMode: 'retail'|'purchase'|'both'; stockMode: 'set'|'add'|'keep' }) => Promise<{ ok: boolean; data?: ProductImportResult; error?: string }>
    setFontScale: (factor: number) => void
  }
}

interface ProductImportRow {
  article: string
  name: string
  category: string
  size: string
  color: string
  priceCents: number
  purchasePriceCents: number
  purchaseTotalCents: number
  quantity: number
  sourceSheet: string
}

interface ProductImportIssue { sheet: string; row: number; name: string; reason: string }

interface ProductImportResult {
  products: number
  createdProducts: number
  createdVariants: number
  updatedVariants: number
  unitsChanged: number
}
