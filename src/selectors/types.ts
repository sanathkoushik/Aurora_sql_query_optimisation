export type SelectorMode = 'A' | 'B' | 'C' | 'D';

export const MODE_NAMES: Record<SelectorMode, string> = {
  A: 'Rule-based',
  B: 'AI-assisted (hybrid cost + LLM)',
  C: 'Predictor-guided',
  D: 'Combined (predictor shortlist + LLM)',
};

export interface RankedCandidate { id: string; score: number; note?: string }

export interface SelectionResult {
  mode: SelectorMode;
  selectedId: string;
  /** Best first. Always a permutation of the valid candidate ids. */
  ranking: RankedCandidate[];
  rationale: string;
  /** Wall-clock time taken to make the decision, after candidate generation. */
  latencyMs: number;
  /** Where the final decision came from, e.g. 'cost-model', 'llm', 'fallback:rule-based'. */
  source: string;
  warnings: string[];
}

export const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
