import { AggCall, ColumnRef, Expr, SelectStmt } from './ast';
import { Catalog, ColType, ColumnSchema, isNumeric, isTextual } from './catalog';
import { CompileError, Diagnostic, SourcePos, diag } from './diagnostics';
import { AggSpec, BExpr, JoinKey, ProjCol, SortKey, exprColumns } from './ir';

export interface BoundTable { table: string; alias: string; cols: ColumnSchema[] }

export interface BoundQuery {
  tables: BoundTable[];
  /** Equality predicates from every JOIN ... ON, in FROM order. l/r are alias-qualified columns. */
  joins: { tableIndex: number; keys: JoinKey[] }[];
  where: BExpr | null;
  groupBy: string[];
  aggs: AggSpec[];
  having: BExpr | null;
  /** Sort keys expressed over the post-aggregation schema (or base columns for non-aggregate queries). */
  orderBy: SortKey[];
  outputs: ProjCol[];
  outputTypes: ColType[];
  isAggregate: boolean;
  /** Type of every alias-qualified base column in scope. */
  columnTypes: Record<string, ColType>;
}

export function analyze(ast: SelectStmt, catalog: Catalog): BoundQuery {
  return new Analyzer(ast, catalog).run();
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function suggest(name: string, candidates: string[]): string {
  let best = '';
  let bestD = Infinity;
  for (const c of candidates) {
    const d = levenshtein(name.toLowerCase(), c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= Math.max(2, Math.floor(name.length / 3)) ? ` Did you mean '${best}'?` : '';
}

class Analyzer {
  private tables: BoundTable[] = [];
  private columnTypes: Record<string, ColType> = {};
  private aggs: AggSpec[] = [];
  private aggIndex = new Map<string, AggSpec>();
  private errors: Diagnostic[] = [];

  constructor(private readonly ast: SelectStmt, private readonly catalog: Catalog) {}

  private err(message: string, pos: SourcePos, length = 1): never {
    throw new CompileError([diag('semantic', message, pos, length)]);
  }

  run(): BoundQuery {
    const ast = this.ast;

    // ---- FROM / JOIN tables ----
    this.addTable(ast.from.name, ast.from.alias, ast.from.pos);
    const joins: BoundQuery['joins'] = [];
    for (const j of ast.joins) {
      this.addTable(j.table.name, j.table.alias, j.table.pos);
      const idx = this.tables.length - 1;
      joins.push({ tableIndex: idx, keys: this.bindJoin(j.on, idx) });
    }

    // ---- WHERE ----
    let where: BExpr | null = null;
    if (ast.where) {
      this.assertNoAgg(ast.where, 'WHERE');
      where = this.bindPredicate(ast.where, this.tables.length);
    }

    // ---- GROUP BY ----
    const groupBy = ast.groupBy.map((c) => this.resolveColumn(c, this.tables.length).name);
    const isAggregate = groupBy.length > 0 || this.selectHasAgg() || this.exprHasAgg(ast.having) || ast.orderBy.some((o) => o.expr.kind === 'agg');

    // ---- SELECT list ----
    const outputs: ProjCol[] = [];
    const outputTypes: ColType[] = [];
    const aliasToSource = new Map<string, string>();

    if (ast.star) {
      if (isAggregate) this.err('SELECT * cannot be combined with GROUP BY or aggregate functions', ast.from.pos);
      for (const t of this.tables) {
        for (const c of t.cols) {
          outputs.push({ src: `${t.alias}.${c.name}`, as: c.name });
        }
      }
      const seen = new Set<string>();
      for (const o of outputs) {
        if (seen.has(o.as)) this.err(`SELECT * produces duplicate column name '${o.as}'; list columns explicitly with aliases`, ast.from.pos);
        seen.add(o.as);
      }
      outputs.forEach((o) => outputTypes.push(this.columnTypes[o.src]));
    } else {
      for (const item of ast.items) {
        let src: string;
        let type: ColType;
        let defaultName: string;
        if (item.expr.kind === 'column') {
          const col = this.resolveColumn(item.expr, this.tables.length);
          src = col.name; type = col.type; defaultName = item.expr.name;
          if (isAggregate && !groupBy.includes(src)) {
            this.err(`Column '${this.display(item.expr)}' must appear in GROUP BY or be used inside an aggregate function`, item.expr.pos, item.expr.name.length);
          }
        } else {
          const spec = this.registerAgg(item.expr);
          src = spec.as; type = spec.type;
          defaultName = item.expr.arg ? `${item.expr.func.toLowerCase()}_${item.expr.arg.name}` : `${item.expr.func.toLowerCase()}_all`;
        }
        const name = (item.alias ?? defaultName);
        if (outputs.some((o) => o.as.toLowerCase() === name.toLowerCase())) {
          this.err(`Duplicate output column name '${name}'; use AS to give it a distinct alias`, item.pos, name.length);
        }
        outputs.push({ src, as: name });
        outputTypes.push(type);
        if (item.alias) aliasToSource.set(item.alias.toLowerCase(), src);
      }
    }

    // ---- HAVING ----
    let having: BExpr | null = null;
    if (ast.having) {
      if (!isAggregate) this.err('HAVING requires GROUP BY or aggregate functions', this.exprPos(ast.having));
      having = this.bindPredicate(ast.having, this.tables.length, { havingGroup: groupBy });
    }

    // ---- ORDER BY ----
    const orderBy: SortKey[] = [];
    for (const o of ast.orderBy) {
      let col: string;
      if (o.expr.kind === 'agg') {
        col = this.registerAgg(o.expr).as;
      } else {
        const bare = !o.expr.table ? aliasToSource.get(o.expr.name.toLowerCase()) : undefined;
        if (bare) col = bare;
        else {
          col = this.resolveColumn(o.expr, this.tables.length).name;
          if (isAggregate && !groupBy.includes(col)) {
            this.err(`ORDER BY column '${this.display(o.expr)}' must appear in GROUP BY or be an aggregate`, o.expr.pos, o.expr.name.length);
          }
        }
      }
      orderBy.push({ col, desc: o.desc });
    }

    if (this.errors.length) throw new CompileError(this.errors);
    return {
      tables: this.tables, joins, where, groupBy, aggs: this.aggs, having, orderBy,
      outputs, outputTypes, isAggregate, columnTypes: this.columnTypes,
    };
  }

  // ---- table & column binding ------------------------------------------------------------

  private addTable(name: string, alias: string | undefined, pos: SourcePos): void {
    const schema = this.catalog[name.toLowerCase()];
    if (!schema) {
      this.err(`Unknown table '${name}'.${suggest(name, Object.keys(this.catalog))}`, pos, name.length);
    }
    const a = (alias ?? name).toLowerCase();
    if (this.tables.some((t) => t.alias === a)) {
      this.err(`Duplicate table alias '${a}'; give each occurrence of a table a distinct alias`, pos, name.length);
    }
    this.tables.push({ table: schema.name, alias: a, cols: schema.columns });
    for (const c of schema.columns) this.columnTypes[`${a}.${c.name}`] = c.type;
  }

  /** Resolve a column reference against the first `scopeSize` tables. */
  private resolveColumn(ref: ColumnRef, scopeSize: number): { name: string; type: ColType } {
    const scope = this.tables.slice(0, scopeSize);
    if (ref.table) {
      const t = scope.find((s) => s.alias === ref.table!.toLowerCase());
      if (!t) {
        this.err(`Unknown table or alias '${ref.table}'.${suggest(ref.table, scope.map((s) => s.alias))}`, ref.pos, ref.table.length);
      }
      const c = t.cols.find((x) => x.name === ref.name.toLowerCase());
      if (!c) {
        this.err(`Table '${t.alias}' has no column '${ref.name}'.${suggest(ref.name, t.cols.map((x) => x.name))}`, ref.pos, ref.name.length);
      }
      return { name: `${t.alias}.${c.name}`, type: c.type };
    }
    const matches: { name: string; type: ColType; table: string }[] = [];
    for (const t of scope) {
      const c = t.cols.find((x) => x.name === ref.name.toLowerCase());
      if (c) matches.push({ name: `${t.alias}.${c.name}`, type: c.type, table: t.alias });
    }
    if (matches.length === 0) {
      const all = scope.flatMap((t) => t.cols.map((c) => c.name));
      this.err(`Unknown column '${ref.name}'.${suggest(ref.name, all)}`, ref.pos, ref.name.length);
    }
    if (matches.length > 1) {
      this.err(`Ambiguous column '${ref.name}' (found in ${matches.map((m) => m.table).join(', ')}); qualify it with a table alias`, ref.pos, ref.name.length);
    }
    return matches[0];
  }

  private display(c: ColumnRef): string { return c.table ? `${c.table}.${c.name}` : c.name; }

  // ---- joins -----------------------------------------------------------------------------

  private bindJoin(on: Expr, tableIndex: number): JoinKey[] {
    const keys: JoinKey[] = [];
    const visit = (e: Expr) => {
      if (e.kind === 'and') { visit(e.left); visit(e.right); return; }
      if (e.kind !== 'compare' || e.op !== '=' || e.left.kind !== 'column' || e.right.kind !== 'column') {
        this.err('Only equality joins of the form a.col = b.col (optionally combined with AND) are supported in ON', this.exprPos(e));
      }
      const a = this.resolveColumn(e.left as ColumnRef, tableIndex + 1);
      const b = this.resolveColumn(e.right as ColumnRef, tableIndex + 1);
      const tableOf = (n: string) => n.slice(0, n.indexOf('.'));
      const newAlias = this.tables[tableIndex].alias;
      let l: typeof a, r: typeof a;
      if (tableOf(a.name) === newAlias && tableOf(b.name) !== newAlias) { l = b; r = a; }
      else if (tableOf(b.name) === newAlias && tableOf(a.name) !== newAlias) { l = a; r = b; }
      else this.err(`Join condition must relate the newly joined table '${newAlias}' to a previously listed table`, this.exprPos(e));
      if (!this.comparable(l.type, r.type)) {
        this.err(`Join keys '${l.name}' (${l.type}) and '${r.name}' (${r.type}) have incompatible types`, this.exprPos(e));
      }
      keys.push({ l: l.name, r: r.name });
    };
    visit(on);
    return keys;
  }

  // ---- aggregates ------------------------------------------------------------------------

  private selectHasAgg(): boolean { return this.ast.items.some((i) => i.expr.kind === 'agg'); }

  private exprHasAgg(e?: Expr): boolean {
    if (!e) return false;
    switch (e.kind) {
      case 'agg': return true;
      case 'compare': case 'and': case 'or': return this.exprHasAgg(e.left) || this.exprHasAgg(e.right);
      case 'not': return this.exprHasAgg(e.operand);
      case 'between': return this.exprHasAgg(e.operand) || this.exprHasAgg(e.low) || this.exprHasAgg(e.high);
      case 'in': return this.exprHasAgg(e.operand) || e.items.some((i) => this.exprHasAgg(i));
      case 'like': return this.exprHasAgg(e.operand);
      default: return false;
    }
  }

  private assertNoAgg(e: Expr, clause: string): void {
    if (this.exprHasAgg(e)) this.err(`Aggregate functions are not allowed in ${clause}`, this.exprPos(e));
  }

  private registerAgg(call: AggCall): AggSpec {
    let argName: string | null = null;
    let argType: ColType = 'int';
    if (call.arg) {
      const c = this.resolveColumn(call.arg, this.tables.length);
      argName = c.name; argType = c.type;
      if ((call.func === 'SUM' || call.func === 'AVG') && !isNumeric(c.type)) {
        this.err(`${call.func} requires a numeric column but '${c.name}' is ${c.type}`, call.arg.pos, call.arg.name.length);
      }
    }
    const key = `${call.func}(${argName ?? '*'})`;
    const existing = this.aggIndex.get(key);
    if (existing) return existing;
    const type: ColType = call.func === 'COUNT' ? 'int' : call.func === 'AVG' ? 'float' : argType;
    const spec: AggSpec = { fn: call.func, arg: argName, as: `__agg${this.aggs.length}`, type };
    this.aggs.push(spec);
    this.aggIndex.set(key, spec);
    return spec;
  }

  // ---- predicates ------------------------------------------------------------------------

  private bindPredicate(e: Expr, scopeSize: number, opts: { havingGroup?: string[] } = {}): BExpr {
    const bindOperand = (x: Expr): BExpr => {
      switch (x.kind) {
        case 'column': {
          const c = this.resolveColumn(x, scopeSize);
          if (opts.havingGroup && !opts.havingGroup.includes(c.name)) {
            this.err(`HAVING column '${this.display(x)}' must appear in GROUP BY or be inside an aggregate`, x.pos, x.name.length);
          }
          return { k: 'col', name: c.name, type: c.type };
        }
        case 'agg': {
          if (!opts.havingGroup) this.err('Aggregate functions are only allowed in SELECT, HAVING and ORDER BY', x.pos);
          const spec = this.registerAgg(x);
          return { k: 'col', name: spec.as, type: spec.type };
        }
        case 'number': return { k: 'lit', value: x.value, type: x.isFloat ? 'float' : 'int' };
        case 'string': return { k: 'lit', value: x.value, type: 'string' };
        default: return this.err('Arithmetic and nested expressions are not supported as operands', this.exprPos(x));
      }
    };
    const typeOf = (b: BExpr): ColType => (b.k === 'col' || b.k === 'lit' ? b.type : 'int');
    const bind = (x: Expr): BExpr => {
      switch (x.kind) {
        case 'and': return { k: 'and', l: bind(x.left), r: bind(x.right) };
        case 'or': return { k: 'or', l: bind(x.left), r: bind(x.right) };
        case 'not': return { k: 'not', e: bind(x.operand) };
        case 'compare': {
          const l = bindOperand(x.left), r = bindOperand(x.right);
          this.checkComparable(l, r, x.pos, typeOf);
          return { k: 'cmp', op: x.op, l, r };
        }
        case 'between': {
          const v = bindOperand(x.operand), lo = bindOperand(x.low), hi = bindOperand(x.high);
          this.checkComparable(v, lo, x.pos, typeOf);
          this.checkComparable(v, hi, x.pos, typeOf);
          return { k: 'between', e: v, low: lo, high: hi, negated: x.negated };
        }
        case 'in': {
          const v = bindOperand(x.operand);
          const items = x.items.map(bindOperand);
          if (items.some((it) => it.k !== 'lit')) this.err('IN lists may contain only literal values', x.pos);
          items.forEach((it) => this.checkComparable(v, it, x.pos, typeOf));
          return { k: 'in', e: v, items, negated: x.negated };
        }
        case 'like': {
          const v = bindOperand(x.operand);
          if (!isTextual(typeOf(v))) this.err(`LIKE requires a text column but operand is ${typeOf(v)}`, x.pos);
          return { k: 'like', e: v, pattern: x.pattern.value, negated: x.negated };
        }
        default:
          return this.err('Expected a boolean predicate', this.exprPos(x));
      }
    };
    const result = bind(e);
    // Sanity: every column must be in scope (guards future grammar extensions).
    exprColumns(result);
    return result;
  }

  private comparable(a: ColType, b: ColType): boolean {
    return (isNumeric(a) && isNumeric(b)) || (isTextual(a) && isTextual(b));
  }

  private checkComparable(l: BExpr, r: BExpr, pos: SourcePos, typeOf: (b: BExpr) => ColType): void {
    const lt = typeOf(l), rt = typeOf(r);
    if (!this.comparable(lt, rt)) {
      this.err(`Type mismatch: cannot compare ${lt} with ${rt}`, pos);
    }
  }

  private exprPos(e: Expr): SourcePos { return e.pos; }
}
