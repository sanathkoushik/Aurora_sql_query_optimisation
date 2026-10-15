/**
 * Correctness gate: every candidate plan of every workload query, on every data profile, must
 * return the same rows as SQLite executing the original SQL text. Exits non-zero on any mismatch.
 *
 *   npm run validate [-- --profiles small_selective,small_broad]
 */
import { compile } from '../src/compiler';
import { WORKLOADS, PROFILE_IDS } from '../src/data/workloads';
import { candidateCodes, orderPositions } from '../src/runtime/plan';
import { createNodeRuntime } from './lib/nodeRuntime';

const arg = process.argv.find((a) => a.startsWith('--profiles='))?.split('=')[1];
const profiles = arg ? arg.split(',') : [...PROFILE_IDS];

const t0 = Date.now();
const rt = await createNodeRuntime();
console.log('environment:', JSON.stringify(rt.environment()));
console.log(`boot: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

let total = 0, bad = 0;
for (const profile of profiles) {
  rt.loadProfile(profile);
  for (const w of WORKLOADS) {
    const q = compile(w.sql);
    const report = rt.verify(candidateCodes(q), w.sql, orderPositions(q.bound));
    if (report.reference_error) {
      console.log(`FAIL ${profile} ${w.id}: reference engine error ${report.reference_error}`);
      bad++; total++;
      continue;
    }
    for (const [id, r] of Object.entries(report.results)) {
      total++;
      if (!r.equivalent) {
        bad++;
        console.log(`FAIL ${profile} ${w.id} ${id}: ${r.reason}`);
      }
    }
    const n = Object.keys(report.results).length;
    const failed = Object.values(report.results).filter((r) => !r.equivalent).length;
    if (failed === 0) console.log(`ok   ${profile.padEnd(17)} ${w.id.padEnd(3)} candidates=${String(n).padStart(2)} reference_rows=${report.reference_rows}`);
  }
}
console.log(`\n${total - bad}/${total} candidate checks equivalent to the SQLite reference`);
process.exit(bad ? 1 : 0);
