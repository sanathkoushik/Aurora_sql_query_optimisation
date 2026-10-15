# Implementation phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Project scaffold (Vite, React, TypeScript, Vitest) | done |
| 2 | Compiler front end: DFA lexer, recursive-descent parser, semantic analyser, relational IR, candidate-plan generator | done |
| 3 | pandas code generation, deterministic dataset, Pyodide runtime, SQLite reference oracle (972/972 candidate checks pass) | done |
| 4 | Benchmark harness and measured dataset | todo |
| 5 | Offline training (scikit-learn Random Forest), JSON export, TypeScript inference | todo |
| 6 | Three selectors (rule-based, AI-assisted, predictor-guided) and held-out evaluation | todo |
| 7 | Query Inspector UI and live demo | todo |
