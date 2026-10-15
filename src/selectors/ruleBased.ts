import { Candidate } from '../compiler/candidates';
import { CompiledQuery } from '../compiler';
import { IRNode, walk } from '../compiler/ir';
import { SelectionResult, now } from './types';

/**
 * Mode A - deterministic rule-based baseline.
 *
 * The rules are fixed and use structure only (no data statistics, no measurements):
 *   R1  prefer plans that apply more filters below joins (push selective filters early)
 *   R2  then prefer plans that carry fewer columns between operators (avoid unused columns)
 *   R3  then prefer the syntactic join order and operand sides (no reordering without evidence)
 *   R4  finally tie-break on candidate id (lowest first), so the choice is reproducible
 */
export interface RuleMetrics { filtersBelowJoin: number; carriedWidth: number; reorderings: number }

export function ruleMetrics(c: Candidate): RuleMetrics {
  let filtersBelowJoin = 0, carriedWidth = 0;
  const hasJoinBelow = (n: IRNode) => { let f = false; walk(n, (x) => { if (x.op === 'Join') f = true; }); return f; };
  walk(c.plan, (n) => {
    if (n.op === 'Filter' && !hasJoinBelow(n)) filtersBelowJoin++;
    // every intermediate relation except the final output projection
    if (!(n.op === 'Project' && n.purpose === 'output')) carriedWidth += n.schema.length;
  });
  return { filtersBelowJoin, carriedWidth, reorderings: (c.options.swap ? 1 : 0) + (c.options.reorder ? 1 : 0) };
}

export function selectRuleBased(q: CompiledQuery, candidates: Candidate[] = q.candidates.filter((c) => c.validity.valid)): SelectionResult {
  const t0 = now();
  const scored = candidates.map((c, i) => ({ c, i, m: ruleMetrics(c) }));
  scored.sort((a, b) =>
    b.m.filtersBelowJoin - a.m.filtersBelowJoin ||
    a.m.carriedWidth - b.m.carriedWidth ||
    a.m.reorderings - b.m.reorderings ||
    a.i - b.i);
  const best = scored[0];
  return {
    mode: 'A',
    selectedId: best.c.id,
    ranking: scored.map((s, rank) => ({
      id: s.c.id,
      score: rank + 1,
      note: `filters below join=${s.m.filtersBelowJoin}, carried width=${s.m.carriedWidth}, reorderings=${s.m.reorderings}`,
    })),
    rationale:
      `Rules R1-R4 pick ${best.c.id}: ${best.m.filtersBelowJoin} filter(s) below joins, ` +
      `carried width ${best.m.carriedWidth}, ${best.m.reorderings} join reordering(s).`,
    latencyMs: now() - t0,
    source: 'rules',
    warnings: [],
  };
}
