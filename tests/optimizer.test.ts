import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler';
import { planCost } from '../src/optimizer/costModel';
import { estimateRows, makeStatsContext, selectivity, whereSelectivity } from '../src/optimizer/stats';
import { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, extractFeatures, featureArray } from '../src/predictor/features';
import { ForestModel, ModelCompatibilityError, assertCompatible, predictMs } from '../src/predictor/forest';
import { DataProfile } from '../src/runtime/runtime';
import { anthropicClient, parseLlmChoice, selectAIAssisted } from '../src/selectors/aiAssisted';
import { selectPredictorGuided } from '../src/selectors/predictorGuided';
import { selectRuleBased } from '../src/selectors/ruleBased';

const profile: DataProfile = {
  profileId: 'test',
  tables: {
    customers: {
      rows: 1000,
      columns: {
        customer_id: { distinct: 1000, min: 1, max: 1000 },
        region: { distinct: 5, min: 'Central', max: 'West', freq: { North: 0.24, South: 0.05, East: 0.24, West: 0.23, Central: 0.24 } },
        age: { distinct: 63, min: 18, max: 80 },
        name: { distinct: 1000, min: 'Customer 1', max: 'Customer 999' },
        signup_date: { distinct: 900, min: '2019-01-01', max: '2024-06-23' },
        segment: { distinct: 4, min: 'a', max: 'z' }, email: { distinct: 1000, min: 'a', max: 'z' }, city: { distinct: 30, min: 'a', max: 'z' }, loyalty_score: { distinct: 900, min: 0, max: 100 },
      },
    },
    orders: {
      rows: 5000,
      columns: {
        order_id: { distinct: 5000, min: 1, max: 5000 }, customer_id: { distinct: 900, min: 1, max: 2000 },
        product_id: { distinct: 200, min: 1, max: 200 }, amount: { distinct: 4000, min: 5, max: 2000 },
        status: { distinct: 5, min: 'a', max: 'z', freq: { delivered: 0.6, shipped: 0.15, processing: 0.12, cancelled: 0.08, returned: 0.05 } },
        quantity: { distinct: 10, min: 1, max: 10 }, order_date: { distinct: 700, min: '2023-01-01', max: '2024-12-31' },
        channel: { distinct: 4, min: 'a', max: 'z' }, discount: { distinct: 31, min: 0, max: 0.3 }, shipping_cost: { distinct: 2000, min: 0, max: 25 },
      },
    },
    products: { rows: 200, columns: { product_id: { distinct: 200, min: 1, max: 200 } } },
  },
};

const G1 = `SELECT c.region, SUM(o.amount) AS total_amount FROM customers AS c JOIN orders AS o ON c.customer_id = o.customer_id WHERE c.region = 'South' GROUP BY c.region ORDER BY total_amount DESC`;

describe('selectivity estimation', () => {
  const ctxFor = (sql: string) => { const q = compile(sql); return { q, ctx: makeStatsContext(q.bound, profile) }; };

  it('uses exact frequencies for low-cardinality equality', () => {
    const { q, ctx } = ctxFor("SELECT name FROM customers WHERE region = 'South'");
    expect(selectivity(q.bound.where!, ctx)).toBeCloseTo(0.05);
  });
  it('handles NOT, <>, IN, OR, AND', () => {
    const f = (where: string) => { const { q, ctx } = ctxFor(`SELECT name FROM customers WHERE ${where}`); return selectivity(q.bound.where!, ctx); };
    expect(f("region <> 'South'")).toBeCloseTo(0.95);
    expect(f("region IN ('South', 'East')")).toBeCloseTo(0.29);
    expect(f("region = 'South' OR region = 'East'")).toBeCloseTo(0.05 + 0.24 - 0.05 * 0.24);
    expect(f("region = 'South' AND region = 'East'")).toBeCloseTo(0.05 * 0.24);
    expect(f("NOT region = 'South'")).toBeCloseTo(0.95);
  });
  it('interpolates numeric and date ranges uniformly', () => {
    const f = (where: string) => { const { q, ctx } = ctxFor(`SELECT name FROM customers WHERE ${where}`); return selectivity(q.bound.where!, ctx); };
    expect(f('age > 49')).toBeGreaterThan(0.4);
    expect(f('age > 49')).toBeLessThan(0.55);
    expect(f('age BETWEEN 18 AND 80')).toBeGreaterThan(0.95);
    expect(f("signup_date >= '2024-01-01'")).toBeGreaterThan(0.05);
  });
  it('returns null (unknown) instead of inventing a number', () => {
    const f = (where: string) => { const { q, ctx } = ctxFor(`SELECT name FROM customers WHERE ${where}`); return selectivity(q.bound.where!, ctx); };
    expect(f("name LIKE 'Customer 1%'")).toBeNull(); // high-cardinality text: no exact frequency map
    expect(f('age > loyalty_score')).toBeNull(); // column vs column
    expect(f("name > 'Customer 5'")).toBeNull(); // non-date string range
  });
  it('whereSelectivity flags unknown conjuncts', () => {
    const { q, ctx } = ctxFor("SELECT name FROM customers WHERE region = 'South' AND name LIKE 'C%'");
    const s = whereSelectivity(q.bound, ctx);
    expect(s.known).toBe(false);
    expect(s.value).toBeCloseTo(0.05);
  });
});

describe('cardinality & cost', () => {
  it('pushdown shrinks estimated join input', () => {
    const q = compile(G1);
    const ctx = makeStatsContext(q.bound, profile);
    const base = q.candidates[0], pushed = q.candidates.find((c) => c.options.pushdown)!;
    const joinRows = (c: typeof base) => { const f = extractFeatures(c.plan, q.bound, profile, ctx); return f.est_join_left_rows_log1p + f.est_join_right_rows_log1p; };
    expect(joinRows(pushed)).toBeLessThan(joinRows(base));
  });
  it('cost model prefers pushdown to the canonical plan', () => {
    const q = compile(G1);
    const pushed = q.candidates.find((c) => c.options.pushdown && c.options.prune === 'early' && !c.options.reorder)!;
    expect(planCost(pushed.plan, q.bound, profile).total).toBeLessThan(planCost(q.candidates[0].plan, q.bound, profile).total);
  });
  it('estimateRows for a scan is the table cardinality', () => {
    const q = compile('SELECT name FROM customers');
    expect(estimateRows(q.candidates[0].plan, makeStatsContext(q.bound, profile), { unknownSelectivity: 1 })).toBe(1000);
  });
});

describe('feature extraction', () => {
  it('follows the contract order and is finite', () => {
    const q = compile(G1);
    for (const c of q.candidates) {
      const v = featureArray(extractFeatures(c.plan, q.bound, profile));
      expect(v).toHaveLength(FEATURE_NAMES.length);
      expect(v.every(Number.isFinite)).toBe(true);
    }
  });
  it('counts operators correctly for the canonical plan', () => {
    const q = compile(G1);
    const f = extractFeatures(q.candidates[0].plan, q.bound, profile);
    expect(f).toMatchObject({ operator_scan_count: 2, operator_filter_count: 1, operator_join_count: 1, operator_aggregate_count: 1, operator_sort_count: 1, operator_project_count: 1 });
    expect(f.input_rows_log1p).toBeCloseTo(Math.log1p(6000));
    expect(f.input_column_count).toBe(19);
    expect(f.filters_below_join).toBe(0);
    expect(f.filter_selectivity_known).toBe(1);
  });
  it('distinguishes candidates of the same query', () => {
    const q = compile(G1);
    const vecs = new Set(q.candidates.map((c) => JSON.stringify(featureArray(extractFeatures(c.plan, q.bound, profile)))));
    expect(vecs.size).toBeGreaterThan(q.candidates.length / 2);
  });
  it('marks unknown selectivity explicitly', () => {
    const q = compile("SELECT name FROM customers WHERE name LIKE 'C%'");
    const f = extractFeatures(q.candidates[0].plan, q.bound, profile);
    expect(f.filter_selectivity_known).toBe(0);
  });
});

describe('Mode A - rule-based', () => {
  it('is deterministic and prefers pushdown + pruning without reordering', () => {
    const q = compile(G1);
    const a = selectRuleBased(q), b = selectRuleBased(q);
    expect(a.selectedId).toBe(b.selectedId);
    const c = q.candidates.find((x) => x.id === a.selectedId)!;
    expect(c.options).toMatchObject({ pushdown: true, prune: 'early', swap: false, reorder: false });
    expect(a.ranking).toHaveLength(q.candidates.length);
  });
  it('only ranks the candidates it is given', () => {
    const q = compile(G1);
    const pool = q.candidates.slice(0, 3);
    expect(selectRuleBased(q, pool).ranking.map((r) => r.id).sort()).toEqual(pool.map((c) => c.id).sort());
  });
});

describe('Mode B - AI-assisted safety', () => {
  const q = compile(G1);
  it('parseLlmChoice accepts only listed ids', () => {
    expect(parseLlmChoice('{"choice":"P2","rationale":"x"}', ['P1', 'P2'])).toEqual({ choice: 'P2', rationale: 'x' });
    expect(parseLlmChoice('Sure! ```json\n{"choice": "P1"}\n```', ['P1'])?.choice).toBe('P1');
    expect(parseLlmChoice('{"choice":"P99"}', ['P1'])).toBeNull();
    expect(parseLlmChoice('no json here', ['P1'])).toBeNull();
    expect(parseLlmChoice('{bad json}', ['P1'])).toBeNull();
  });
  it('without an LLM it labels the result as cost-model only', async () => {
    const r = await selectAIAssisted(q, profile);
    expect(r.source).toContain('LLM not configured');
    expect(r.ranking).toHaveLength(q.candidates.length);
  });
  it('accepts a valid LLM choice', async () => {
    const r = await selectAIAssisted(q, profile, { modelName: 'mock', client: async () => '{"choice":"P3","rationale":"because"}' });
    expect(r.selectedId).toBe('P3');
    expect(r.source).toContain('llm');
  });
  it('cannot introduce a plan outside the candidate set', async () => {
    const r = await selectAIAssisted(q, profile, { modelName: 'mock', client: async () => '{"choice":"P999"}' });
    expect(q.candidates.map((c) => c.id)).toContain(r.selectedId);
    expect(r.source).toContain('fallback');
    expect(r.warnings).toHaveLength(1);
  });
  it('falls back when the LLM call fails or times out', async () => {
    const r = await selectAIAssisted(q, profile, { modelName: 'mock', client: async () => { throw new Error('boom'); } });
    expect(r.source).toContain('fallback');
    const slow = await selectAIAssisted(q, profile, { modelName: 'mock', timeoutMs: 20, client: (_p, signal) => new Promise((_res, rej) => signal?.addEventListener('abort', () => rej(new Error('aborted')))) });
    expect(slow.source).toContain('fallback');
  });
  it('anthropicClient sends the documented request and parses the text block', async () => {
    let seen: any;
    const fetchImpl = (async (url: string, init: any) => { seen = { url, init }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'hello' }] }) }; }) as unknown as typeof fetch;
    const text = await anthropicClient({ apiKey: 'k', model: 'm', fetchImpl })({ system: 's', user: 'u' });
    expect(text).toBe('hello');
    expect(seen.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen.init.headers['x-api-key']).toBe('k');
    expect(JSON.parse(seen.init.body)).toMatchObject({ model: 'm', system: 's', messages: [{ role: 'user', content: 'u' }] });
    const bad = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    await expect(anthropicClient({ apiKey: 'k', model: 'm', fetchImpl: bad })({ system: '', user: '' })).rejects.toThrow('401');
  });
});

describe('Mode C - predictor', () => {
  // A hand-built 1-tree forest: predicts log1p(10ms) if columns_into_joins <= 20 else log1p(100ms).
  const idx = FEATURE_NAMES.indexOf('columns_into_joins');
  const tiny: ForestModel = {
    model_type: 'random_forest_regressor', model_version: 'test-v0', schema_version: FEATURE_SCHEMA_VERSION,
    feature_names: [...FEATURE_NAMES], target_transform: 'log1p', trained_at: 'now', n_estimators: 1,
    trees: [{ feature: [idx, -2, -2], threshold: [20, 0, 0], left: [1, -1, -1], right: [2, -1, -1], value: [0, Math.log1p(10), Math.log1p(100)] }],
  };
  it('predictMs inverts the log1p transform', () => {
    const lo = Array(FEATURE_NAMES.length).fill(0); lo[idx] = 5;
    const hi = Array(FEATURE_NAMES.length).fill(0); hi[idx] = 50;
    expect(predictMs(tiny, lo)).toBeCloseTo(10, 9);
    expect(predictMs(tiny, hi)).toBeCloseTo(100, 9);
  });
  it('ranks candidates by ascending predicted runtime', () => {
    const q = compile(G1);
    const r = selectPredictorGuided(q, profile, tiny);
    expect(r.source).toContain('predictor');
    const ms = r.ranking.map((x) => x.score);
    expect([...ms].sort((a, b) => a - b)).toEqual(ms);
    expect(r.selectedId).toBe(r.ranking[0].id);
  });
  it('falls back to the rule-based baseline when no model is loaded', () => {
    const q = compile(G1);
    const r = selectPredictorGuided(q, profile, null);
    expect(r.source).toBe('fallback:rule-based');
    expect(r.selectedId).toBe(selectRuleBased(q).selectedId);
    expect(r.warnings[0]).toContain('no trained model');
  });
  it('rejects an incompatible schema with a controlled diagnostic and falls back', () => {
    const q = compile(G1);
    const old = { ...tiny, schema_version: 'aurora-runtime-features-v0' };
    expect(() => assertCompatible(old)).toThrow(ModelCompatibilityError);
    const r = selectPredictorGuided(q, profile, old);
    expect(r.source).toBe('fallback:rule-based');
    const reordered = { ...tiny, feature_names: [...FEATURE_NAMES].reverse() };
    expect(() => assertCompatible(reordered)).toThrow(/feature names/);
  });
  it('rejects wrong-length and non-finite vectors', () => {
    expect(() => predictMs(tiny, [1, 2])).toThrow(ModelCompatibilityError);
    const bad = Array(FEATURE_NAMES.length).fill(0); bad[0] = NaN;
    expect(() => predictMs(tiny, bad)).toThrow(/non-finite/);
  });
});

describe('exported scikit-learn forest parity', () => {
  const dir = join(__dirname, '..', 'artifacts', 'model');
  const present = existsSync(join(dir, 'aurora_rf_v1.json')) && existsSync(join(dir, 'parity.json'));
  it.skipIf(!present)('TypeScript inference reproduces sklearn predictions', () => {
    const model = JSON.parse(readFileSync(join(dir, 'aurora_rf_v1.json'), 'utf8')) as ForestModel;
    const parity = JSON.parse(readFileSync(join(dir, 'parity.json'), 'utf8')) as { inputs: number[][]; expected_ms: number[] };
    assertCompatible(model);
    expect(parity.inputs.length).toBeGreaterThan(10);
    parity.inputs.forEach((x, i) => {
      const got = predictMs(model, x);
      expect(Math.abs(got - parity.expected_ms[i])).toBeLessThan(1e-6 * Math.max(1, parity.expected_ms[i]));
    });
  });
});
