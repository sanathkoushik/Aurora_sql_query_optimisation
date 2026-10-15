import { CompiledQuery } from '../compiler';
import { BoundQuery } from '../compiler/semantic';
import { generatePandas } from './codegen';

/** Generated pandas source for every candidate, keyed by candidate id. */
export function candidateCodes(q: CompiledQuery): Record<string, string> {
  return Object.fromEntries(q.candidates.filter((c) => c.validity.valid).map((c) => [c.id, generatePandas(c.plan)]));
}

/** Output-column positions of ORDER BY keys that are visible in the result (used to verify sorting). */
export function orderPositions(bq: BoundQuery): number[] {
  const out: number[] = [];
  for (const k of bq.orderBy) {
    const idx = bq.outputs.findIndex((o) => o.src === k.col);
    if (idx >= 0) out.push(idx);
  }
  return out;
}
