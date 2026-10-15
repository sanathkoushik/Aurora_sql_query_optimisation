/**
 * Calibration run: executes every valid candidate plan of every workload on every data profile,
 * verifies result equivalence against SQLite, times the survivors (warm-up excluded, interleaved
 * repetitions) and writes one JSON-Lines record per candidate (Appendix B of the report).
 *
 *   npm run benchmark [-- --profiles=small_selective --reps=9 --warmup=2 --out=artifacts/benchmark]
 *
 * Nothing in the output is synthetic: every runtime comes from time.perf_counter_ns around the
 * generated pandas plan inside Pyodide. Failed or inequivalent candidates are kept (with the
 * failure reason) but carry no runtime label.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '../src/compiler';
import { PROFILE_IDS, WORKLOADS } from '../src/data/workloads';
import { FEATURE_SCHEMA_VERSION, extractFeatures } from '../src/predictor/features';
import { candidateCodes, orderPositions } from '../src/runtime/plan';
import { ROOT, createNodeRuntime } from './lib/nodeRuntime';

const opt = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;

const profiles = opt('profiles', PROFILE_IDS.join(',')).split(',');
const reps = Number(opt('reps', '9'));
const warmup = Number(opt('warmup', '2'));
const outDir = join(ROOT, opt('out', 'artifacts/benchmark'));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

mkdirSync(outDir, { recursive: true });
const wallStart = Date.now();
const rt = await createNodeRuntime();
const env = rt.environment();
const environmentId = `pyodide-0.27.8/node-${process.version}/python-${env.python}/pandas-${env.pandas}/numpy-${env.numpy}`;
console.log('environment:', environmentId);

const records: unknown[] = [];
let failures = 0;
const perProfileSeconds: Record<string, number> = {};

for (const profileId of profiles) {
  const tProfile = Date.now();
  const profile = rt.loadProfile(profileId);
  for (const w of WORKLOADS) {
    const q = compile(w.sql);
    const codes = candidateCodes(q);
    const verify = rt.verify(codes, w.sql, orderPositions(q.bound));
    if (verify.reference_error) throw new Error(`reference engine failed on ${w.id}: ${verify.reference_error}`);

    const timeable = Object.fromEntries(Object.entries(codes).filter(([id]) => verify.results[id]?.equivalent));
    const timings = rt.timeCandidates(timeable, warmup, reps);

    for (const c of q.candidates) {
      const v = verify.results[c.id];
      const t = timings[c.id];
      const ok = !!v?.equivalent && !!t && t.error === null && t.times_ms.length === reps;
      if (!ok) failures++;
      records.push({
        schema_version: FEATURE_SCHEMA_VERSION,
        query_template_id: w.id,
        split: w.split,
        data_profile_id: profileId,
        candidate_id: c.id,
        plan_fingerprint: c.fingerprint,
        plan_signature: c.signature,
        features: extractFeatures(c.plan, q.bound, profile),
        run_times_ms: ok ? t.times_ms : [],
        runtime_ms_median: ok ? median(t.times_ms) : null,
        result_equivalent: v?.equivalent ?? false,
        status: ok ? 'ok' : 'failed',
        failure_reason: ok ? null : (!c.validity.valid ? `invalid plan: ${c.validity.errors.join('; ')}` : v && !v.equivalent ? v.reason : t?.error ?? 'unknown'),
        environment_id: environmentId,
      });
    }
    const best = q.candidates
      .map((c) => timings[c.id]?.times_ms.length === reps ? median(timings[c.id].times_ms) : Infinity)
      .reduce((a, b) => Math.min(a, b), Infinity);
    console.log(`${profileId.padEnd(17)} ${w.id.padEnd(3)} candidates=${String(q.candidates.length).padStart(2)} fastest_median=${best.toFixed(2)} ms`);
  }
  perProfileSeconds[profileId] = (Date.now() - tProfile) / 1000;
}

const wallSeconds = (Date.now() - wallStart) / 1000;
writeFileSync(join(outDir, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(join(outDir, 'meta.json'), JSON.stringify({
  schema_version: FEATURE_SCHEMA_VERSION,
  environment_id: environmentId,
  environment: env,
  warmup_runs: warmup,
  timed_repetitions: reps,
  profiles,
  query_templates: WORKLOADS.length,
  records: records.length,
  failed_records: failures,
  calibration_wall_clock_seconds: wallSeconds,
  per_profile_seconds: perProfileSeconds,
  generated_at: new Date().toISOString(),
}, null, 2) + '\n');
console.log(`\nwrote ${records.length} records (${failures} failed) to ${outDir} in ${wallSeconds.toFixed(0)} s`);
