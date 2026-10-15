# Architecture

```
 SQL text
   │  src/compiler/lexer.ts        DFA tokenizer (explicit states + delta function, maximal munch)
   ▼
 tokens ── src/compiler/parser.ts   recursive descent → AST (OR < AND < NOT < comparison)
   ▼
 AST ───── src/compiler/semantic.ts schema binding, type checks, GROUP BY / HAVING / ORDER BY rules
   ▼
 BoundQuery
   │  src/compiler/candidates.ts    pushdown × pruning(none|early|late) × swap × reorder, validated + de-duplicated
   ▼
 candidate set P = {P1…Pn}  (identical for every selector)
   ├── Mode A  src/selectors/ruleBased.ts      fixed structural rules R1–R4
   ├── Mode B  src/selectors/aiAssisted.ts     analytical cost model (+ optional LLM re-rank, validated)
   └── Mode C  src/selectors/predictorGuided.ts Random-Forest runtime prediction (exported JSON, TS interpreter)
   ▼
 selected plan ── src/runtime/codegen.ts  → pandas source ── Pyodide (python/aurora_runtime.py)
```

## Calibration / training path (offline)

1. `npm run benchmark` – for each of 16 query templates × 6 data profiles, execute every valid
   candidate, verify its rows against **SQLite running the original SQL**, then time survivors
   (2 warm-up + 9 interleaved timed runs, GC disabled around each run, median as the label).
   Output: `artifacts/benchmark/records.jsonl` (Appendix B format) and `meta.json`.
2. `npm run train` – `python/train.py` splits by *query template* (assignment fixed in
   `src/data/workloads.ts` before measurement), selects hyper-parameters on validation only,
   refits on train+validation, reports once on test, runs leave-one-template-out CV, and exports
   `artifacts/model/aurora_rf_v1.json` + a parity fixture.
3. `npm run evaluate` – runs the three selectors on the same pools and scores them against the
   measured medians (regret, oracle-hit, latency) with bootstrap confidence intervals.

## Correctness controls

* Every candidate is structurally validated (schema propagation, each table scanned once, output schema).
* Every candidate is result-checked against SQLite on all 6 profiles (`npm run validate`, 972 checks).
* Float aggregates compare with rtol = atol = 1e-6; rows compare as multisets; ORDER BY key columns
  must also appear in the reference order when visible in the output.
* A candidate that fails or is inequivalent is recorded with a reason and excluded from timing and training.

## Supported SQL subset

`SELECT` (columns, `*`, `COUNT/SUM/AVG/MIN/MAX`, aliases) · `FROM` + `[INNER] JOIN … ON a.x = b.y [AND …]` ·
`WHERE` (`= <> != < <= > >=`, `AND/OR/NOT`, `BETWEEN`, `IN (literals)`, `LIKE`) · `GROUP BY` · `HAVING` · `ORDER BY`.
Everything else (outer joins, subqueries, `DISTINCT`, `LIMIT`, window functions, `NULL` tests) is
rejected with a located diagnostic. Tables are NULL-free.
