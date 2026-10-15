import { ColType } from './catalog';

/**
 * Relational intermediate representation. Nodes are immutable; every node carries the ordered list
 * of (alias-qualified) columns it produces so schema consistency can be checked structurally.
 */

export type BExpr =
  | { k: 'col'; name: string; type: ColType }
  | { k: 'lit'; value: number | string; type: ColType }
  | { k: 'cmp'; op: '=' | '<>' | '<' | '<=' | '>' | '>='; l: BExpr; r: BExpr }
  | { k: 'and'; l: BExpr; r: BExpr }
  | { k: 'or'; l: BExpr; r: BExpr }
  | { k: 'not'; e: BExpr }
  | { k: 'between'; e: BExpr; low: BExpr; high: BExpr; negated: boolean }
  | { k: 'in'; e: BExpr; items: BExpr[]; negated: boolean }
  | { k: 'like'; e: BExpr; pattern: string; negated: boolean };

export interface AggSpec { fn: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'; arg: string | null; as: string; type: ColType }
export interface ProjCol { src: string; as: string }
export interface JoinKey { l: string; r: string }
export interface SortKey { col: string; desc: boolean }

export type IRNode =
  | { op: 'Scan'; table: string; alias: string; schema: string[]; types: Record<string, ColType> }
  | { op: 'Filter'; child: IRNode; pred: BExpr; schema: string[] }
  | { op: 'Project'; child: IRNode; cols: ProjCol[]; purpose: 'prune' | 'output'; schema: string[] }
  | { op: 'Join'; left: IRNode; right: IRNode; keys: JoinKey[]; schema: string[] }
  | { op: 'Aggregate'; child: IRNode; groupBy: string[]; aggs: AggSpec[]; schema: string[] }
  | { op: 'Having'; child: IRNode; pred: BExpr; schema: string[] }
  | { op: 'Sort'; child: IRNode; keys: SortKey[]; schema: string[] };

export type OpName = IRNode['op'];

// ---- expression helpers --------------------------------------------------------------------

export function exprColumns(e: BExpr, out: Set<string> = new Set()): Set<string> {
  switch (e.k) {
    case 'col': out.add(e.name); break;
    case 'lit': break;
    case 'cmp': case 'and': case 'or': exprColumns(e.l, out); exprColumns(e.r, out); break;
    case 'not': exprColumns(e.e, out); break;
    case 'between': exprColumns(e.e, out); exprColumns(e.low, out); exprColumns(e.high, out); break;
    case 'in': exprColumns(e.e, out); e.items.forEach((i) => exprColumns(i, out)); break;
    case 'like': exprColumns(e.e, out); break;
  }
  return out;
}

export function conjuncts(e: BExpr): BExpr[] {
  return e.k === 'and' ? [...conjuncts(e.l), ...conjuncts(e.r)] : [e];
}

export function andAll(list: BExpr[]): BExpr | null {
  if (!list.length) return null;
  return list.reduce((a, b) => ({ k: 'and', l: a, r: b }));
}

export function exprToSql(e: BExpr): string {
  switch (e.k) {
    case 'col': return e.name;
    case 'lit': return typeof e.value === 'string' ? `'${e.value.replace(/'/g, "''")}'` : String(e.value);
    case 'cmp': return `${exprToSql(e.l)} ${e.op} ${exprToSql(e.r)}`;
    case 'and': return `(${exprToSql(e.l)} AND ${exprToSql(e.r)})`;
    case 'or': return `(${exprToSql(e.l)} OR ${exprToSql(e.r)})`;
    case 'not': return `NOT ${exprToSql(e.e)}`;
    case 'between': return `${exprToSql(e.e)} ${e.negated ? 'NOT ' : ''}BETWEEN ${exprToSql(e.low)} AND ${exprToSql(e.high)}`;
    case 'in': return `${exprToSql(e.e)} ${e.negated ? 'NOT ' : ''}IN (${e.items.map(exprToSql).join(', ')})`;
    case 'like': return `${exprToSql(e.e)} ${e.negated ? 'NOT ' : ''}LIKE '${e.pattern.replace(/'/g, "''")}'`;
  }
}

// ---- node constructors (compute and check schemas) ----------------------------------------

export function scan(table: string, alias: string, cols: { name: string; type: ColType }[]): IRNode {
  const schema = cols.map((c) => `${alias}.${c.name}`);
  const types: Record<string, ColType> = {};
  cols.forEach((c) => { types[`${alias}.${c.name}`] = c.type; });
  return { op: 'Scan', table, alias, schema, types };
}

export function filter(child: IRNode, pred: BExpr): IRNode {
  assertColumns(exprColumns(pred), child.schema, 'Filter');
  return { op: 'Filter', child, pred, schema: child.schema };
}

export function project(child: IRNode, cols: ProjCol[], purpose: 'prune' | 'output'): IRNode {
  assertColumns(new Set(cols.map((c) => c.src)), child.schema, 'Project');
  return { op: 'Project', child, cols, purpose, schema: cols.map((c) => c.as) };
}

export function pruneTo(child: IRNode, keep: string[]): IRNode {
  const ordered = child.schema.filter((c) => keep.includes(c));
  return project(child, ordered.map((c) => ({ src: c, as: c })), 'prune');
}

export function join(left: IRNode, right: IRNode, keys: JoinKey[]): IRNode {
  assertColumns(new Set(keys.map((k) => k.l)), left.schema, 'Join(left)');
  assertColumns(new Set(keys.map((k) => k.r)), right.schema, 'Join(right)');
  return { op: 'Join', left, right, keys, schema: [...left.schema, ...right.schema] };
}

export function aggregate(child: IRNode, groupBy: string[], aggs: AggSpec[]): IRNode {
  assertColumns(new Set([...groupBy, ...aggs.filter((a) => a.arg).map((a) => a.arg!)]), child.schema, 'Aggregate');
  return { op: 'Aggregate', child, groupBy, aggs, schema: [...groupBy, ...aggs.map((a) => a.as)] };
}

export function having(child: IRNode, pred: BExpr): IRNode {
  assertColumns(exprColumns(pred), child.schema, 'Having');
  return { op: 'Having', child, pred, schema: child.schema };
}

export function sort(child: IRNode, keys: SortKey[]): IRNode {
  assertColumns(new Set(keys.map((k) => k.col)), child.schema, 'Sort');
  return { op: 'Sort', child, keys, schema: child.schema };
}

function assertColumns(needed: Set<string>, available: string[], where: string): void {
  for (const c of needed) {
    if (!available.includes(c)) {
      throw new Error(`IR schema violation: ${where} needs column '${c}' not produced by its input [${available.join(', ')}]`);
    }
  }
}

// ---- tree utilities -------------------------------------------------------------------------

export function children(n: IRNode): IRNode[] {
  switch (n.op) {
    case 'Scan': return [];
    case 'Join': return [n.left, n.right];
    default: return [n.child];
  }
}

export function walk(n: IRNode, fn: (n: IRNode) => void): void {
  fn(n);
  children(n).forEach((c) => walk(c, fn));
}

export function planDepth(n: IRNode): number {
  return 1 + Math.max(0, ...children(n).map(planDepth));
}

/** One-line operator label used in plan viewers. */
export function nodeLabel(n: IRNode): string {
  switch (n.op) {
    case 'Scan': return `Scan ${n.table}${n.alias !== n.table ? ' AS ' + n.alias : ''}`;
    case 'Filter': return `Filter ${exprToSql(n.pred)}`;
    case 'Having': return `Having ${exprToSql(n.pred)}`;
    case 'Project': return n.purpose === 'prune' ? `Prune [${n.cols.length} cols]` : `Project [${n.cols.map((c) => (c.src === c.as ? c.as : `${c.src} AS ${c.as}`)).join(', ')}]`;
    case 'Join': return `Join ON ${n.keys.map((k) => `${k.l} = ${k.r}`).join(' AND ')}`;
    case 'Aggregate': return `Aggregate by [${n.groupBy.join(', ')}] → ${n.aggs.map((a) => `${a.fn}(${a.arg ?? '*'})`).join(', ')}`;
    case 'Sort': return `Sort ${n.keys.map((k) => `${k.col} ${k.desc ? 'DESC' : 'ASC'}`).join(', ')}`;
  }
}

/** Canonical, deterministic serialization of a plan (structure + parameters). */
export function planSignature(n: IRNode): string {
  switch (n.op) {
    case 'Scan': return `Scan(${n.table}:${n.alias})`;
    case 'Filter': return `Filter[${exprToSql(n.pred)}](${planSignature(n.child)})`;
    case 'Having': return `Having[${exprToSql(n.pred)}](${planSignature(n.child)})`;
    case 'Project': return `Project${n.purpose === 'prune' ? 'P' : 'O'}[${n.cols.map((c) => `${c.src}>${c.as}`).join(',')}](${planSignature(n.child)})`;
    case 'Join': return `Join[${n.keys.map((k) => `${k.l}=${k.r}`).join(',')}](${planSignature(n.left)},${planSignature(n.right)})`;
    case 'Aggregate': return `Agg[${n.groupBy.join(',')}|${n.aggs.map((a) => `${a.fn}(${a.arg ?? '*'})>${a.as}`).join(',')}](${planSignature(n.child)})`;
    case 'Sort': return `Sort[${n.keys.map((k) => `${k.col}${k.desc ? '-' : '+'}`).join(',')}](${planSignature(n.child)})`;
  }
}
