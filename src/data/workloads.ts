/**
 * Benchmark workload: 32 query templates (16 original + 16 q-series) across the four families of Table 4.1 of the report.
 * The train/validation/test assignment is fixed here, before any measurement is taken, and is
 * done per query template (never per run) to prevent leakage.
 */

export type QueryFamily = 'filter-projection' | 'join-filter' | 'join-projection' | 'group-aggregate';
export type Split = 'train' | 'validation' | 'test';

export interface Workload {
  id: string;
  family: QueryFamily;
  split: Split;
  description: string;
  sql: string;
}

export const WORKLOADS: Workload[] = [
  {
    id: 'f1', family: 'filter-projection', split: 'train',
    description: 'Selective single-table filter with projection',
    sql: "SELECT customer_id, name, city FROM customers WHERE region = 'South' AND age > 30",
  },
  {
    id: 'f2', family: 'filter-projection', split: 'train',
    description: 'Filter, projection and descending sort on orders',
    sql: "SELECT order_id, amount, status FROM orders WHERE status = 'delivered' AND amount > 100 ORDER BY amount DESC",
  },
  {
    id: 'f3', family: 'filter-projection', split: 'validation',
    description: 'IN-list and range filter on products',
    sql: "SELECT product_id, product_name, price FROM products WHERE category IN ('Books', 'Toys') AND rating >= 3.5",
  },
  {
    id: 'j1', family: 'join-filter', split: 'train',
    description: 'Equality join with a filter on the customers side',
    sql: "SELECT c.name, o.amount FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE c.region = 'South'",
  },
  {
    id: 'j2', family: 'join-filter', split: 'test',
    description: 'Join with filters on both inputs',
    sql: "SELECT c.city, o.order_id, o.amount FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE o.status = 'delivered' AND c.segment = 'Corporate'",
  },
  {
    id: 'j3', family: 'join-filter', split: 'train',
    description: 'Orders-products join filtered on category and amount',
    sql: "SELECT o.order_id, p.product_name, o.amount FROM orders o JOIN products p ON o.product_id = p.product_id WHERE p.category = 'Electronics' AND o.amount > 50",
  },
  {
    id: 'j4', family: 'join-filter', split: 'validation',
    description: 'BETWEEN filter on customers and range filter on orders',
    sql: 'SELECT c.name, o.order_id, o.order_date FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE c.age BETWEEN 25 AND 35 AND o.quantity >= 5',
  },
  {
    id: 'j5', family: 'join-filter', split: 'train',
    description: 'Products-first join with sort on a joined column',
    sql: "SELECT p.brand, o.order_id, o.shipping_cost FROM products p JOIN orders o ON p.product_id = o.product_id WHERE p.rating > 4 AND o.channel = 'mobile' ORDER BY o.shipping_cost DESC",
  },
  {
    id: 'p1', family: 'join-projection', split: 'train',
    description: 'Wide-table join where projection pruning removes most columns',
    sql: 'SELECT c.name, c.email, o.order_date FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE o.discount > 0.2',
  },
  {
    id: 'p2', family: 'join-projection', split: 'test',
    description: 'Cross-table OR predicate that cannot be pushed down',
    sql: "SELECT c.region, o.channel, o.amount FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE o.status <> 'cancelled' OR c.age > 60",
  },
  {
    id: 'g1', family: 'group-aggregate', split: 'test',
    description: 'Join with GROUP BY and ORDER BY (example query)',
    sql: `SELECT c.region, SUM(o.amount) AS total_amount
FROM customers AS c
JOIN orders AS o ON c.customer_id = o.customer_id
WHERE c.region = 'South'
GROUP BY c.region
ORDER BY total_amount DESC`,
  },
  {
    id: 'g2', family: 'group-aggregate', split: 'train',
    description: 'Single-table aggregation with HAVING',
    sql: "SELECT channel, COUNT(*) AS orders_n, AVG(amount) AS avg_amount FROM orders WHERE status <> 'cancelled' GROUP BY channel HAVING COUNT(*) > 10 ORDER BY avg_amount DESC",
  },
  {
    id: 'g3', family: 'group-aggregate', split: 'train',
    description: 'Revenue by category over a join',
    sql: "SELECT p.category, SUM(o.amount) AS revenue, COUNT(*) AS n FROM orders o JOIN products p ON o.product_id = p.product_id WHERE o.status = 'delivered' GROUP BY p.category ORDER BY revenue DESC",
  },
  {
    id: 'g4', family: 'group-aggregate', split: 'test',
    description: 'Three-table join with two pushable filters',
    sql: `SELECT c.region, p.category, SUM(o.amount) AS revenue
FROM customers c
JOIN orders o ON c.customer_id = o.customer_id
JOIN products p ON o.product_id = p.product_id
WHERE c.segment = 'Enterprise' AND p.rating > 3
GROUP BY c.region, p.category
ORDER BY revenue DESC`,
  },
  {
    id: 'g5', family: 'group-aggregate', split: 'train',
    description: 'MAX per segment after filters on both inputs',
    sql: "SELECT c.segment, MAX(o.amount) AS max_amount FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE c.region = 'West' AND o.channel = 'web' GROUP BY c.segment",
  },
  {
    id: 'g6', family: 'group-aggregate', split: 'validation',
    description: 'City-level units with HAVING over a join',
    sql: 'SELECT c.city, COUNT(*) AS n, SUM(o.quantity) AS units FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE c.age >= 40 GROUP BY c.city HAVING SUM(o.quantity) > 100 ORDER BY units DESC',
  },
  // ---- Extended suite (q-series): 16 further templates added for the final evaluation. Splits are
  // fixed here before their measurement, per template, exactly like the original 16. ----
  { id: 'q1', family: 'filter-projection', split: 'train', description: 'Range filter with sort on customers',
    sql: "SELECT customer_id, city, loyalty_score FROM customers WHERE loyalty_score > 50 AND segment = 'Consumer' ORDER BY loyalty_score DESC" },
  { id: 'q2', family: 'filter-projection', split: 'test', description: 'Conjunctive filter on orders with sort',
    sql: "SELECT order_id, amount, discount FROM orders WHERE channel = 'web' AND discount > 0.1 AND quantity >= 3 ORDER BY discount DESC" },
  { id: 'q3', family: 'filter-projection', split: 'train', description: 'Brand filter with price range on products',
    sql: "SELECT product_name, brand, price FROM products WHERE price BETWEEN 20 AND 200 AND stock > 10" },
  { id: 'q4', family: 'join-filter', split: 'train', description: 'Products-orders join with filters on both sides',
    sql: "SELECT p.product_name, o.amount FROM products p JOIN orders o ON p.product_id = o.product_id WHERE p.category = 'Toys' AND o.status = 'delivered'" },
  { id: 'q5', family: 'join-filter', split: 'test', description: 'Customers-orders join with range filter on the larger side',
    sql: "SELECT c.city, o.amount FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE o.amount > 200 AND c.region = 'North'" },
  { id: 'q6', family: 'join-filter', split: 'validation', description: 'Highly selective join input with IN-list',
    sql: "SELECT c.name, o.order_id FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE c.segment IN ('Enterprise', 'Corporate') AND o.channel = 'store'" },
  { id: 'q7', family: 'join-filter', split: 'train', description: 'Join with sort on a pushed column',
    sql: "SELECT p.brand, o.amount, o.order_date FROM orders o JOIN products p ON o.product_id = p.product_id WHERE o.discount > 0.15 ORDER BY o.amount DESC" },
  { id: 'q8', family: 'join-projection', split: 'test', description: 'Wide-table join with projection of two columns',
    sql: "SELECT c.email, o.shipping_cost FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE o.quantity > 4" },
  { id: 'q9', family: 'join-projection', split: 'train', description: 'Join over products with OR predicate in one table',
    sql: "SELECT p.category, o.channel, o.amount FROM products p JOIN orders o ON p.product_id = o.product_id WHERE p.rating > 4.2 OR p.stock < 20" },
  { id: 'q10', family: 'join-projection', split: 'validation', description: 'Three-table join, projection only',
    sql: "SELECT c.region, p.brand, o.amount FROM customers c JOIN orders o ON c.customer_id = o.customer_id JOIN products p ON o.product_id = p.product_id WHERE o.status = 'shipped'" },
  { id: 'q11', family: 'group-aggregate', split: 'train', description: 'Group by status on orders',
    sql: "SELECT status, COUNT(*) AS n, SUM(amount) AS total FROM orders WHERE amount > 20 GROUP BY status ORDER BY total DESC" },
  { id: 'q12', family: 'group-aggregate', split: 'test', description: 'Average per region over a filtered join',
    sql: "SELECT c.region, AVG(o.amount) AS avg_amount FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE o.status = 'delivered' AND c.age > 30 GROUP BY c.region ORDER BY avg_amount DESC" },
  { id: 'q13', family: 'group-aggregate', split: 'train', description: 'Per-brand minimum price with HAVING',
    sql: "SELECT p.brand, MIN(o.amount) AS min_amount, COUNT(*) AS n FROM products p JOIN orders o ON p.product_id = o.product_id WHERE p.category = 'Books' GROUP BY p.brand HAVING COUNT(*) > 5" },
  { id: 'q14', family: 'group-aggregate', split: 'test', description: 'Three-table aggregation with filters on all three tables',
    sql: "SELECT c.segment, p.category, SUM(o.quantity) AS units FROM customers c JOIN orders o ON c.customer_id = o.customer_id JOIN products p ON o.product_id = p.product_id WHERE c.region = 'East' AND p.rating > 3.5 AND o.status = 'delivered' GROUP BY c.segment, p.category ORDER BY units DESC" },
  { id: 'q15', family: 'group-aggregate', split: 'validation', description: 'Channel revenue with join and city filter',
    sql: "SELECT o.channel, SUM(o.amount) AS revenue FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE c.age BETWEEN 30 AND 50 GROUP BY o.channel" },
  { id: 'q16', family: 'group-aggregate', split: 'test', description: 'Max shipping per category after a pushable filter',
    sql: "SELECT p.category, MAX(o.shipping_cost) AS max_ship FROM orders o JOIN products p ON o.product_id = p.product_id WHERE o.channel = 'mobile' AND p.price > 50 GROUP BY p.category ORDER BY max_ship DESC" },
];

export const PROFILE_IDS = [
  'small_selective', 'small_broad', 'medium_selective', 'medium_broad', 'large_selective', 'large_broad',
] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];
