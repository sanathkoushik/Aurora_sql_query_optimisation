import { describe, expect, it } from 'vitest';
import { CompileError, compile, exprToString, parse, planSignature, tokenize, tryCompile, walk } from '../src/compiler';

const Q_EXAMPLE = `SELECT c.region, SUM(o.amount) AS total_amount
FROM customers AS c
JOIN orders AS o ON c.customer_id = o.customer_id
WHERE c.region = 'South'
GROUP BY c.region
ORDER BY total_amount DESC;`;

const diagOf = (sql: string) => {
  try { compile(sql); } catch (e) { if (e instanceof CompileError) return e.diagnostics[0]; throw e; }
  throw new Error('expected a compile error');
};

describe('lexer (DFA)', () => {
  it('tokenizes keywords case-insensitively', () => {
    const { tokens, diagnostics } = tokenize('select Region from Customers');
    expect(diagnostics).toEqual([]);
    expect(tokens.map((t) => [t.type, t.text])).toEqual([
      ['KEYWORD', 'SELECT'], ['IDENT', 'Region'], ['KEYWORD', 'FROM'], ['IDENT', 'Customers'], ['EOF', '<EOF>'],
    ]);
  });

  it('handles numbers, strings with escaped quotes and operators by maximal munch', () => {
    const { tokens, diagnostics } = tokenize("a<=10 AND b<>2.5 OR c!=3 AND d>=1 AND e='it''s' -- trailing\n/* block */ AND f<1");
    expect(diagnostics).toEqual([]);
    const texts = tokens.map((t) => t.text);
    expect(texts).toContain('<=');
    expect(texts).toContain('<>');
    expect(texts).toContain('!=');
    expect(texts).toContain('>=');
    expect(texts).toContain("it's");
    expect(tokens.find((t) => t.text === '2.5')?.isFloat).toBe(true);
    expect(texts).not.toContain('trailing');
    expect(texts).not.toContain('block');
  });

  it('tracks line and column positions', () => {
    const { tokens } = tokenize('SELECT\n  x');
    const x = tokens.find((t) => t.text === 'x')!;
    expect(x.pos).toMatchObject({ line: 2, col: 3 });
  });

  it('reports invalid symbols with position', () => {
    const { diagnostics } = tokenize('SELECT a # b');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ stage: 'lexical' });
    expect(diagnostics[0].message).toContain("'#'");
    expect(diagnostics[0].pos).toMatchObject({ line: 1, col: 10 });
  });

  it('reports unterminated strings and block comments', () => {
    expect(tokenize("WHERE a = 'oops").diagnostics[0].message).toContain('Unterminated string');
    expect(tokenize('SELECT /* never closed').diagnostics[0].message).toContain('Unterminated block comment');
  });

  it('a lone "!" or "." is not silently accepted as an operator', () => {
    expect(tokenize('a ! b').diagnostics).toHaveLength(1);
  });
});

describe('parser', () => {
  it('parses the report example (Appendix C)', () => {
    const { ast } = parse(Q_EXAMPLE);
    expect(ast.items).toHaveLength(2);
    expect(ast.from).toMatchObject({ name: 'customers', alias: 'c' });
    expect(ast.joins).toHaveLength(1);
    expect(ast.groupBy).toHaveLength(1);
    expect(ast.orderBy[0].desc).toBe(true);
    expect(exprToString(ast.where!)).toBe("c.region = 'South'");
  });

  it('respects precedence: AND binds tighter than OR; parentheses override', () => {
    const a = parse("SELECT a FROM t WHERE x = 1 OR y = 2 AND z = 3").ast;
    expect(exprToString(a.where!)).toBe('(x = 1 OR (y = 2 AND z = 3))');
    const b = parse("SELECT a FROM t WHERE (x = 1 OR y = 2) AND z = 3").ast;
    expect(exprToString(b.where!)).toBe('((x = 1 OR y = 2) AND z = 3)');
  });

  it('parses BETWEEN / IN / LIKE / NOT / negative numbers', () => {
    const { ast } = parse("SELECT a FROM t WHERE a BETWEEN -5 AND 10 AND NOT b IN (1, 2) AND c NOT LIKE 'x%'");
    expect(exprToString(ast.where!)).toBe("((a BETWEEN -5 AND 10 AND NOT b IN (1, 2)) AND c NOT LIKE 'x%')");
  });

  it('parses SELECT *, COUNT(*), HAVING and ORDER BY direction', () => {
    expect(parse('SELECT * FROM customers').ast.star).toBe(true);
    const { ast } = parse('SELECT region, COUNT(*) n FROM customers GROUP BY region HAVING COUNT(*) > 3 ORDER BY n ASC, region DESC');
    expect(ast.items[1].alias).toBe('n');
    expect(ast.orderBy.map((o) => o.desc)).toEqual([false, true]);
  });

  it.each([
    ['SELECT a FROM t LEFT JOIN u ON t.a = u.a', 'LEFT is not supported'],
    ['SELECT DISTINCT a FROM t', 'DISTINCT is not supported'],
    ['SELECT a FROM t LIMIT 5', 'LIMIT is not supported'],
    ['SELECT a FROM t WHERE a IN (SELECT b FROM u)', 'Subqueries are not supported'],
    ['SELECT a FROM t WHERE a IS NULL', 'IS'],
    ['SELECT a FROM t, u', 'Comma joins'],
    ['SELECT SUM(*) FROM t', 'SUM(*) is not valid'],
    ['SELECT a FROM', 'Expected a table name'],
    ['SELECT a t', "Expected FROM"],
    ['SELECT a FROM t WHERE', 'Expected a column'],
    ['SELECT a FROM t WHERE a', 'Expected a comparison operator'],
    ['SELECT a FROM t GROUP a', 'Expected BY'],
    ['SELECT a FROM t extra junk', 'Unexpected'],
  ])('rejects unsupported/invalid syntax: %s', (sql, fragment) => {
    let err: CompileError | undefined;
    try { parse(sql); } catch (e) { err = e as CompileError; }
    expect(err).toBeInstanceOf(CompileError);
    expect(err!.diagnostics[0].stage).toBe('syntax');
    expect(err!.diagnostics[0].message).toContain(fragment);
  });

  it('lexical errors surface before parsing', () => {
    expect(() => parse('SELECT a FROM t WHERE a = $')).toThrow(CompileError);
  });
});

describe('semantic analysis', () => {
  it('binds the example and reports the output schema', () => {
    const { bound } = compile(Q_EXAMPLE);
    expect(bound.isAggregate).toBe(true);
    expect(bound.groupBy).toEqual(['c.region']);
    expect(bound.outputs.map((o) => o.as)).toEqual(['region', 'total_amount']);
    expect(bound.aggs).toHaveLength(1);
    expect(bound.joins[0].keys).toEqual([{ l: 'c.customer_id', r: 'o.customer_id' }]);
  });

  it('orients join keys regardless of how ON is written', () => {
    const { bound } = compile('SELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.customer_id');
    expect(bound.joins[0].keys).toEqual([{ l: 'c.customer_id', r: 'o.customer_id' }]);
  });

  it('deduplicates identical aggregates across SELECT/HAVING/ORDER BY', () => {
    const { bound } = compile('SELECT region, SUM(age) s FROM customers GROUP BY region HAVING SUM(age) > 10 ORDER BY SUM(age)');
    expect(bound.aggs).toHaveLength(1);
  });

  it.each([
    ['SELECT x FROM nope', "Unknown table 'nope'"],
    ['SELECT custmer_id FROM customers', "Unknown column 'custmer_id'. Did you mean 'customer_id'?"],
    ['SELECT customer_id FROM customers c JOIN orders o ON c.customer_id = o.customer_id', "Ambiguous column 'customer_id'"],
    ['SELECT z.name FROM customers c', "Unknown table or alias 'z'"],
    ['SELECT c.nope FROM customers c', "has no column 'nope'"],
    ["SELECT name FROM customers WHERE age = 'x'", 'Type mismatch'],
    ["SELECT name FROM customers WHERE region = 5", 'Type mismatch'],
    ["SELECT name FROM customers WHERE age LIKE '5%'", 'LIKE requires a text column'],
    ['SELECT SUM(region) FROM customers', 'SUM requires a numeric column'],
    ['SELECT name, COUNT(*) FROM customers', 'must appear in GROUP BY'],
    ['SELECT region FROM customers GROUP BY region HAVING age > 3', 'HAVING column'],
    ['SELECT name FROM customers HAVING age > 3', 'HAVING requires'],
    ['SELECT name FROM customers WHERE SUM(age) > 3', 'not allowed in WHERE'],
    ['SELECT * FROM customers c JOIN orders o ON c.customer_id = o.customer_id', 'duplicate column name'],
    ['SELECT * FROM customers GROUP BY region', 'SELECT *'],
    ['SELECT name, name FROM customers', 'Duplicate output column name'],
    ['SELECT c.name FROM customers c JOIN orders c ON c.customer_id = c.customer_id', 'Duplicate table alias'],
    ['SELECT c.name FROM customers c JOIN orders o ON c.age > o.amount', 'Only equality joins'],
    ['SELECT c.name FROM customers c JOIN orders o ON c.customer_id = o.status', 'incompatible types'],
    ['SELECT c.name FROM customers c JOIN orders o ON c.customer_id = c.age', 'newly joined table'],
    ['SELECT region, COUNT(*) FROM customers GROUP BY region ORDER BY age', 'ORDER BY column'],
  ])('rejects: %s', (sql, fragment) => {
    const d = diagOf(sql);
    expect(d.stage).toBe('semantic');
    expect(d.message).toContain(fragment);
  });

  it('accepts date/string comparisons and numeric widening', () => {
    expect(() => compile("SELECT order_id FROM orders WHERE order_date >= '2024-01-01' AND amount > 10 AND quantity < 5.5")).not.toThrow();
  });

  it('allows ORDER BY on a non-selected column for non-aggregate queries', () => {
    expect(() => compile('SELECT name FROM customers ORDER BY age DESC')).not.toThrow();
  });
});

describe('candidate generation', () => {
  it('produces several distinct, valid candidates for the report example', () => {
    const { candidates } = compile(Q_EXAMPLE);
    expect(candidates.length).toBeGreaterThan(3);
    expect(candidates.every((c) => c.validity.valid)).toBe(true);
    expect(new Set(candidates.map((c) => c.signature)).size).toBe(candidates.length);
    expect(candidates[0].transformations).toEqual(['None (canonical plan)']);
    expect(candidates.map((c) => c.id)).toEqual(candidates.map((_, i) => `P${i + 1}`));
  });

  it('predicate pushdown moves the single-table filter below the join', () => {
    const { candidates } = compile(Q_EXAMPLE);
    const pushed = candidates.find((c) => c.options.pushdown && c.options.prune === 'none' && !c.options.swap)!;
    const filterAboveScan = (n: any): boolean => n.op === 'Filter' && n.child.op === 'Scan';
    let found = false;
    walk(pushed.plan, (n) => { if (filterAboveScan(n)) found = true; });
    expect(found).toBe(true);
    const base = candidates[0].plan;
    let filterAboveJoin = false;
    walk(base, (n) => { if (n.op === 'Filter' && n.child.op === 'Join') filterAboveJoin = true; });
    expect(filterAboveJoin).toBe(true);
  });

  it('does not push OR predicates or cross-table predicates below the join', () => {
    const { candidates } = compile("SELECT c.name FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE c.age > o.quantity AND (c.region = 'South' OR o.status = 'shipped')");
    // Nothing is pushable, so pushdown variants collapse into the same plans and are de-duplicated.
    expect(candidates.some((c) => c.options.pushdown)).toBe(false);
    for (const c of candidates) {
      walk(c.plan, (n) => { expect(n.op === 'Filter' && n.child.op === 'Scan').toBe(false); });
    }
  });

  it('pruning removes unused columns before the join', () => {
    const { candidates } = compile('SELECT c.name, o.amount FROM customers c JOIN orders o ON c.customer_id = o.customer_id');
    const pruned = candidates.find((c) => c.options.prune === 'early' && !c.options.swap)!;
    const join = (() => { let j: any; walk(pruned.plan, (n) => { if (n.op === 'Join') j = n; }); return j; })();
    expect(join.left.schema.sort()).toEqual(['c.customer_id', 'c.name']);
    expect(join.right.schema.sort()).toEqual(['o.amount', 'o.customer_id']);
  });

  it('single-table queries still yield multiple candidates through pruning', () => {
    const { candidates } = compile("SELECT name, age FROM customers WHERE region = 'South'");
    expect(candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('three-table joins generate reordered plans and stay connected', () => {
    const { candidates } = compile(`SELECT c.region, p.category, SUM(o.amount) AS rev
      FROM customers c JOIN orders o ON c.customer_id = o.customer_id
      JOIN products p ON o.product_id = p.product_id WHERE p.category = 'Books' GROUP BY c.region, p.category`);
    expect(candidates.some((c) => c.options.reorder)).toBe(true);
    expect(candidates.every((c) => c.validity.valid)).toBe(true);
    for (const c of candidates) {
      const scans: string[] = [];
      walk(c.plan, (n) => { if (n.op === 'Scan') scans.push(n.alias); });
      expect(scans.sort()).toEqual(['c', 'o', 'p']);
    }
  });

  it('non-aggregate query with ORDER BY keeps a final output projection', () => {
    const { candidates } = compile('SELECT name FROM customers ORDER BY age DESC');
    for (const c of candidates) expect(c.plan.op).toBe('Project');
    expect(planSignature(candidates[0].plan)).toContain('Sort[c.age-]'.replace('c.', 'customers.'));
  });

  it('tryCompile returns diagnostics instead of throwing', () => {
    const r = tryCompile('SELECT FROM');
    expect(r.ok).toBe(false);
  });
});
