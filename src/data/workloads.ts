/**
 * Benchmark workload: 16 query templates across the four families of Table 4.1 of the report.
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
    description: 'Report Appendix C example',
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
];

export const PROFILE_IDS = [
  'small_selective', 'small_broad', 'medium_selective', 'medium_broad', 'large_selective', 'large_broad',
] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];
