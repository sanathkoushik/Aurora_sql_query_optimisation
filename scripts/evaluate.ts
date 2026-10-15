/**
 * Controlled comparison of the three selectors (Tables 4.3 / 4.4 of the report).
 *
 * All three selectors receive the SAME valid candidate set per case and are scored against the
 * runtimes measured by `npm run benchmark` (the oracle is used for scoring only, never as input).
 * Predictor results are reported on held-out TEST templates only; the model was never trained on
 * them. Output: artifacts/results/evaluation.json and artifacts/results/RESULTS.md.
 *
 *   npm run evaluate          (needs artifacts/benchmark/* and artifacts/model/*)
 *
 * If ANTHROPIC_API_KEY is set, Mode B also consults the LLM; otherwise Mode B is the analytical
 * cost model alone and the output says so.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '../src/compiler';
import { WORKLOADS } from '../src/data/workloads';
import { ForestModel } from '../src/predictor/forest';
import { LlmConfig, anthropicClient, selectAIAssisted } from '../src/selectors/aiAssisted';
import { selectPredictorGuided } from '../src/selectors/predictorGuided';
import { selectRuleBased } from '../src/selectors/ruleBased';
import { SelectionResult, SelectorMode } from '../src/selectors/types';
import { DataProfile } from '../src/runtime/runtime';
import { ROOT, createNodeRuntime } from './lib/nodeRuntime';

interface BenchRecord {
  query_template_id: string; split: string; data_profile_id: string; candidate_id: string;
  runtime_ms_median: number | null; run_times_ms: number[]; status: string; result_equivalent: boolean;
}

const HIT_TOLERANCE = 1.05; // a pick counts as "the fastest" when within 5% of the fastest measured plan
const read = <T>(p: string): T => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as T;

const records = readFileSync(join(ROOT, 'artifacts/benchmark/records.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l) as BenchRecord);
const meta = read<{ environment_id: string; calibration_wall_clock_seconds: number; timed_repetitions: number; warmup_runs: number; failed_records: number; records: number }>('artifacts/benchmark/meta.json');
const model = read<ForestModel>('artifacts/model/aurora_rf_v1.json');
const train = read<any>('artifacts/model/train_report.json');

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const percentile = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function rng(seed: number) { // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function bootstrapCI(values: number[], stat: (xs: number[]) => number, iters = 4000): [number, number] {
  const r = rng(20260101);
  const out: number[] = [];
  for (let i = 0; i < iters; i++) out.push(stat(values.map(() => values[Math.floor(r() * values.length)])));
  return [percentile(out, 0.025), percentile(out, 0.975)];
}

// ---- LLM (optional) ------------------------------------------------------------------------
let llm: LlmConfig | undefined;
if (process.env.ANTHROPIC_API_KEY) {
  const modelName = process.env.AURORA_LLM_MODEL ?? 'claude-sonnet-5-5';
  llm = { client: anthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY, model: modelName }), modelName, timeoutMs: 30_000 };
}

// ---- cases -----------------------------------------------------------------------------------
interface CaseResult {
  template: string; profile: string; split: string; candidates: number; oracleMs: number; oracleId: string;
  picks: Record<SelectorMode, { id: string; ms: number | null; regret: number | null; hit: boolean; latencyMs: number; source: string; failure: boolean }>;
  predictedMs: Record<string, number>; measuredMs: Record<string, number>;
}

const rt = await createNodeRuntime();
const profiles: Record<string, DataProfile> = {};
const cases: CaseResult[] = [];

for (const w of WORKLOADS) {
  const q = compile(w.sql);
  const profileIds = [...new Set(records.filter((r) => r.query_template_id === w.id).map((r) => r.data_profile_id))];
  for (const pid of profileIds) {
    profiles[pid] ??= rt.loadProfile(pid);
    const profile = profiles[pid];
    const recs = records.filter((r) => r.query_template_id === w.id && r.data_profile_id === pid);
    const measured: Record<string, number> = {};
    for (const r of recs) if (r.status === 'ok' && r.result_equivalent && r.runtime_ms_median !== null) measured[r.candidate_id] = r.runtime_ms_median;
    // the common candidate pool: valid AND verified equivalent AND measured
    const pool = q.candidates.filter((c) => c.validity.valid && c.id in measured);
    if (pool.length < 2) continue; // nothing to choose between
    const oracleMs = Math.min(...pool.map((c) => measured[c.id]));
    const oracleId = pool.find((c) => measured[c.id] === oracleMs)!.id;

    const results: Record<SelectorMode, SelectionResult> = {
      A: selectRuleBased(q, pool),
      B: await selectAIAssisted(q, profile, llm, pool),
      C: selectPredictorGuided(q, profile, model, pool),
    };
    const picks = {} as CaseResult['picks'];
    for (const m of ['A', 'B', 'C'] as SelectorMode[]) {
      const r = results[m];
      const ms = measured[r.selectedId] ?? null;
      picks[m] = {
        id: r.selectedId, ms, regret: ms === null ? null : ms / oracleMs,
        hit: ms !== null && ms <= oracleMs * HIT_TOLERANCE, latencyMs: r.latencyMs, source: r.source, failure: ms === null,
      };
    }
    cases.push({
      template: w.id, profile: pid, split: w.split, candidates: pool.length, oracleMs, oracleId, picks,
      predictedMs: (results.C as any).predictedMs ?? {}, measuredMs: measured,
    });
  }
}

// ---- aggregation -----------------------------------------------------------------------------
function summarize(cs: CaseResult[], mode: SelectorMode) {
  const regrets = cs.map((c) => c.picks[mode].regret).filter((x): x is number => x !== null);
  const runtimes = cs.map((c) => c.picks[mode].ms).filter((x): x is number => x !== null);
  return {
    cases: cs.length,
    median_selected_runtime_ms: median(runtimes),
    median_regret: median(regrets),
    median_regret_ci95: bootstrapCI(regrets, median),
    mean_regret: regrets.reduce((a, b) => a + b, 0) / regrets.length,
    oracle_hit_rate_pct: (100 * cs.filter((c) => c.picks[mode].hit).length) / cs.length,
    median_decision_latency_ms: median(cs.map((c) => c.picks[mode].latencyMs)),
    result_failures: cs.filter((c) => c.picks[mode].failure).length,
    sources: [...new Set(cs.map((c) => c.picks[mode].source))],
  };
}

/** Paired comparison of mean regret: positive diff means `a` is worse (higher regret) than `b`. */
function paired(cs: CaseResult[], a: SelectorMode, b: SelectorMode) {
  const diffs = cs.map((c) => (c.picks[a].regret ?? NaN) - (c.picks[b].regret ?? NaN)).filter((x) => !Number.isNaN(x));
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const [lo, hi] = bootstrapCI(diffs, mean);
  const verdict = lo > 0 ? `${b} better than ${a}` : hi < 0 ? `${a} better than ${b}` : 'inconclusive (CI includes 0)';
  return { a, b, mean_regret_diff: mean(diffs), ci95: [lo, hi] as [number, number], verdict };
}

const testCases = cases.filter((c) => c.split === 'test');
const noise = (() => { // run-to-run variation: median relative spread (max-min)/median of the 9 timed runs
  const spreads = records.filter((r) => r.status === 'ok' && r.run_times_ms.length > 1)
    .map((r) => (Math.max(...r.run_times_ms) - Math.min(...r.run_times_ms)) / median(r.run_times_ms));
  return { median_relative_spread: median(spreads), p90_relative_spread: percentile(spreads, 0.9) };
})();

const evaluation = {
  generated_at: new Date().toISOString(),
  environment_id: meta.environment_id,
  hit_tolerance: HIT_TOLERANCE,
  llm_used: !!llm,
  test: { A: summarize(testCases, 'A'), B: summarize(testCases, 'B'), C: summarize(testCases, 'C'), paired: [paired(testCases, 'A', 'C'), paired(testCases, 'B', 'C'), paired(testCases, 'A', 'B')] },
  all_cases_A_vs_B: { A: summarize(cases, 'A'), B: summarize(cases, 'B'), paired: paired(cases, 'A', 'B') },
  noise,
  cases,
};
mkdirSync(join(ROOT, 'artifacts/results'), { recursive: true });
writeFileSync(join(ROOT, 'artifacts/results/evaluation.json'), JSON.stringify(evaluation, null, 2) + '\n');

// ---- markdown tables --------------------------------------------------------------------------
const f = (x: number, d = 3) => x.toFixed(d);
const row = (name: string, s: ReturnType<typeof summarize>) =>
  `| ${name} | ${f(s.median_selected_runtime_ms)} | ${f(s.median_regret)} (${f(s.median_regret_ci95[0])}–${f(s.median_regret_ci95[1])}) | ${f(s.oracle_hit_rate_pct, 1)} | ${f(s.median_decision_latency_ms)} | ${s.result_failures} |`;
const T = evaluation.test;
const ts = train.test_scores, vs = train.validation_scores;
const md: string[] = [];
md.push('# Aurora evaluation results', '');
md.push(`Generated ${evaluation.generated_at} from \`artifacts/benchmark\` (${meta.records} candidate records, ${meta.failed_records} failed/inequivalent, ${meta.warmup_runs} warm-up + ${meta.timed_repetitions} timed runs each) in \`${meta.environment_id}\`.`);
md.push('', 'Mode B ' + (evaluation.llm_used ? 'consulted the LLM.' : '**used the analytical cost model only (no LLM key configured for this run)**.'), '');
md.push(`## Table 4.3 – Selector comparison on held-out test templates (${testCases.length} cases: ${[...new Set(testCases.map((c) => c.template))].join(', ')} × ${[...new Set(testCases.map((c) => c.profile))].length} data profiles)`, '');
md.push('| Strategy | Median selected runtime (ms) | Median regret (95% bootstrap CI) | Oracle-hit rate (%, ≤5% of fastest) | Median decision latency (ms) | Result failures |', '|---|---|---|---|---|---|');
md.push(row('A. Rule-based', T.A), row('B. Existing AI-assisted' + (evaluation.llm_used ? '' : ' (cost model only)'), T.B), row('C. Predictor-guided', T.C), '');
md.push('Paired mean-regret differences (bootstrap 95% CI):', '');
for (const p of T.paired) md.push(`- ${p.a} − ${p.b}: ${f(p.mean_regret_diff, 4)} [${f(p.ci95[0], 4)}, ${f(p.ci95[1], 4)}] → **${p.verdict}**`);
md.push('', `Run-to-run variation of a single timed run: median relative spread (max−min)/median = ${f(noise.median_relative_spread * 100, 1)}%, p90 = ${f(noise.p90_relative_spread * 100, 1)}%. Differences smaller than this are not distinguishable from noise.`, '');
md.push('## Table 4.4 – Predictor validation', '', '| Measure | Predictor | Median-runtime baseline |', '|---|---|---|');
md.push(`| Held-out test MAE (ms) | ${f(ts.model.mae_ms)} | ${f(ts.baseline_median.mae_ms)} |`);
md.push(`| Held-out test RMSE (ms) | ${f(ts.model.rmse_ms)} | ${f(ts.baseline_median.rmse_ms)} |`);
md.push(`| Q-error median / p90 | ${f(ts.model.q_error_median, 2)} / ${f(ts.model.q_error_p90, 2)} | ${f(ts.baseline_median.q_error_median, 2)} / ${f(ts.baseline_median.q_error_p90, 2)} |`);
md.push(`| Validation MAE (ms) | ${f(vs.model.mae_ms)} | ${f(vs.baseline_median.mae_ms)} |`);
md.push(`| Train / validation / test templates | ${train.split.train.templates.length} / ${train.split.validation.templates.length} / ${train.split.test.templates.length} | |`);
md.push(`| Train / validation / test records | ${train.split.train.records} / ${train.split.validation.records} / ${train.split.test.records} | |`);
md.push(`| Calibration wall-clock | ${f(meta.calibration_wall_clock_seconds / 60, 1)} min | |`);
md.push(`| Model version / feature schema | ${train.model_version} / ${train.schema_version} | |`, '');
const lo = train.leave_one_template_out.summary;
md.push('## RQ5 – Leave-one-template-out stability', '', `Mean MAE over the 16 held-out templates: model ${f(lo.model_mae_ms_mean)} ms vs baseline ${f(lo.baseline_mae_ms_mean)} ms; median-of-median Q-error: model ${f(lo.model_q_median_of_medians, 2)} vs baseline ${f(lo.baseline_q_median_of_medians, 2)}; median selection regret across templates: ${f(lo.median_regret_median_over_templates, 3)}.`, '');
md.push('| Held-out template | Model MAE (ms) | Baseline MAE (ms) | Model Q-err (median) | Selection median regret |', '|---|---|---|---|---|');
for (const r of train.leave_one_template_out.per_template) {
  md.push(`| ${r.template} | ${f(r.model.mae_ms)} | ${f(r.baseline_median.mae_ms)} | ${f(r.model.q_error_median, 2)} | ${f(r.selection_model.median_regret)} |`);
}
const A_all = evaluation.all_cases_A_vs_B;
md.push('', `## Supplementary – A vs B on all ${cases.length} cases (no learning involved)`, '', '| Strategy | Median selected runtime (ms) | Median regret | Oracle-hit rate (%) |', '|---|---|---|---|');
md.push(`| A. Rule-based | ${f(A_all.A.median_selected_runtime_ms)} | ${f(A_all.A.median_regret)} | ${f(A_all.A.oracle_hit_rate_pct, 1)} |`);
md.push(`| B. ${evaluation.llm_used ? 'AI-assisted' : 'Cost model only'} | ${f(A_all.B.median_selected_runtime_ms)} | ${f(A_all.B.median_regret)} | ${f(A_all.B.oracle_hit_rate_pct, 1)} |`);
md.push('', `Paired A − B mean regret: ${f(A_all.paired.mean_regret_diff, 4)} [${f(A_all.paired.ci95[0], 4)}, ${f(A_all.paired.ci95[1], 4)}] → **${A_all.paired.verdict}**`, '');
md.push('## Scope and limits', '', '- Measurements are from the pandas/Pyodide runtime on Node and apply only to the candidate space Aurora generates; they do not generalise to production DBMS engines.', '- The test set is small (few templates × 6 profiles); confidence intervals are wide and "inconclusive" is a legitimate outcome.', '- The oracle (fastest measured plan) is used only for scoring.', '');
writeFileSync(join(ROOT, 'artifacts/results/RESULTS.md'), md.join('\n'));
console.log(md.join('\n'));
