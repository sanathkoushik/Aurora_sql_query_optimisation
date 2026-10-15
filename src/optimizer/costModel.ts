import { IRNode, children } from '../compiler/ir';
import { BoundQuery } from '../compiler/semantic';
import { DataProfile } from '../runtime/runtime';
import { StatsContext, estimateRows, makeStatsContext } from './stats';

/**
 * Analytical cost model used by Mode B (the "hybrid cost / AI-assisted" selector).
 *
 * Cost is expressed in abstract work units: touching a cell costs COPY, hashing a row costs HASH,
 * and so on. The constants are fixed a priori (they are NOT fitted to the benchmark, which would
 * leak measured runtimes into the baseline). Predicates whose selectivity the profile cannot
 * determine use the classic System-R default of 1/3.
 */
export const COST_CONSTANTS = {
  COPY: 0.2, // per cell materialised
  MASK: 1.0, // per row evaluated by a predicate
  HASH: 3.0, // per input row of a hash join
  AGG: 1.0, // per input row of an aggregate
  SORT: 0.5, // per row * log2(rows)
  UNKNOWN_SELECTIVITY: 1 / 3,
};

export interface CostBreakdown { total: number; perNode: { label: string; rows: number; cost: number }[] }

export function planCost(plan: IRNode, bq: BoundQuery, profile: DataProfile, ctx: StatsContext = makeStatsContext(bq, profile)): CostBreakdown {
  const C = COST_CONSTANTS;
  const est = { unknownSelectivity: C.UNKNOWN_SELECTIVITY };
  const perNode: CostBreakdown['perNode'] = [];
  let total = 0;
  const add = (label: string, rows: number, cost: number) => { perNode.push({ label, rows, cost }); total += cost; };

  const visit = (n: IRNode) => {
    children(n).forEach(visit);
    const rowsOut = estimateRows(n, ctx, est);
    const rowsIn = children(n).map((c) => estimateRows(c, ctx, est));
    switch (n.op) {
      case 'Scan': add(`Scan ${n.table}`, rowsOut, rowsOut * n.schema.length * C.COPY); break;
      case 'Filter': add('Filter', rowsOut, rowsIn[0] * C.MASK + rowsOut * n.schema.length * C.COPY); break;
      case 'Having': add('Having', rowsOut, rowsIn[0] * C.MASK); break;
      case 'Project': add(n.purpose === 'prune' ? 'Prune' : 'Project', rowsOut, rowsOut * n.schema.length * C.COPY); break;
      case 'Join': add('Join', rowsOut, (rowsIn[0] + rowsIn[1]) * C.HASH + rowsOut * n.schema.length * C.COPY); break;
      case 'Aggregate': add('Aggregate', rowsOut, rowsIn[0] * C.AGG); break;
      case 'Sort': add('Sort', rowsOut, rowsOut * Math.log2(rowsOut + 2) * C.SORT); break;
    }
  };
  visit(plan);
  return { total, perNode };
}
