import {
  AggSpec, IRNode, JoinKey, aggregate, andAll, children, conjuncts, exprColumns, filter, having,
  join, planSignature, project, pruneTo, scan, sort, walk,
} from './ir';
import { BoundQuery } from './semantic';

/**
 * Candidate-plan generation.
 *
 * Starting from one bound query we apply a restricted, equivalence-preserving transformation set:
 *   - predicate pushdown      : single-table conjuncts of WHERE move directly above their scan
 *   - projection pruning      : drop columns no later operator needs (none | early | late)
 *   - join-side swap          : exchange the left/right operands of every join
 *   - join reordering         : reverse left-deep join order when the join graph stays connected
 * The generator is deliberately bounded (<= 24 raw combinations, de-duplicated by plan signature).
 */

export type PruneMode = 'none' | 'early' | 'late';

export interface TransformOptions {
  pushdown: boolean;
  prune: PruneMode;
  swap: boolean;
  reorder: boolean;
}

export interface PlanValidity { valid: boolean; errors: string[] }

export interface Candidate {
  id: string;
  options: TransformOptions;
  /** Stable machine-readable description of the rules applied, e.g. "pd1_pr-early_sw0_ro0". */
  fingerprint: string;
  /** Human-readable names of the transformations applied. */
  transformations: string[];
  plan: IRNode;
  signature: string;
  validity: PlanValidity;
}

const BASELINE: TransformOptions = { pushdown: false, prune: 'none', swap: false, reorder: false };

export function fingerprintOf(o: TransformOptions): string {
  return `pd${o.pushdown ? 1 : 0}_pr-${o.prune}_sw${o.swap ? 1 : 0}_ro${o.reorder ? 1 : 0}`;
}

export function describeTransformations(o: TransformOptions): string[] {
  const t: string[] = [];
  if (o.pushdown) t.push('Predicate pushdown');
  if (o.prune === 'early') t.push('Projection pruning (before filters)');
  if (o.prune === 'late') t.push('Projection pruning (after filters)');
  if (o.swap) t.push('Join operands swapped');
  if (o.reorder) t.push('Join order reversed');
  return t.length ? t : ['None (canonical plan)'];
}

export function generateCandidates(bq: BoundQuery): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const prunes: PruneMode[] = ['none', 'early', 'late'];
  // Baseline is generated first so that it is always P1.
  for (const pushdown of [false, true]) {
    for (const prune of prunes) {
      for (const swap of [false, true]) {
        for (const reorder of [false, true]) {
          const options: TransformOptions = { pushdown, prune, swap, reorder };
          const plan = buildPlan(bq, options);
          if (!plan) continue;
          const signature = planSignature(plan);
          if (seen.has(signature)) continue;
          seen.add(signature);
          out.push({
            id: `P${out.length + 1}`,
            options,
            fingerprint: fingerprintOf(options),
            transformations: describeTransformations(options),
            plan,
            signature,
            validity: validatePlan(plan, bq),
          });
        }
      }
    }
  }
  return out;
}

export function baselinePlan(bq: BoundQuery): IRNode {
  return buildPlan(bq, BASELINE)!;
}

const tableOf = (col: string) => col.slice(0, col.indexOf('.'));

function buildPlan(bq: BoundQuery, o: TransformOptions): IRNode | null {
  // ---- which base columns does everything above the scans/joins need? ----
  const base = new Set(Object.keys(bq.columnTypes));
  const downstream = new Set<string>();
  const addIfBase = (c: string | null) => { if (c && base.has(c)) downstream.add(c); };
  bq.outputs.forEach((c) => addIfBase(c.src));
  bq.orderBy.forEach((k) => addIfBase(k.col));
  bq.groupBy.forEach(addIfBase);
  bq.aggs.forEach((a) => addIfBase(a.arg));

  const joinEqs: JoinKey[] = bq.joins.flatMap((j) => j.keys);
  const joinCols = new Set<string>();
  joinEqs.forEach((k) => { joinCols.add(k.l); joinCols.add(k.r); });

  const whereConj = bq.where ? conjuncts(bq.where) : [];
  const pushedBy = new Map<string, typeof whereConj>();
  const residual: typeof whereConj = [];
  for (const c of whereConj) {
    const cols = exprColumns(c);
    const tabs = new Set([...cols].map(tableOf));
    if (o.pushdown && tabs.size === 1) {
      const t = [...tabs][0];
      pushedBy.set(t, [...(pushedBy.get(t) ?? []), c]);
    } else residual.push(c);
  }
  const residualCols = new Set<string>();
  residual.forEach((c) => exprColumns(c, residualCols));

  // ---- build each table's branch ----
  const branches = new Map<string, IRNode>();
  for (const t of bq.tables) {
    let node = scan(t.table, t.alias, t.cols);
    const all = node.schema;
    const pushed = pushedBy.get(t.alias) ?? [];
    const pushedCols = new Set<string>();
    pushed.forEach((c) => exprColumns(c, pushedCols));
    const neededAfter = new Set(all.filter((c) => downstream.has(c) || joinCols.has(c) || residualCols.has(c)));
    const neededWithFilter = new Set([...neededAfter, ...pushedCols]);

    if (o.prune === 'early' && neededWithFilter.size < all.length) node = pruneTo(node, [...neededWithFilter]);
    const pushedPred = andAll(pushed);
    if (pushedPred) node = filter(node, pushedPred);
    if (o.prune === 'late' && o.pushdown && neededAfter.size < node.schema.length) node = pruneTo(node, [...neededAfter]);
    // (without pushdown, 'late' pruning is applied above the residual filter instead; see below)
    branches.set(t.alias, node);
  }

  // ---- join order ----
  const aliases = bq.tables.map((t) => t.alias);
  const order = o.reorder ? [...aliases].reverse() : aliases;
  let acc = branches.get(order[0])!;
  const inAcc = new Set([order[0]]);
  for (const alias of order.slice(1)) {
    const keys: JoinKey[] = [];
    for (const k of joinEqs) {
      const lt = tableOf(k.l), rt = tableOf(k.r);
      if (inAcc.has(lt) && rt === alias) keys.push({ l: k.l, r: k.r });
      else if (inAcc.has(rt) && lt === alias) keys.push({ l: k.r, r: k.l });
    }
    if (!keys.length) return null; // join graph not connected in this order
    const right = branches.get(alias)!;
    acc = o.swap
      ? join(right, acc, keys.map((k) => ({ l: k.r, r: k.l })))
      : join(acc, right, keys);
    inAcc.add(alias);
  }

  let plan = acc;
  const residualPred = andAll(residual);
  if (residualPred) plan = filter(plan, residualPred);
  if (o.prune === 'late' && !o.pushdown) {
    const keep = plan.schema.filter((c) => downstream.has(c));
    if (keep.length < plan.schema.length) plan = pruneTo(plan, keep);
  }

  if (bq.isAggregate) {
    const aggs: AggSpec[] = bq.aggs;
    plan = aggregate(plan, bq.groupBy, aggs);
    if (bq.having) plan = having(plan, bq.having);
  }
  if (bq.orderBy.length) plan = sort(plan, bq.orderBy);
  plan = project(plan, bq.outputs, 'output');
  return plan;
}

/** Structural validity: well-formed tree, consistent schemas, every base table scanned exactly once. */
export function validatePlan(plan: IRNode, bq: BoundQuery): PlanValidity {
  const errors: string[] = [];
  const scans: string[] = [];
  const check = (n: IRNode) => {
    const kids = children(n);
    switch (n.op) {
      case 'Scan': scans.push(n.alias); break;
      case 'Join': {
        const [l, r] = kids;
        if (n.schema.length !== l.schema.length + r.schema.length) errors.push('Join schema width mismatch');
        for (const k of n.keys) {
          if (!l.schema.includes(k.l) || !r.schema.includes(k.r)) errors.push(`Join key ${k.l}=${k.r} not available on operands`);
        }
        break;
      }
      case 'Project':
        for (const c of n.cols) if (!kids[0].schema.includes(c.src)) errors.push(`Project source '${c.src}' missing from child`);
        break;
      case 'Filter': case 'Having': case 'Sort':
        if (n.schema.join() !== kids[0].schema.join()) errors.push(`${n.op} must preserve its input schema`);
        break;
      case 'Aggregate': break;
    }
  };
  walk(plan, check);
  const expected = bq.tables.map((t) => t.alias).sort();
  if (scans.slice().sort().join() !== expected.join()) errors.push('Each table must be scanned exactly once');
  if (plan.schema.join() !== bq.outputs.map((o) => o.as).join()) errors.push('Plan output schema differs from query output');
  return { valid: errors.length === 0, errors };
}
