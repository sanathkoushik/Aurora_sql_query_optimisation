# Aurora — AI-assisted SQL query optimisation with transparent compilation

BCSE307P Compiler Design Lab · VIT Vellore · Sanath M Koushik (24BCE2187), Tarun T S (24BCE2188)
Guide: Nithya K, Assistant Professor Senior Grade II

Aurora compiles a SQL subset through a visible pipeline (DFA lexer → recursive-descent parser →
semantic analysis → relational IR → candidate plans), then compares **four plan-selection strategies on
the same candidate set**: (A) rule-based, (B) AI-assisted hybrid cost model + LLM, (C) a Random-Forest
**runtime predictor** trained on measured executions, and (D) a **combined** mode in which the predictor
shortlists three plans and an LLM arbitrates. Plans run as pandas code in the browser through Pyodide,
and results are verified against SQLite.

**Headline result (60 held-out cases, 10 unseen query templates):** the predictor-guided selector beats the
rule-based and the AI-assisted selectors with statistically significant margins (paired bootstrap 95% CI
excludes 0); a free-tier LLM adds nothing measurable on its own, and combining it with the predictor
(Mode D) is statistically tied with the predictor alone. See [`docs/REPORT.md`](docs/REPORT.md).

## Run the live demo

```bash
npm install
npm run dev          # open the printed URL (internet needed once per load for the Pyodide CDN)
```

In the **Query Inspector**: pick an example (or type SQL) → *Compiler* (tokens, AST, semantic info, IR)
→ *Candidate plans* (trees + generated pandas) → *Selector modes* (A/B/C/D decisions, run any plan) →
*Benchmark* (verify against SQLite, time all candidates) → *Comparison* (measured runtime, regret,
oracle hit) → *Held-out evaluation* (offline results below).

## Reproduce everything

```bash
npm test                 # 116 tests: compiler, optimizer, selectors, Pyodide runtime, sklearn↔TS parity
npm run validate         # every candidate of every query on all 6 data profiles vs SQLite (2052 checks)
npm run benchmark        # calibration run, ~33 min -> artifacts/benchmark/{records.jsonl,meta.json}
npm run train            # python/train.py (needs numpy, pandas, scikit-learn) -> artifacts/model/
npm run evaluate         # three-way comparison -> artifacts/results/{evaluation.json,RESULTS.md}
npm run build && npx tsx scripts/e2e.ts   # real-Chrome end-to-end check of the demo
```

## Measured results (from `artifacts/`, not estimated)

Environment: Pyodide 0.27.8 on Node 24 · Python 3.12.7 · pandas 2.2.3. **32 query templates × 6 data
profiles, 2052 candidate plans, all 2052 result-equivalent to SQLite**, 2 warm-up + 9 timed runs each,
33 min calibration. Split by query template: 16 train / 6 validation / 10 test (never mixed).

**Predictor accuracy on held-out templates** (Table 4.4):

| | Random Forest | Median-runtime baseline |
|---|---|---|
| MAE (ms) | 8.92 | 33.45 |
| RMSE (ms) | 13.96 | 53.89 |
| Q-error median / p90 | 1.22 / 1.84 | 2.32 / 5.50 |

Leave-one-template-out over all 32 templates: mean MAE 6.68 ms vs 26.23 ms baseline.

**Plan selection on held-out templates, 60 cases** (Table 4.3; LLM = `gemini-3.5-flash-lite`, free tier):

| Strategy | Median regret (95% CI) | Oracle-hit (≤5% of fastest) |
|---|---|---|
| A. Rule-based | 1.108 (1.079–1.147) | 23.3% |
| B0. Cost model only | 1.085 (1.067–1.132) | 28.3% |
| B. Cost model + LLM | 1.089 (1.068–1.132) | 28.3% |
| C. Predictor-guided | **1.041 (1.010–1.092)** | **51.7%** |
| D. Predictor top-3 + LLM | 1.052 (1.012–1.091) | 50.0% |

Paired bootstrap on mean regret: **C beats A, B0 and B** (CIs exclude 0); B vs B0 and D vs C are
**inconclusive** (the LLM changed the cost-model choice in only 2 of 60 cases, and overrode the predictor
in 15 of 60 without a measurable gain or loss). Single timed runs vary by a median 53% run-to-run, so
differences below that are noise. Full tables: [`artifacts/results/RESULTS.md`](artifacts/results/RESULTS.md).

The LLM calls are cached in `artifacts/results/llm_cache.json`, so `npm run evaluate` reproduces the same
decisions offline. To re-query the API set `GEMINI_API_KEY` (free key from Google AI Studio; Gemma and
Gemini models both work) or `ANTHROPIC_API_KEY`, and optionally `AURORA_LLM_MODEL`. The earlier
16-template study is preserved in `artifacts/v1_16templates/`.

## Documentation

* [`docs/REPORT.md`](docs/REPORT.md) – final report: method, Tables 4.3/4.4, research questions, threats to validity
* [`docs/PRESENTATION.md`](docs/PRESENTATION.md) – demo script, talking points and likely viva questions
* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) – pipeline, calibration path, correctness controls, SQL subset
* [`docs/FEATURES.md`](docs/FEATURES.md) – predictor feature schema and unknown-statistics policy
* [`docs/PHASES.md`](docs/PHASES.md) – implementation phases and status

## Scope and limits

Conclusions apply only to Aurora's own candidate space and the pandas/Pyodide runtime, not to
production DBMS engines. The dataset is synthetic (seeded, deterministic, NULL-free). Browser timers
are coarser than Node's, so the live Benchmark tab is for demonstration; the trained model and
reported results come from the Node calibration run. Unsupported SQL (outer joins, subqueries,
DISTINCT, LIMIT, window functions, NULL tests) is rejected with located diagnostics.
