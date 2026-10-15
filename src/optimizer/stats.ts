import { BExpr, IRNode, conjuncts } from '../compiler/ir';
import { BoundQuery } from '../compiler/semantic';
import { ColumnProfile, DataProfile } from '../runtime/runtime';

/**
 * Data-profile driven selectivity and cardinality estimation (the report's "Schema and Data
 * Profiler"). Selectivity is `null` whenever the profile cannot answer reliably; callers decide
 * explicitly how to treat an unknown value instead of silently inventing one.
 */

export interface StatsContext {
  profile: DataProfile;
  /** alias -> base table name */
  aliasToTable: Record<string, string>;
}

export function makeStatsContext(bq: BoundQuery, profile: DataProfile): StatsContext {
  return { profile, aliasToTable: Object.fromEntries(bq.tables.map((t) => [t.alias, t.table])) };
}

export function baseColumn(ctx: StatsContext, qualified: string): ColumnProfile | undefined {
  const dot = qualified.indexOf('.');
  const table = ctx.aliasToTable[qualified.slice(0, dot)];
  return ctx.profile.tables[table]?.columns[qualified.slice(dot + 1)];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Fraction of a column's range lying below `lit` (uniform assumption); null if not computable. */
function fractionBelow(col: ColumnProfile, lit: number | string): number | null {
  if (typeof lit === 'number' && typeof col.min === 'number' && typeof col.max === 'number') {
    if (col.max === col.min) return lit < col.min ? 0 : 1;
    return clamp01((lit - col.min) / (col.max - col.min));
  }
  if (typeof lit === 'string' && ISO_DATE.test(lit) && typeof col.min === 'string' && ISO_DATE.test(col.min) && ISO_DATE.test(String(col.max))) {
    const lo = Date.parse(col.min), hi = Date.parse(String(col.max)), x = Date.parse(lit);
    if (hi === lo) return x < lo ? 0 : 1;
    return clamp01((x - lo) / (hi - lo));
  }
  return null;
}

function eqSelectivity(col: ColumnProfile, lit: number | string): number {
  if (col.freq) return col.freq[String(lit)] ?? 0;
  if (typeof lit === 'number' && typeof col.min === 'number' && typeof col.max === 'number' && (lit < col.min || lit > col.max)) return 0;
  return 1 / Math.max(col.distinct, 1);
}

function likeRegex(pattern: string): RegExp {
  let re = '';
  for (const ch of pattern) re += ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${re}$`, 'is');
}

/** Estimated fraction of rows retained by `pred`, or null when the profile cannot determine it. */
export function selectivity(pred: BExpr, ctx: StatsContext): number | null {
  switch (pred.k) {
    case 'and': {
      const a = selectivity(pred.l, ctx), b = selectivity(pred.r, ctx);
      return a === null || b === null ? null : a * b;
    }
    case 'or': {
      const a = selectivity(pred.l, ctx), b = selectivity(pred.r, ctx);
      return a === null || b === null ? null : clamp01(a + b - a * b);
    }
    case 'not': {
      const a = selectivity(pred.e, ctx);
      return a === null ? null : 1 - a;
    }
    case 'cmp': {
      let col: BExpr = pred.l, lit: BExpr = pred.r, op = pred.op;
      if (col.k === 'lit' && lit.k === 'col') {
        [col, lit] = [lit, col];
        op = ({ '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=', '<>': '<>' } as const)[op];
      }
      if (col.k !== 'col' || lit.k !== 'lit') return null;
      const cp = baseColumn(ctx, col.name);
      if (!cp) return null;
      const eq = eqSelectivity(cp, lit.value);
      if (op === '=') return eq;
      if (op === '<>') return 1 - eq;
      const below = fractionBelow(cp, lit.value);
      if (below === null) return null;
      if (op === '<') return clamp01(below - (col.type === 'int' ? eq : 0));
      if (op === '<=') return clamp01(below + (col.type === 'int' ? eq : 0));
      if (op === '>') return clamp01(1 - below - (col.type === 'int' ? eq : 0));
      return clamp01(1 - below + (col.type === 'int' ? eq : 0)); // '>='
    }
    case 'between': {
      if (pred.e.k !== 'col' || pred.low.k !== 'lit' || pred.high.k !== 'lit') return null;
      const cp = baseColumn(ctx, pred.e.name);
      if (!cp) return null;
      const lo = fractionBelow(cp, pred.low.value), hi = fractionBelow(cp, pred.high.value);
      if (lo === null || hi === null) return null;
      const inclusive = pred.e.type === 'int' ? eqSelectivity(cp, pred.high.value) : 0;
      const s = clamp01(hi - lo + inclusive);
      return pred.negated ? 1 - s : s;
    }
    case 'in': {
      if (pred.e.k !== 'col') return null;
      const cp = baseColumn(ctx, pred.e.name);
      if (!cp) return null;
      let s = 0;
      for (const it of pred.items) if (it.k === 'lit') s += eqSelectivity(cp, it.value);
      s = clamp01(s);
      return pred.negated ? 1 - s : s;
    }
    case 'like': {
      if (pred.e.k !== 'col') return null;
      const cp = baseColumn(ctx, pred.e.name);
      if (!cp?.freq) return null; // exact answer only for columns with an exact frequency map
      const re = likeRegex(pred.pattern);
      let s = 0;
      for (const [v, f] of Object.entries(cp.freq)) if (re.test(v)) s += f;
      return pred.negated ? 1 - s : s;
    }
    default:
      return null;
  }
}

/**
 * Query-level estimated retained-row fraction: product of the conjunct selectivities of WHERE.
 * `known` is false when at least one conjunct could not be estimated from the profile.
 */
export function whereSelectivity(bq: BoundQuery, ctx: StatsContext): { value: number; known: boolean } {
  if (!bq.where) return { value: 1, known: true };
  let value = 1;
  let known = true;
  for (const c of conjuncts(bq.where)) {
    const s = selectivity(c, ctx);
    if (s === null) known = false;
    else value *= s;
  }
  return { value, known };
}

// ---- cardinality estimation ---------------------------------------------------------------

export interface EstimateOptions {
  /** Retention used for predicates whose selectivity is unknown (1 = assume no reduction). */
  unknownSelectivity: number;
}

export function estimateRows(node: IRNode, ctx: StatsContext, opts: EstimateOptions): number {
  switch (node.op) {
    case 'Scan': return ctx.profile.tables[node.table]?.rows ?? 0;
    case 'Project': case 'Sort': return estimateRows(node.child, ctx, opts);
    case 'Filter': {
      const rows = estimateRows(node.child, ctx, opts);
      const s = selectivity(node.pred, ctx);
      return rows * (s ?? opts.unknownSelectivity);
    }
    case 'Having': return estimateRows(node.child, ctx, opts) * (selectivity(node.pred, ctx) ?? 1 / 3);
    case 'Join': {
      const l = estimateRows(node.left, ctx, opts);
      const r = estimateRows(node.right, ctx, opts);
      let denom = 1;
      for (const k of node.keys) {
        const dl = Math.min(baseColumn(ctx, k.l)?.distinct ?? l, Math.max(l, 1));
        const dr = Math.min(baseColumn(ctx, k.r)?.distinct ?? r, Math.max(r, 1));
        denom *= Math.max(dl, dr, 1);
      }
      return (l * r) / denom;
    }
    case 'Aggregate': {
      const rows = estimateRows(node.child, ctx, opts);
      if (!node.groupBy.length) return 1;
      let groups = 1;
      for (const g of node.groupBy) groups *= Math.max(baseColumn(ctx, g)?.distinct ?? rows, 1);
      return Math.max(1, Math.min(rows, groups));
    }
  }
}
