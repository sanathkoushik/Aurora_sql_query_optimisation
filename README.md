# Aurora — AI-assisted SQL query optimisation with transparent compilation

BCSE307P Compiler Design Lab · VIT Vellore · Sanath M Koushik (24BCE2187), Tarun T S (24BCE2188)
Guide: Nithya K, Assistant Professor Senior Grade II

Aurora compiles a SQL subset through a visible pipeline (DFA lexer → recursive-descent parser →
semantic analysis → relational IR → candidate plans), then compares **three plan-selection
strategies on the same candidate set**: (A) rule-based, (B) AI-assisted hybrid cost model, and
(C) a Random-Forest **runtime predictor** trained on measured executions. Plans run as pandas code in
the browser through Pyodide, and results are verified against SQLite.

## Run the live demo

```bash
npm install
npm run dev          # open the printed URL (internet needed once per load for the Pyodide CDN)
```

In the **Query Inspector**: pick an example (or type SQL) → *Compiler* (tokens, AST, semantic info, IR)
→ *Candidate plans* (trees + generated pandas) → *Selector modes* (A/B/C decisions, run any plan) →
*Benchmark* (verify against SQLite, time all candidates) → *Comparison* (measured runtime, regret,
oracle hit) → *Held-out evaluation* (offline results below).

## Reproduce everything

```bash
npm test                 # 109 tests: compiler, optimizer, selectors, Pyodide runtime, sklearn↔TS parity
npm run validate         # every candidate of every query on all 6 data profiles vs SQLite (972 checks)
npm run benchmark        # calibration run, ~12 min -> artifacts/benchmark/{records.jsonl,meta.json}
npm run train            # python/train.py (needs numpy, pandas, scikit-learn) -> artifacts/model/
npm run evaluate         # three-way comparison -> artifacts/results/{evaluation.json,RESULTS.md}
npm run build && npx tsx scripts/e2e.ts   # real-Chrome end-to-end check of the demo
```

## Measured results (from `artifacts/`, not estimated)

Environment: Pyodide 0.27.8 on Node 24 · Python 3.12.7 · pandas 2.2.3. 16 query templates × 6 data
profiles, 972 candidate plans, **all 972 result-equivalent to SQLite**, 2 warm-up + 9 timed runs each,
12.0 min calibration. Split by query template: 9 train / 3 validation / 4 test (never mixed).

**Predictor accuracy on held-out templates** (Table 4.4):

| | Random Forest | Median-runtime baseline |
|---|---|---|
| MAE (ms) | 8.17 | 19.27 |
| RMSE (ms) | 14.72 | 32.63 |
| Q-error median / p90 | 1.23 / 1.54 | 1.70 / 4.26 |

Leave-one-template-out over all 16 templates: mean MAE 5.95 ms vs 15.50 ms baseline.

**Plan selection on held-out templates, 24 cases** (Table 4.3):

| Strategy | Median regret (95% CI) | Oracle-hit (≤5% of fastest) |
|---|---|---|
| A. Rule-based | 1.029 (1.017–1.109) | 62.5% |
| B. Cost model only¹ | 1.027 (1.010–1.121) | 62.5% |
| C. Predictor-guided | 1.023 (1.009–1.046) | 70.8% |

**Honest conclusion:** the predictor estimates runtimes far better than the baseline (RQ1), but the
paired bootstrap shows **no statistically distinguishable difference in selection regret** between
the three strategies on this test set (RQ2/RQ3: inconclusive; all CIs include 0). Single timed runs vary
by a median 36% run-to-run, which is larger than the differences between selectors. Full tables:
[`artifacts/results/RESULTS.md`](artifacts/results/RESULTS.md).

¹ Mode B consults an LLM only if you provide an Anthropic API key (demo field or `ANTHROPIC_API_KEY`
for `npm run evaluate`). The numbers above were produced **without** an LLM, so Mode B there is the
analytical cost model alone; the LLM path is covered by mocked-client tests only.

## Documentation

* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) – pipeline, calibration path, correctness controls, SQL subset
* [`docs/FEATURES.md`](docs/FEATURES.md) – predictor feature schema and unknown-statistics policy
* [`docs/PHASES.md`](docs/PHASES.md) – implementation phases and status

## Scope and limits

Conclusions apply only to Aurora's own candidate space and the pandas/Pyodide runtime, not to
production DBMS engines. The dataset is synthetic (seeded, deterministic, NULL-free). Browser timers
are coarser than Node's, so the live Benchmark tab is for demonstration; the trained model and
reported results come from the Node calibration run. Unsupported SQL (outer joins, subqueries,
DISTINCT, LIMIT, window functions, NULL tests) is rejected with located diagnostics.
