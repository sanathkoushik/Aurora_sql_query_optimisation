# Predictor feature schema — `aurora-runtime-features-v1`

The order of `FEATURE_NAMES` in `src/predictor/features.ts` is the contract between benchmark
capture, `python/train.py` and the browser interpreter (`src/predictor/forest.ts`). The feature
extractor is implemented **once**, in TypeScript; training reads the feature vectors that the
benchmark stored, so there is no training/inference skew. Changing any definition requires bumping
`FEATURE_SCHEMA_VERSION` and re-training; a model with a different version or feature order is
rejected with a controlled diagnostic and the selector falls back to the rule-based baseline.

| Feature | Definition | Source |
|---|---|---|
| `operator_scan_count` … `operator_sort_count` | count of Scan / Filter / Join / Project / Aggregate / Sort nodes | Appendix A |
| `plan_depth` | max number of nodes along a root-to-leaf path | Appendix A |
| `projected_column_count` | total columns kept by all Project nodes | Appendix A |
| `input_rows_log1p` | `log(1 + Σ rows of scanned tables)` | Appendix A |
| `input_column_count` | Σ columns of scanned tables | Appendix A |
| `filters_below_join` | Filter nodes with no Join in their subtree (pushed-down filters) | addition |
| `prunes_below_join` | pruning Projects with no Join in their subtree | addition |
| `prune_before_filter` | Filter nodes whose input is a pruning Project | addition |
| `columns_into_joins` | Σ over Joins of (left width + right width) | addition |
| `est_join_left_rows_log1p`, `est_join_right_rows_log1p` | log(1 + Σ estimated rows of the left / right operand of every Join) | addition |
| `est_join_output_rows_log1p` | log(1 + Σ estimated join output rows) | addition |
| `estimated_filter_selectivity` | product of conjunct selectivities of WHERE (`1` when any is unknown) | Appendix A (optional) |
| `filter_selectivity_known` | `1` if every conjunct could be estimated from the data profile, else `0` | addition |

The additions exist because the Appendix-A minimum cannot distinguish two candidates of the *same*
query that differ only in filter placement, pruning position or join order.

## Data profile and unknown statistics

`python/aurora_runtime.py::profile_tables` computes exact statistics (row count, distinct count,
min/max, and an exact value-frequency map for text columns with ≤ 64 distinct values). Selectivity
estimation (`src/optimizer/stats.ts`) returns `null` whenever the profile cannot answer reliably
(e.g. `LIKE` on a high-cardinality column, column-vs-column comparisons, non-date string ranges).
Unknown values are never invented: for the predictor an unknown predicate contributes no reduction
(retention 1) and `filter_selectivity_known = 0` tells the model so. The separate analytical cost
model used by Mode B applies the textbook System-R default of 1/3 for unknown predicates.
