import { Candidate } from '../compiler/candidates';
import { CompiledQuery } from '../compiler';
import { nodeLabel, children, IRNode } from '../compiler/ir';
import { planCost } from '../optimizer/costModel';
import { DataProfile } from '../runtime/runtime';
import { SelectionResult, now } from './types';

/**
 * Mode B - the existing hybrid selector.
 *
 * Step 1 (always): the analytical cost model ranks every valid candidate.
 * Step 2 (optional): an LLM is shown the candidates plus the cost evidence and may re-rank them.
 *
 * Safety (required by the report): the LLM can only choose among the supplied candidate ids. Any
 * malformed answer, unknown id, timeout or network failure falls back to the cost-model choice and
 * the fallback is recorded in `source` and `warnings`. When no LLM client is configured the result
 * is labelled 'cost-model (LLM not configured)' so nothing is passed off as AI output.
 */

export type LlmClient = (prompt: { system: string; user: string }, signal?: AbortSignal) => Promise<string>;

export interface LlmConfig { client: LlmClient; modelName: string; timeoutMs?: number }

function planOutline(n: IRNode, depth = 0): string[] {
  return [`${'  '.repeat(depth)}${nodeLabel(n)}`, ...children(n).flatMap((c) => planOutline(c, depth + 1))];
}

export function buildPrompt(sql: string, cands: { c: Candidate; cost: number }[]): { system: string; user: string } {
  const system =
    'You are a query-optimizer assistant inside a compiler teaching framework. You are given equivalent ' +
    'candidate relational plans for one SQL query, each with an analytical cost estimate. Choose the plan ' +
    'you expect to execute fastest on pandas DataFrames. You MUST answer with a single JSON object ' +
    '{"choice":"<candidate id>","rationale":"<one or two sentences>"} and nothing else. The choice must be ' +
    'one of the listed ids.';
  const body = cands
    .map(({ c, cost }) => `### ${c.id}  (estimated cost ${cost.toFixed(0)}; transformations: ${c.transformations.join(', ')})\n${planOutline(c.plan).join('\n')}`)
    .join('\n\n');
  return { system, user: `SQL:\n${sql}\n\nCandidates:\n\n${body}` };
}

/** Extract {choice, rationale} from model text; returns null unless `choice` is a valid id. */
export function parseLlmChoice(text: string, validIds: string[]): { choice: string; rationale: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (typeof obj.choice === 'string' && validIds.includes(obj.choice.trim())) {
      return { choice: obj.choice.trim(), rationale: typeof obj.rationale === 'string' ? obj.rationale : '' };
    }
  } catch { /* fall through */ }
  return null;
}

export async function selectAIAssisted(
  q: CompiledQuery,
  profile: DataProfile,
  llm?: LlmConfig,
  candidates: Candidate[] = q.candidates.filter((c) => c.validity.valid),
): Promise<SelectionResult> {
  const t0 = now();
  const scored = candidates
    .map((c, i) => ({ c, i, cost: planCost(c.plan, q.bound, profile).total }))
    .sort((a, b) => a.cost - b.cost || a.i - b.i);
  const warnings: string[] = [];
  let selectedId = scored[0].c.id;
  let rationale = `Cost model ranks ${selectedId} lowest (estimated cost ${scored[0].cost.toFixed(0)}).`;
  let source = 'cost-model (LLM not configured)';
  let ranking = scored.map((s) => ({ id: s.c.id, score: s.cost, note: `estimated cost ${s.cost.toFixed(0)}` }));

  if (llm) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), llm.timeoutMs ?? 20_000);
    try {
      const text = await llm.client(buildPrompt(q.sql, scored.map((s) => ({ c: s.c, cost: s.cost }))), ctl.signal);
      const parsed = parseLlmChoice(text, scored.map((s) => s.c.id));
      if (parsed) {
        selectedId = parsed.choice;
        rationale = `${llm.modelName}: ${parsed.rationale || 'no rationale given'}`;
        source = `llm (${llm.modelName})`;
        ranking = [
          { id: selectedId, score: 0, note: 'chosen by LLM' },
          ...ranking.filter((r) => r.id !== selectedId),
        ];
      } else {
        warnings.push('LLM answer was not a valid candidate choice; fell back to the cost model.');
        source = 'cost-model (fallback: invalid LLM answer)';
      }
    } catch (e) {
      warnings.push(`LLM call failed (${e instanceof Error ? e.message : String(e)}); fell back to the cost model.`);
      source = 'cost-model (fallback: LLM unavailable)';
    } finally {
      clearTimeout(timer);
    }
  }

  return { mode: 'B', selectedId, ranking, rationale, latencyMs: now() - t0, source, warnings };
}

/** Anthropic Messages API client for browser or Node use. The key is held in memory only. */
export function anthropicClient(opts: { apiKey: string; model: string; fetchImpl?: typeof fetch }): LlmClient {
  const f = opts.fetchImpl ?? fetch;
  return async ({ system, user }, signal) => {
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: opts.model, max_tokens: 400, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const block = (data.content ?? []).find((b: { type: string }) => b.type === 'text');
    if (!block) throw new Error('no text block in response');
    return block.text as string;
  };
}

/**
 * Google Generative Language API client (free tier; works with Gemma and Gemini models). Gemma
 * models reject a separate system instruction, so the system text is prepended to the user turn.
 * Temperature 0 keeps the answer as repeatable as the API allows. The key is held in memory only.
 */
export function geminiClient(opts: { apiKey: string; model: string; fetchImpl?: typeof fetch }): LlmClient {
  const f = opts.fetchImpl ?? fetch;
  return async ({ system, user }, signal) => {
    const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${system}

${user}` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024 },
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      throw new Error(`HTTP ${res.status} ${detail}`);
    }
    const data = await res.json();
    const parts = (data.candidates?.[0]?.content?.parts ?? []) as { text?: string; thought?: boolean }[];
    const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    if (!text) throw new Error('no text in response');
    return text;
  };
}
