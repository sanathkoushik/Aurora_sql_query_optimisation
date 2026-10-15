import { Candidate } from '../compiler/candidates';
import { CompiledQuery } from '../compiler';
import { ForestModel, ModelCompatibilityError, assertCompatible, predictMs } from '../predictor/forest';
import { extractFeatures, featureArray } from '../predictor/features';
import { DataProfile } from '../runtime/runtime';
import { selectRuleBased } from './ruleBased';
import { SelectionResult, now } from './types';

/**
 * Mode C - predictor-guided selection.
 *
 * Extracts the SAME features used at training time for each valid candidate, predicts its runtime
 * with the exported Random Forest and ranks ascending. Deterministic for a fixed model and feature
 * vector. If the model is missing or incompatible with the feature schema, the selector returns a
 * controlled diagnostic and falls back to the rule-based baseline instead of an unchecked ranking.
 */
export function selectPredictorGuided(
  q: CompiledQuery,
  profile: DataProfile,
  model: ForestModel | null,
  candidates: Candidate[] = q.candidates.filter((c) => c.validity.valid),
): SelectionResult & { predictedMs: Record<string, number> } {
  const t0 = now();
  const fallback = (why: string) => {
    const r = selectRuleBased(q, candidates);
    return {
      ...r,
      mode: 'C' as const,
      source: 'fallback:rule-based',
      rationale: `Predictor unavailable (${why}); using the rule-based baseline instead.`,
      warnings: [why],
      latencyMs: now() - t0,
      predictedMs: {},
    };
  };
  if (!model) return fallback('no trained model loaded');
  try {
    assertCompatible(model);
    const predictedMs: Record<string, number> = {};
    for (const c of candidates) {
      predictedMs[c.id] = predictMs(model, featureArray(extractFeatures(c.plan, q.bound, profile)));
    }
    const order = candidates
      .map((c, i) => ({ id: c.id, i, ms: predictedMs[c.id] }))
      .sort((a, b) => a.ms - b.ms || a.i - b.i);
    return {
      mode: 'C',
      selectedId: order[0].id,
      ranking: order.map((o) => ({ id: o.id, score: o.ms, note: `predicted ${o.ms.toFixed(3)} ms` })),
      rationale: `Random Forest ${model.model_version} predicts ${order[0].id} fastest (${order[0].ms.toFixed(3)} ms).`,
      latencyMs: now() - t0,
      source: `predictor ${model.model_version}`,
      warnings: [],
      predictedMs,
    };
  } catch (e) {
    if (e instanceof ModelCompatibilityError) return fallback(e.message);
    throw e;
  }
}
