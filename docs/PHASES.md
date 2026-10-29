# Implementation phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Project scaffold (Vite, React, TypeScript, Vitest) | done |
| 2 | Compiler front end: DFA lexer, recursive-descent parser, semantic analyser, relational IR, candidate-plan generator (58 tests) | done |
| 3 | pandas code generation, deterministic dataset, Pyodide runtime, SQLite oracle (2052/2052 candidate checks) | done |
| 4 | Benchmark harness and measured dataset (2052 records over 32 templates, 0 failures, 33 min) | done |
| 5 | Offline training (Random Forest), JSON export, TypeScript inference with sklearn parity test | done |
| 6 | Three selectors and held-out evaluation with bootstrap CIs | done |
| 7 | Query Inspector UI and live demo, verified in Chrome (17 end-to-end checks) | done |
| 8 | Larger query suite (16 → 32 templates, 10 held-out test templates), benchmark and model re-run | done |
| 9 | Mode D: predictor shortlist + LLM arbitration, with safe fallback; Gemini/Gemma client | done |
| 10 | Live LLM evaluation of Modes B and D (60 test cases, free-tier API, cached for reproducibility) | done |
| 11 | Final report, presentation guide, refreshed docs and screenshots | done |
