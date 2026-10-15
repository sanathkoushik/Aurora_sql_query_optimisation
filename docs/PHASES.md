# Implementation phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Project scaffold (Vite, React, TypeScript, Vitest) | done |
| 2 | Compiler front end: DFA lexer, recursive-descent parser, semantic analyser, relational IR, candidate-plan generator (58 tests) | done |
| 3 | pandas code generation, deterministic dataset, Pyodide runtime, SQLite oracle (972/972 candidate checks) | done |
| 4 | Benchmark harness and measured dataset (972 records, 0 failures, 12 min) | done |
| 5 | Offline training (Random Forest), JSON export, TypeScript inference with sklearn parity test | done |
| 6 | Three selectors and held-out evaluation with bootstrap CIs | done |
| 7 | Query Inspector UI and live demo, verified in Chrome (17 end-to-end checks) | done |
| — | Remaining toward 100%: live LLM evaluation of Mode B, fourth combined mode, larger query suite, final report write-up | not started |
