# Aurora evaluation results

Generated 2026-10-29T17:12:53.511Z from `artifacts/benchmark` (2052 candidate records, 0 failed/inequivalent, 2 warm-up + 9 timed runs each) in `pyodide-0.27.8/node-v24.13.0/python-3.12.7/pandas-2.2.3/numpy-2.0.2`.

LLM: **gemini-3.5-flash-lite** via Google Generative Language API (free tier), consulted by Modes B and D on the held-out test cases only (44 live calls, 76 cache hits, 0 retries). Mode B0 is the cost model alone.

## Table 4.3 – Selector comparison on held-out test templates (60 cases: j2, p2, g1, g4, q2, q5, q8, q12, q14, q16 × 6 data profiles)

| Strategy | Median selected runtime (ms) | Median regret (95% bootstrap CI) | Oracle-hit rate (%, ≤5% of fastest) | Median decision latency (ms) | Result failures |
|---|---|---|---|---|---|
| A. Rule-based | 22.928 | 1.108 (1.079–1.147) | 23.3 | 0.079 | 0 |
| B0. Cost model only | 23.670 | 1.085 (1.067–1.132) | 28.3 | 0.451 | 0 |
| B. AI-assisted (gemini-3.5-flash-lite) | 23.670 | 1.089 (1.068–1.132) | 28.3 | 1.288 | 0 |
| C. Predictor-guided | 23.956 | 1.041 (1.010–1.092) | 51.7 | 0.742 | 0 |
| D. Combined predictor + LLM (gemini-3.5-flash-lite) | 24.535 | 1.052 (1.012–1.091) | 50.0 | 1.354 | 0 |

LLM behaviour on the 60 test cases: Mode B answered validly 60 times (0 fallbacks) and chose a plan different from the cost model in 2; Mode D answered validly 60 times (0 fallbacks) and overrode the predictor in 15.

Paired mean-regret differences (bootstrap 95% CI):

- A − C: 0.0488 [0.0104, 0.0878] → **C better than A**
- B0 − C: 0.0362 [0.0006, 0.0748] → **C better than B0**
- A − B0: 0.0126 [-0.0151, 0.0393] → **inconclusive (CI includes 0)**
- B − B0: 0.0011 [-0.0017, 0.0050] → **inconclusive (CI includes 0)**
- B − C: 0.0373 [0.0027, 0.0753] → **C better than B**
- D − C: 0.0028 [-0.0187, 0.0232] → **inconclusive (CI includes 0)**
- D − B: -0.0345 [-0.0705, -0.0013] → **D better than B**
- D − A: -0.0460 [-0.0839, -0.0062] → **D better than A**

Run-to-run variation of a single timed run: median relative spread (max−min)/median = 52.8%, p90 = 109.0%. Differences smaller than this are not distinguishable from noise.

## Table 4.4 – Predictor validation

| Measure | Predictor | Median-runtime baseline |
|---|---|---|
| Held-out test MAE (ms) | 8.917 | 33.446 |
| Held-out test RMSE (ms) | 13.964 | 53.886 |
| Q-error median / p90 | 1.22 / 1.84 | 2.32 / 5.50 |
| Validation MAE (ms) | 9.515 | 29.717 |
| Train / validation / test templates | 16 / 6 / 10 | |
| Train / validation / test records | 828 / 450 / 774 | |
| Calibration wall-clock | 33.2 min | |
| Model version / feature schema | aurora-rf-v1 / aurora-runtime-features-v1 | |

## RQ5 – Leave-one-template-out stability

Mean MAE over the 16 held-out templates: model 6.677 ms vs baseline 26.228 ms; median-of-median Q-error: model 1.21 vs baseline 2.48; median selection regret across templates: 1.051.

| Held-out template | Model MAE (ms) | Baseline MAE (ms) | Model Q-err (median) | Selection median regret |
|---|---|---|---|---|
| f1 | 1.618 | 21.562 | 1.40 | 1.000 |
| f2 | 3.648 | 16.311 | 1.22 | 1.010 |
| f3 | 1.054 | 23.272 | 1.41 | 1.000 |
| g1 | 3.530 | 23.993 | 1.13 | 1.061 |
| g2 | 15.607 | 27.100 | 1.57 | 1.038 |
| g3 | 4.414 | 31.683 | 1.12 | 1.052 |
| g4 | 12.574 | 41.166 | 1.19 | 1.036 |
| g5 | 8.218 | 27.759 | 1.20 | 1.038 |
| g6 | 4.213 | 27.296 | 1.07 | 1.000 |
| j1 | 4.568 | 23.440 | 1.24 | 1.000 |
| j2 | 8.600 | 27.550 | 1.25 | 1.051 |
| j3 | 3.203 | 19.545 | 1.18 | 1.232 |
| j4 | 7.052 | 21.206 | 1.17 | 1.091 |
| j5 | 4.081 | 21.887 | 1.18 | 1.042 |
| p1 | 3.573 | 26.367 | 1.12 | 1.050 |
| p2 | 17.615 | 47.662 | 1.37 | 1.026 |
| q1 | 1.883 | 21.242 | 1.37 | 1.000 |
| q10 | 4.925 | 41.358 | 1.13 | 1.163 |
| q11 | 11.225 | 16.202 | 1.38 | 1.012 |
| q12 | 8.243 | 31.779 | 1.18 | 1.096 |
| q13 | 4.075 | 19.342 | 1.18 | 1.014 |
| q14 | 13.921 | 49.194 | 1.31 | 1.099 |
| q15 | 5.476 | 23.609 | 1.17 | 1.170 |
| q16 | 4.790 | 21.011 | 1.20 | 1.095 |
| q2 | 3.084 | 16.289 | 1.32 | 1.054 |
| q3 | 0.657 | 23.764 | 1.17 | 1.000 |
| q4 | 7.384 | 24.019 | 1.31 | 1.135 |
| q5 | 8.234 | 21.566 | 1.41 | 1.184 |
| q6 | 5.058 | 25.302 | 1.26 | 1.084 |
| q7 | 13.684 | 35.094 | 1.34 | 1.062 |
| q8 | 11.690 | 23.653 | 1.45 | 1.000 |
| q9 | 5.773 | 18.082 | 1.20 | 1.108 |

## Supplementary – A vs B on all 192 cases (no learning involved)

| Strategy | Median selected runtime (ms) | Median regret | Oracle-hit rate (%) |
|---|---|---|---|
| A. Rule-based | 18.227 | 1.099 | 33.3 |
| B0. Cost model only | 17.331 | 1.089 | 36.5 |

Paired A − B mean regret: 0.0088 [-0.0077, 0.0263] → **inconclusive (CI includes 0)**

## Scope and limits

- Measurements are from the pandas/Pyodide runtime on Node and apply only to the candidate space Aurora generates; they do not generalise to production DBMS engines.
- The test set is small (few templates × 6 profiles); confidence intervals are wide and "inconclusive" is a legitimate outcome.
- The oracle (fastest measured plan) is used only for scoring.
