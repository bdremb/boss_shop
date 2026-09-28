export type User = { id: number; login: string; displayName: string; role: 'admin' | 'seller' }
export type Lookup = { id: number; name: string; [key: string]: unknown }
export type Catalogs = {
  user: User
  categories: Lookup[]
  subcategories: (Lookup & { categoryId: number })[]
  sizes: Lookup[]
  suppliers: Lookup[]
  employees: Lookup[]
  expenseCategories: (Lookup & { groupName: string })[]
}
export type Product = {
  variantId: number; productId: number; article: string; name: string; brand: string; categoryId?: number; category?: string
  subcategoryId?: number; subcategory?: string; supplierId?: number; supplier?: string; sizeId?: number; size: string; color: string
  quantity: number; purchasePrice?: number; retailPrice: number; barcode?: string; arrivalDate?: string; note?: string; lowStockThreshold: number
}
export type Period = { from: string; to: string; label?: string }
