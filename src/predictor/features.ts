import { IRNode, children, planDepth, walk } from '../compiler/ir';
import { BoundQuery } from '../compiler/semantic';
import { StatsContext, estimateRows, makeStatsContext, whereSelectivity } from '../optimizer/stats';
import { DataProfile } from '../runtime/runtime';

/**
 * Predictor feature schema (Appendix A of the report). The ORDER of FEATURE_NAMES is the contract
 * between benchmark capture, python/train.py and the browser-side forest interpreter. Any change
 * to a definition must bump FEATURE_SCHEMA_VERSION and trigger re-training.
 *
 * Features beyond Appendix A's minimum are plan-dependent descriptors of filter placement and join
 * input size, needed so that different candidates of the same query can be told apart.
 */
export const FEATURE_SCHEMA_VERSION = 'aurora-runtime-features-v1';

export const FEATURE_NAMES = [
  'operator_scan_count',
  'operator_filter_count',
  'operator_join_count',
  'operator_project_count',
  'operator_aggregate_count',
  'operator_sort_count',
  'plan_depth',
  'projected_column_count',
  'input_rows_log1p',
  'input_column_count',
  // --- additions (documented in docs/FEATURES.md) ---
  'filters_below_join',
  'prunes_below_join',
  'prune_before_filter',
  'columns_into_joins',
  'est_join_left_rows_log1p',
  'est_join_right_rows_log1p',
  'est_join_output_rows_log1p',
  'estimated_filter_selectivity',
  'filter_selectivity_known',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureVector = Record<FeatureName, number>;

const hasJoin = (n: IRNode): boolean => {
  let found = false;
  walk(n, (x) => { if (x.op === 'Join') found = true; });
  return found;
};

export function extractFeatures(plan: IRNode, bq: BoundQuery, profile: DataProfile, ctx: StatsContext = makeStatsContext(bq, profile)): FeatureVector {
  const f = Object.fromEntries(FEATURE_NAMES.map((n) => [n, 0])) as FeatureVector;
  // Unknown predicate selectivity contributes no reduction (retention = 1); the
  // filter_selectivity_known flag tells the model when that happened.
  const est = { unknownSelectivity: 1 };

  let inputRows = 0, inputCols = 0;
  let leftRows = 0, rightRows = 0, joinOut = 0;

  walk(plan, (n) => {
    switch (n.op) {
      case 'Scan':
        f.operator_scan_count++;
        inputRows += profile.tables[n.table]?.rows ?? 0;
        inputCols += n.schema.length;
        break;
      case 'Filter':
        f.operator_filter_count++;
        if (!hasJoin(n)) f.filters_below_join++;
        break;
      case 'Project':
        f.operator_project_count++;
        f.projected_column_count += n.cols.length;
        if (n.purpose === 'prune' && !hasJoin(n)) f.prunes_below_join++;
        break;
      case 'Join':
        f.operator_join_count++;
        f.columns_into_joins += n.left.schema.length + n.right.schema.length;
        leftRows += estimateRows(n.left, ctx, est);
        rightRows += estimateRows(n.right, ctx, est);
        joinOut += estimateRows(n, ctx, est);
        break;
      case 'Aggregate': f.operator_aggregate_count++; break;
      case 'Sort': f.operator_sort_count++; break;
      case 'Having': break;
    }
    if (n.op === 'Filter' && children(n)[0].op === 'Project' && (children(n)[0] as Extract<IRNode, { op: 'Project' }>).purpose === 'prune') {
      f.prune_before_filter++;
    }
  });

  f.plan_depth = planDepth(plan);
  f.input_rows_log1p = Math.log1p(inputRows);
  f.input_column_count = inputCols;
  f.est_join_left_rows_log1p = Math.log1p(leftRows);
  f.est_join_right_rows_log1p = Math.log1p(rightRows);
  f.est_join_output_rows_log1p = Math.log1p(joinOut);
  const sel = whereSelectivity(bq, ctx);
  f.estimated_filter_selectivity = sel.known ? sel.value : 1;
  f.filter_selectivity_known = sel.known ? 1 : 0;
  return f;
}

/** Feature vector as an ordered array (the exact order the model was trained on). */
export const featureArray = (f: FeatureVector): number[] => FEATURE_NAMES.map((n) => f[n]);
