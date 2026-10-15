export type ColType = 'int' | 'float' | 'string' | 'date';

export interface ColumnSchema { name: string; type: ColType }
export interface TableSchema { name: string; columns: ColumnSchema[] }
export type Catalog = Record<string, TableSchema>;

export const isNumeric = (t: ColType) => t === 'int' || t === 'float';
/** Strings and ISO-8601 date strings compare lexicographically, so they are mutually comparable. */
export const isTextual = (t: ColType) => t === 'string' || t === 'date';

/**
 * Schema of the e-commerce benchmark database. The matching data is generated deterministically by
 * `python/aurora_runtime.py::generate_database` and is the same in the browser and in Node.
 * All columns are NULL-free (documented assumption of the SQL subset).
 */
export const ECOMMERCE_CATALOG: Catalog = {
  customers: {
    name: 'customers',
    columns: [
      { name: 'customer_id', type: 'int' },
      { name: 'name', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'region', type: 'string' },
      { name: 'segment', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'age', type: 'int' },
      { name: 'signup_date', type: 'date' },
      { name: 'loyalty_score', type: 'float' },
    ],
  },
  orders: {
    name: 'orders',
    columns: [
      { name: 'order_id', type: 'int' },
      { name: 'customer_id', type: 'int' },
      { name: 'product_id', type: 'int' },
      { name: 'amount', type: 'float' },
      { name: 'quantity', type: 'int' },
      { name: 'status', type: 'string' },
      { name: 'order_date', type: 'date' },
      { name: 'channel', type: 'string' },
      { name: 'discount', type: 'float' },
      { name: 'shipping_cost', type: 'float' },
    ],
  },
  products: {
    name: 'products',
    columns: [
      { name: 'product_id', type: 'int' },
      { name: 'product_name', type: 'string' },
      { name: 'category', type: 'string' },
      { name: 'brand', type: 'string' },
      { name: 'price', type: 'float' },
      { name: 'stock', type: 'int' },
      { name: 'rating', type: 'float' },
    ],
  },
};
