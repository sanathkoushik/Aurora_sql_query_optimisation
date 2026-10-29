# Aurora – presentation guide

## 60-second pitch

Aurora is a small query compiler that shows every step of optimising a SQL query (lexer, parser, semantic analysis, relational IR,
candidate plans), then compares four ways of choosing the plan: rules, a cost model plus an LLM, a Random-Forest runtime predictor,
and a predictor-plus-LLM combination. Every plan is checked against SQLite, and every claim comes from measured runs: 32 query templates,
2052 plans, 33 minutes of benchmarking. Result: the predictor picks clearly better plans than rules or an LLM, and the LLM adds nothing measurable.

## Suggested slide order

1. Problem: many equivalent plans, which is fastest? (`docs/screenshots/05-candidates.png`)
2. Pipeline (`docs/ARCHITECTURE.md`): lexer → parser → semantic → IR → candidates → pandas → SQLite check
3. Four selection modes (README table)
4. Method: template-level train/validation/test split, measured oracle only for scoring
5. Table 4.4: predictor accuracy (MAE 8.9 vs 33.4 ms)
6. Table 4.3: selection results (regret and oracle-hit)
7. Statistical verdicts (paired bootstrap): C beats A and B; D ≈ C
8. Honest limits and threats to validity (`docs/REPORT.md` section 6)
9. Live demo
10. Conclusion and future work

## Live demo script (about 4 minutes)

Run `npm run dev` (needs internet once for the Pyodide CDN; wait for the green "Pyodide" pill).

1. **Compiler tab:** example `g1`. Show tokens, AST, the semantic error with a suggestion (change `c.region` to `c.regoin`), and the IR tree.
2. **Candidate plans:** 12 plans, each with its transformations and the generated pandas code.
3. **Selector modes:** four cards (A, B, C, D) choose plans. Click *Run* on one to show the rows.
4. **Optional LLM:** paste a free Google AI Studio key into the key box (provider "Google Gemini", model `gemini-3.5-flash-lite`). Modes B and D now say `llm (...)`.
   If the network fails, the cards say "fallback" instead of crashing. This is the safety design.
5. **Benchmark → Comparison:** measure all plans in the browser; show the regret of each mode against the fastest plan.
6. **Held-out evaluation:** the offline Tables 4.3 and 4.4 with confidence intervals.

## Likely viva questions

* **Why is the oracle not an input?** It is the fastest measured plan and is used only to score choices.
* **How do you prevent leakage?** The split is by query template, fixed in `src/data/workloads.ts` before measurement; the script asserts no template appears in two splits.
* **How do you know the optimised plans are correct?** All 2052 candidates are compared with SQLite on every data profile (`npm run validate`).
* **Why did the LLM not help?** It was shown the cost-model estimates and agreed with them in 58 of 60 cases; the cost model itself is only slightly better than the rules.
* **Did the LLM ever break anything?** No: it can only choose a listed candidate, and any invalid answer falls back to the cost model or predictor. 0 fallbacks occurred in 120 calls.
* **Which model and was it free?** `gemini-3.5-flash-lite` on the Google AI Studio free tier. Gemma was tried but returned HTTP 500 on long prompts.
* **Is the result general?** No: it applies to Aurora's candidate space on pandas/Pyodide with synthetic data, not to production DBMSs.
* **Why did the earlier 16-template study say "inconclusive"?** Too few test cases (24); with 60 cases the difference became detectable.
* **Which paper is most related?** Heinrich et al., "How good are learned cost models, really?" (SIGMOD 2025).

## Numbers to remember

| Item | Value |
|---|---|
| Templates / profiles / plans | 32 / 6 / 2052 (all equal to SQLite) |
| Train / validation / test templates | 16 / 6 / 10 |
| Predictor MAE vs baseline | 8.9 ms vs 33.4 ms |
| Median regret A / B / C / D | 1.108 / 1.089 / 1.041 / 1.052 |
| Oracle-hit A / B / C / D | 23% / 28% / 52% / 50% |
| Tests / end-to-end checks | 116 / 17 |
