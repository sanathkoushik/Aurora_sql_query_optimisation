# Aurora – final results and discussion

BCSE307P Compiler Design Lab · VIT Vellore · Sanath M Koushik (24BCE2187), Tarun T S (24BCE2188) · Guide: Nithya K

All numbers come from `artifacts/` (measured, not estimated) and can be regenerated with the commands in section 7.

## 1. What was built

A compiler front end (DFA lexer → recursive-descent parser → semantic analysis → relational IR) for a SQL subset,
a candidate-plan generator (predicate push-down, projection pruning, join re-ordering; 3–24 verified-equivalent plans per
query), a pandas code generator executed through Pyodide in the browser or Node, a SQLite oracle that checks every
plan, and four plan-selection strategies compared on identical candidate sets:

| Mode | Strategy |
|---|---|
| A | Rule-based heuristics (R1–R4) |
| B | Analytical cost model, optionally re-ranked by an LLM (B0 = cost model alone) |
| C | Random-Forest runtime predictor trained on measured executions |
| D | Predictor shortlists the top 3 plans; an LLM chooses among them (fallback: Mode C) |

## 2. Method

* **Workload:** 32 query templates (4 families: filter-projection, join-filter, join-projection, group-aggregate) × 6 synthetic data
  profiles (small/medium/large × selective/broad) = 192 cases, 2052 candidate plans.
* **Correctness gate:** all 2052 candidate plans return the same rows as SQLite (`npm run validate`).
* **Measurement:** 2 warm-up + 9 timed runs per plan, median taken; Pyodide 0.27.8, Python 3.12.7, pandas 2.2.3; 33 min.
* **Split:** by query template (never by run): 16 train / 6 validation / 10 test. Hyper-parameters were chosen on validation only; the
  test set is reported once. The measured oracle is used for scoring only.
* **LLM:** `gemini-3.5-flash-lite` (free tier, temperature 0), used on the 60 test cases only; answers are cached for reproducibility.
  Gemma (`gemma-4-31b-it`) was tried first but returned persistent HTTP 500 errors on the long Mode B prompts, so it is not used in the reported run.
* **Metrics:** regret = measured time of the chosen plan ÷ fastest measured time (1.0 is ideal); oracle-hit = within 5% of fastest;
  paired bootstrap (4000 resamples) 95% CIs on mean-regret differences.

## 3. Results

### Table 4.4 – predictor accuracy on 10 unseen templates

| | Random Forest | Median-runtime baseline |
|---|---|---|
| MAE (ms) | 8.92 | 33.45 |
| RMSE (ms) | 13.96 | 53.89 |
| Q-error median / p90 | 1.22 / 1.84 | 2.32 / 5.50 |

Leave-one-template-out over all 32 templates: mean MAE 6.68 ms (baseline 26.23 ms), median Q-error 1.21 (baseline 2.48).

### Table 4.3 – plan selection on the 60 held-out cases

| Strategy | Median regret (95% CI) | Oracle-hit % | Decision latency (ms) |
|---|---|---|---|
| A. Rule-based | 1.108 (1.079–1.147) | 23.3 | 0.08 |
| B0. Cost model only | 1.085 (1.067–1.132) | 28.3 | 0.45 |
| B. Cost model + LLM | 1.089 (1.068–1.132) | 28.3 | 1.29 (excludes API time) |
| C. Predictor-guided | **1.041 (1.010–1.092)** | **51.7** | 0.74 |
| D. Predictor top-3 + LLM | 1.052 (1.012–1.091) | 50.0 | 1.35 (excludes API time) |

Decision latency for B and D is measured on cached answers; a live API call adds several seconds.

Paired mean-regret differences (positive = first is worse):

| Comparison | Diff [95% CI] | Verdict |
|---|---|---|
| A − C | 0.049 [0.010, 0.088] | C better |
| B0 − C | 0.036 [0.001, 0.075] | C better |
| B − C | 0.037 [0.003, 0.075] | C better |
| D − B | −0.035 [−0.071, −0.001] | D better |
| D − A | −0.046 [−0.084, −0.006] | D better |
| A − B0 | 0.013 [−0.015, 0.039] | inconclusive |
| B − B0 | 0.001 [−0.002, 0.005] | inconclusive |
| D − C | 0.003 [−0.019, 0.023] | inconclusive |

LLM behaviour: all 120 calls (60 for Mode B, 60 for Mode D) returned a valid answer, with 0 fallbacks and 0 retries. In Mode B the LLM
agreed with the cost model in 58 of 60 cases (its rationale cites the cost estimates). In Mode D it overrode the predictor in 15 of 60
cases, with no net change in regret.

## 4. Research questions

* **RQ1 – Can a runtime predictor estimate plan runtimes better than a naive baseline?** Yes: MAE 8.9 vs 33.4 ms and median
  Q-error 1.22 vs 2.32 on templates it never saw.
* **RQ2 – Does predictor-guided selection beat rule-based selection?** Yes in this setting: regret 1.041 vs 1.108 and oracle-hit
  51.7% vs 23.3%, with a paired CI that excludes 0. (With only 16 templates the earlier study was inconclusive; the larger suite
  gave enough power to detect the difference.)
* **RQ3 – Does it beat the analytical cost model with an LLM?** Yes (B − C CI excludes 0). A free-tier LLM added no measurable value
  over the cost model it was shown.
* **RQ4 – Does combining the predictor with an LLM help?** Not measurably: D is statistically tied with C. It is better than A and B only
  because C is. Its extra latency buys nothing here.
* **RQ5 – Is the predictor stable across templates?** In leave-one-template-out, the model's MAE is below the baseline's on all 32
  templates, and selection median regret is at most 1.10 on 26 of 32. The worst are j3 (1.23), q5 (1.18), q15 (1.17), q10 (1.16) and q4 (1.14).

## 5. Discussion

Accurate cost prediction translated into better plan choice here, unlike the finding of Heinrich et al. (SIGMOD 2025) for learned
cost models inside full DBMS optimizers. The difference is plausible: Aurora's candidate space is small, there is a single pandas
engine that the model was calibrated on, and the data are synthetic. The LLM contributes rationales and a safe interface, but not
better plans: it mostly echoes the cost estimates it is given. Mode D's safety design (LLM confined to a verified shortlist,
deterministic fallback) means a bad or missing answer cannot cause an incorrect plan, which is useful even though no accuracy gain was found.

## 6. Threats to validity

* Single hardware/runtime (Pyodide on Node, WebAssembly). The run-to-run spread of a single timed run has a median of 53% (p90 109%), so
  small regret differences cannot be resolved per case; conclusions rest on 60 cases and the bootstrap.
* Synthetic, NULL-free, seeded data; three tables; SQL subset without outer joins, subqueries, DISTINCT, LIMIT or window functions.
* The LLM result is specific to `gemini-3.5-flash-lite` with one prompt design at temperature 0; a stronger model or a prompt with
  runtime hints might behave differently.
* Test templates were fixed before measurement, but templates in the same family are similar; generalisation to unseen families is untested.
* Conclusions concern Aurora's candidate space, not production DBMS optimizers.

## 7. Reproduction

```bash
npm install
npm test && npm run validate                       # 116 tests, 2052/2052 plans equal to SQLite
npm run benchmark && npm run train                 # ~33 min + ~1 min
GEMINI_API_KEY=... npm run evaluate                # without a key it reuses artifacts/results/llm_cache.json
npm run build && npx tsx scripts/e2e.ts            # 17 real-Chrome checks
```
