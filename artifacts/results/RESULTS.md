# Aurora evaluation results

Generated 2026-10-15T17:30:52.685Z from `artifacts/benchmark` (972 candidate records, 0 failed/inequivalent, 2 warm-up + 9 timed runs each) in `pyodide-0.27.8/node-v24.13.0/python-3.12.7/pandas-2.2.3/numpy-2.0.2`.

Mode B **used the analytical cost model only (no LLM key configured for this run)**.

## Table 4.3 – Selector comparison on held-out test templates (24 cases: j2, p2, g1, g4 × 6 data profiles)

| Strategy | Median selected runtime (ms) | Median regret (95% bootstrap CI) | Oracle-hit rate (%, ≤5% of fastest) | Median decision latency (ms) | Result failures |
|---|---|---|---|---|---|
| A. Rule-based | 19.174 | 1.029 (1.017–1.109) | 62.5 | 0.026 | 0 |
| B. Existing AI-assisted (cost model only) | 17.847 | 1.027 (1.010–1.121) | 62.5 | 0.160 | 0 |
| C. Predictor-guided | 19.164 | 1.023 (1.009–1.046) | 70.8 | 0.237 | 0 |

Paired mean-regret differences (bootstrap 95% CI):

- A − C: 0.0081 [-0.0222, 0.0379] → **inconclusive (CI includes 0)**
- B − C: 0.0074 [-0.0580, 0.0641] → **inconclusive (CI includes 0)**
- A − B: 0.0007 [-0.0445, 0.0558] → **inconclusive (CI includes 0)**

Run-to-run variation of a single timed run: median relative spread (max−min)/median = 35.9%, p90 = 94.0%. Differences smaller than this are not distinguishable from noise.

## Table 4.4 – Predictor validation

| Measure | Predictor | Median-runtime baseline |
|---|---|---|
| Held-out test MAE (ms) | 8.172 | 19.271 |
| Held-out test RMSE (ms) | 14.721 | 32.628 |
| Q-error median / p90 | 1.23 / 1.54 | 1.70 / 4.26 |
| Validation MAE (ms) | 5.675 | 12.859 |
| Train / validation / test templates | 9 / 3 / 4 | |
| Train / validation / test records | 486 / 162 / 324 | |
| Calibration wall-clock | 12.0 min | |
| Model version / feature schema | aurora-rf-v1 / aurora-runtime-features-v1 | |

## RQ5 – Leave-one-template-out stability

Mean MAE over the 16 held-out templates: model 5.951 ms vs baseline 15.496 ms; median-of-median Q-error: model 1.18 vs baseline 1.98; median selection regret across templates: 1.019.

| Held-out template | Model MAE (ms) | Baseline MAE (ms) | Model Q-err (median) | Selection median regret |
|---|---|---|---|---|
| f1 | 2.308 | 15.517 | 1.19 | 1.000 |
| f2 | 3.489 | 9.234 | 1.12 | 1.000 |
| f3 | 0.954 | 16.736 | 1.27 | 1.000 |
| g1 | 3.482 | 12.376 | 1.14 | 1.030 |
| g2 | 13.698 | 14.870 | 1.72 | 1.022 |
| g3 | 14.128 | 25.439 | 1.24 | 1.004 |
| g4 | 11.870 | 21.771 | 1.27 | 1.044 |
| g5 | 7.293 | 14.024 | 1.28 | 1.017 |
| g6 | 6.855 | 13.808 | 1.17 | 1.013 |
| j1 | 2.723 | 13.017 | 1.13 | 1.040 |
| j2 | 4.150 | 15.178 | 1.17 | 1.012 |
| j3 | 4.172 | 11.055 | 1.19 | 1.048 |
| j4 | 4.386 | 11.352 | 1.18 | 1.051 |
| j5 | 3.814 | 11.711 | 1.18 | 1.035 |
| p1 | 2.638 | 14.197 | 1.10 | 1.029 |
| p2 | 9.250 | 27.651 | 1.26 | 1.015 |

## Supplementary – A vs B on all 96 cases (no learning involved)

| Strategy | Median selected runtime (ms) | Median regret | Oracle-hit rate (%) |
|---|---|---|---|
| A. Rule-based | 13.811 | 1.035 | 58.3 |
| B. Cost model only | 13.668 | 1.027 | 66.7 |

Paired A − B mean regret: 0.0126 [-0.0081, 0.0364] → **inconclusive (CI includes 0)**

## Scope and limits

- Measurements are from the pandas/Pyodide runtime on Node and apply only to the candidate space Aurora generates; they do not generalise to production DBMS engines.
- The test set is small (few templates × 6 profiles); confidence intervals are wide and "inconclusive" is a legitimate outcome.
- The oracle (fastest measured plan) is used only for scoring.
