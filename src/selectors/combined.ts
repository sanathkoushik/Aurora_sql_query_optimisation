import { Candidate } from '../compiler/candidates';
import { CompiledQuery } from '../compiler';
import { nodeLabel, children, IRNode } from '../compiler/ir';
import { planCost } from '../optimizer/costModel';
import { ForestModel } from '../predictor/forest';
import { DataProfile } from '../runtime/runtime';
import { LlmConfig, parseLlmChoice } from './aiAssisted';
import { selectPredictorGuided } from './predictorGuided';
import { SelectionResult, now } from './types';

/**
 * Mode D - combined selector (predictor shortlist + LLM arbitration).
 *
 * Step 1: the Random Forest of Mode C ranks every valid candidate.
 * Step 2: the top `k` candidates, each with its predicted runtime and analytical cost, are shown to
 *         the LLM, which may pick one of them (it sees only the shortlist, so it cannot choose a
 *         plan the predictor ranked poorly).
 * Safety: any missing client, timeout, malformed answer or id outside the shortlist falls back to
 * the predictor's top choice (Mode C), and the fallback is recorded in `source` and `warnings`.
 */
export const SHORTLIST_SIZE = 3;

const outline = (n: IRNode, d = 0): string[] => [`${'  '.repeat(d)}${nodeLabel(n)}`, ...children(n).flatMap((c) => outline(c, d + 1))];

export function buildCombinedPrompt(
  sql: string,
  short: { c: Candidate; cost: number; predictedMs: number }[],
): { system: string; user: string } {
  const system =
    'You are a query-optimizer assistant inside a compiler teaching framework. A trained model has already ' +
    'shortlisted equivalent candidate relational plans for one SQL query and predicted the runtime of each ' +
    'on pandas DataFrames. Pick the plan you expect to execute fastest, using the predictions as strong ' +
    'evidence but overriding them only if the plan structure clearly justifies it. Answer with a single JSON ' +
    'object {"choice":"<candidate id>","rationale":"<one or two sentences>"} and nothing else. The choice ' +
    'must be one of the listed ids.';
  const body = short
    .map(({ c, cost, predictedMs }) =>
      `### ${c.id}  (predicted runtime ${predictedMs.toFixed(2)} ms; analytical cost ${cost.toFixed(0)}; transformations: ${c.transformations.join(', ')})\n${outline(c.plan).join('\n')}`)
    .join('\n\n');
  return { system, user: `SQL:\n${sql}\n\nShortlisted candidates:\n\n${body}` };
}

export async function selectCombined(
  q: CompiledQuery,
  profile: DataProfile,
  model: ForestModel | null,
  llm?: LlmConfig,
  candidates: Candidate[] = q.candidates.filter((c) => c.validity.valid),
  k = SHORTLIST_SIZE,
): Promise<SelectionResult> {
  const t0 = now();
  const base = selectPredictorGuided(q, profile, model, candidates);
  const warnings = [...base.warnings];
  const done = (r: Partial<SelectionResult>): SelectionResult => ({
    ...base, mode: 'D', latencyMs: now() - t0, warnings, ...r,
  });
  if (!llm) return done({ source: `predictor-only (LLM not configured)`, rationale: `${base.rationale} No LLM configured, so Mode D equals Mode C.` });
  if (base.source === 'fallback:rule-based') return done({ source: 'fallback:rule-based' });

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const short = base.ranking.slice(0, k).map((r) => ({
    c: byId.get(r.id)!, predictedMs: base.predictedMs[r.id], cost: planCost(byId.get(r.id)!.plan, q.bound, profile).total,
  }));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), llm.timeoutMs ?? 20_000);
  try {
    const text = await llm.client(buildCombinedPrompt(q.sql, short), ctl.signal);
    const parsed = parseLlmChoice(text, short.map((s) => s.c.id));
    if (parsed) {
      const ranking = [{ id: parsed.choice, score: 0, note: 'chosen by LLM from the predictor shortlist' }, ...base.ranking.filter((r) => r.id !== parsed.choice)];
      return done({
        selectedId: parsed.choice, ranking, source: `predictor + llm (${llm.modelName})`,
        rationale: `${llm.modelName} (from predictor top-${short.length}): ${parsed.rationale || 'no rationale given'}`,
      });
    }
    warnings.push('LLM answer was not a valid shortlisted choice; kept the predictor choice.');
    return done({ source: 'predictor (fallback: invalid LLM answer)' });
  } catch (e) {
    warnings.push(`LLM call failed (${e instanceof Error ? e.message : String(e)}); kept the predictor choice.`);
    return done({ source: 'predictor (fallback: LLM unavailable)' });
  } finally {
    clearTimeout(timer);
  }
}
