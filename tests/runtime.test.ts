import { beforeAll, describe, expect, it } from 'vitest';
import { compile } from '../src/compiler';
import { generatePandas } from '../src/runtime/codegen';
import { candidateCodes, orderPositions } from '../src/runtime/plan';
import { AuroraRuntime } from '../src/runtime/runtime';
import { createNodeRuntime } from '../scripts/lib/nodeRuntime';

let rt: AuroraRuntime;
beforeAll(async () => {
  rt = await createNodeRuntime();
  rt.loadProfile('small_selective');
}, 180_000);

const EDGE_CASES: [string, string][] = [
  ['LIKE prefix (case-insensitive like SQLite)', "SELECT name FROM customers WHERE name LIKE 'customer 1%'"],
  ['LIKE with underscore', "SELECT city FROM customers WHERE city LIKE '_umbai'"],
  ['NOT LIKE', "SELECT product_name FROM products WHERE product_name NOT LIKE 'Product 1%'"],
  ['NOT IN + NOT (OR)', "SELECT customer_id FROM customers WHERE region NOT IN ('South', 'North') AND NOT (age < 30 OR age > 60)"],
  ['NOT BETWEEN', 'SELECT order_id FROM orders WHERE amount NOT BETWEEN 20 AND 200'],
  ['global aggregate over empty input (NULL semantics)', 'SELECT COUNT(*) AS n, SUM(amount) AS s, AVG(amount) AS a, MIN(order_date) AS d, MAX(amount) AS m FROM orders WHERE amount > 1000000'],
  ['group aggregate over empty input', 'SELECT region, COUNT(*) AS n FROM customers WHERE age > 1000 GROUP BY region'],
  ['SELECT * with ORDER BY tie-break', 'SELECT * FROM products WHERE price BETWEEN 10 AND 20 ORDER BY price, product_id'],
  ['multi-key ORDER BY mixed direction over a join', 'SELECT c.region AS region, COUNT(*) AS n FROM customers c JOIN orders o ON c.customer_id = o.customer_id GROUP BY c.region HAVING COUNT(*) > 100 ORDER BY n DESC, c.region ASC'],
  ['scalar-true predicate', 'SELECT COUNT(*) AS n FROM customers WHERE 1 = 1'],
  ['scalar-false predicate', 'SELECT name FROM customers WHERE 1 = 2'],
  ['string MIN/MAX', 'SELECT MIN(name) AS lo, MAX(email) AS hi FROM customers'],
  ['ORDER BY a non-selected column', 'SELECT name FROM customers WHERE age > 70 ORDER BY age DESC, customer_id'],
  ['negative and float literals', 'SELECT order_id FROM orders WHERE discount > 0.25 AND quantity > -1 AND amount <= 12.5'],
  ['date comparison', "SELECT order_id FROM orders WHERE order_date >= '2024-06-01' AND order_date < '2024-06-15'"],
  ['COUNT(col) and AVG over join with pushdown', "SELECT p.category, COUNT(o.order_id) AS n, AVG(o.amount) AS a FROM orders o JOIN products p ON o.product_id = p.product_id WHERE p.price > 30 GROUP BY p.category"],
  ['group key also aggregated', 'SELECT age, MAX(age) AS m, COUNT(*) AS n FROM customers GROUP BY age'],
  ['!= operator', "SELECT customer_id FROM customers WHERE region != 'South'"],
  ['quote escaping in string literal', "SELECT customer_id FROM customers WHERE name = 'O''Brien'"],
];

describe('every candidate plan is equivalent to SQLite on SQL edge cases', () => {
  it.each(EDGE_CASES)('%s', (_name, sql) => {
    const q = compile(sql);
    const report = rt.verify(candidateCodes(q), sql, orderPositions(q.bound));
    expect(report.reference_error).toBeNull();
    expect(Object.keys(report.results).length).toBe(q.candidates.length);
    for (const [id, r] of Object.entries(report.results)) {
      expect(r.equivalent, `${id}: ${r.reason}`).toBe(true);
    }
  });
});

describe('the equivalence checker rejects wrong plans', () => {
  const sql = "SELECT c.name, o.amount FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE c.region = 'South' ORDER BY o.amount DESC";

  it('detects a plan that drops the filter', () => {
    const q = compile(sql);
    const good = generatePandas(q.candidates[0].plan);
    const bad = good.replace(/\n.*# Filter\n/, '\n    v3 = v2  # (filter removed)\n');
    expect(bad).not.toEqual(good);
    const r = rt.verify({ good, bad }, sql, orderPositions(q.bound));
    expect(r.results.good.equivalent).toBe(true);
    expect(r.results.bad.equivalent).toBe(false);
  });

  it('detects a wrong sort direction', () => {
    const q = compile(sql);
    const good = generatePandas(q.candidates[0].plan);
    const bad = good.replace('ascending=[False]', 'ascending=[True]');
    expect(bad).not.toEqual(good);
    const r = rt.verify({ good, bad }, sql, orderPositions(q.bound));
    expect(r.results.good.equivalent).toBe(true);
    expect(r.results.bad.equivalent).toBe(false);
    expect(r.results.bad.reason).toContain('ORDER BY');
  });

  it('reports execution failures instead of throwing', () => {
    const q = compile(sql);
    const r = rt.verify({ boom: 'def run(T):\n    raise ValueError("x")\n' }, sql, orderPositions(q.bound));
    expect(r.results.boom.equivalent).toBe(false);
    expect(r.results.boom.reason).toContain('execution failed');
  });
});

describe('timing harness', () => {
  it('returns the requested number of repetitions per candidate and excludes warm-up', () => {
    const q = compile("SELECT name FROM customers WHERE region = 'South'");
    const out = rt.timeCandidates(candidateCodes(q), 2, 5);
    for (const t of Object.values(out)) {
      expect(t.error).toBeNull();
      expect(t.times_ms).toHaveLength(5);
      expect(t.times_ms.every((x) => x > 0)).toBe(true);
    }
  });

  it('isolates a failing candidate without affecting the others', () => {
    const out = rt.timeCandidates({ ok: 'def run(T):\n    return T["customers"]\n', bad: 'def run(T):\n    raise RuntimeError("no")\n' }, 1, 3);
    expect(out.ok.times_ms).toHaveLength(3);
    expect(out.bad.error).toContain('execute');
  });
});

describe('data profile', () => {
  it('is deterministic and reports exact statistics', () => {
    const a = rt.loadProfile('small_selective');
    const b = rt.loadProfile('small_selective');
    expect(a).toEqual(b);
    expect(a.tables.customers.rows).toBe(1000);
    expect(a.tables.orders.rows).toBe(5000);
    expect(a.tables.customers.columns.region.freq!.South).toBeCloseTo(0.05, 1);
    expect(rt.loadProfile('small_broad').tables.customers.columns.region.freq!.South).toBeCloseTo(0.4, 1);
  });
});
