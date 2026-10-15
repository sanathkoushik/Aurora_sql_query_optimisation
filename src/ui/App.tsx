import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Candidate, CompiledQuery, tryCompile } from '../compiler';
import { PROFILE_IDS, WORKLOADS } from '../data/workloads';
import { ForestModel } from '../predictor/forest';
import { FEATURE_NAMES, extractFeatures, featureArray } from '../predictor/features';
import { generatePandas } from '../runtime/codegen';
import { candidateCodes, orderPositions } from '../runtime/plan';
import { AuroraRuntime, DataProfile, DisplayResult, EnvironmentInfo } from '../runtime/runtime';
import { LlmConfig, anthropicClient, selectAIAssisted } from '../selectors/aiAssisted';
import { selectPredictorGuided } from '../selectors/predictorGuided';
import { selectRuleBased } from '../selectors/ruleBased';
import { MODE_NAMES, SelectionResult, SelectorMode } from '../selectors/types';
import { bootRuntime, loadEvaluation, loadModel, loadTrainReport } from './browserRuntime';
import { BarChart, BarDatum, Legend, PlanTree, Section, stripPos } from './components';

type TabId = 'compiler' | 'candidates' | 'selectors' | 'benchmark' | 'comparison' | 'evaluation';
const TABS: { id: TabId; label: string }[] = [
  { id: 'compiler', label: 'Compiler' },
  { id: 'candidates', label: 'Candidate plans' },
  { id: 'selectors', label: 'Selector modes' },
  { id: 'benchmark', label: 'Benchmark' },
  { id: 'comparison', label: 'Comparison' },
  { id: 'evaluation', label: 'Held-out evaluation' },
];
const MODE_COLOR: Record<SelectorMode, string> = { A: 'var(--mode-a)', B: 'var(--mode-b)', C: 'var(--mode-c)' };
const MODES: SelectorMode[] = ['A', 'B', 'C'];

interface BenchRow { id: string; times: number[]; median: number; equivalent: boolean; reason: string; error: string | null }
interface BenchState { key: string; rows: Record<string, BenchRow>; oracleId: string | null; oracleMs: number; seconds: number }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const nextPaint = () => new Promise<void>((r) => setTimeout(r, 40));

export function App() {
  const [sql, setSql] = useState(WORKLOADS.find((w) => w.id === 'g1')!.sql);
  const [exampleId, setExampleId] = useState('g1');
  const [profileId, setProfileId] = useState<string>('medium_selective');
  const [tab, setTab] = useState<TabId>('compiler');

  // ---- runtime & model ----
  const [rtStatus, setRtStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [rtMessage, setRtMessage] = useState('Starting…');
  const [rt, setRt] = useState<AuroraRuntime | null>(null);
  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [profile, setProfile] = useState<DataProfile | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [model, setModel] = useState<ForestModel | null>(null);

  useEffect(() => {
    let alive = true;
    loadModel().then((m) => alive && setModel(m)).catch(() => undefined);
    bootRuntime((s) => alive && setRtMessage(s))
      .then((r) => { if (alive) { setRt(r); setEnv(r.environment()); setRtStatus('ready'); } })
      .catch((e) => { if (alive) { setRtStatus('error'); setRtMessage(String(e?.message ?? e)); } });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!rt) return;
    let alive = true;
    setProfileBusy(true);
    setProfile(null);
    nextPaint().then(() => {
      if (!alive) return;
      try { setProfile(rt.loadProfile(profileId)); } finally { setProfileBusy(false); }
    });
    return () => { alive = false; };
  }, [rt, profileId]);

  // ---- compile ----
  const outcome = useMemo(() => tryCompile(sql), [sql]);
  const compiled: CompiledQuery | null = outcome.ok ? outcome.result : null;
  const validCandidates = useMemo(() => compiled?.candidates.filter((c) => c.validity.valid) ?? [], [compiled]);
  const [activeId, setActiveId] = useState('P1');
  const active: Candidate | undefined = validCandidates.find((c) => c.id === activeId) ?? validCandidates[0];

  // ---- selectors ----
  const [apiKey, setApiKey] = useState('');
  const [llmModel, setLlmModel] = useState('claude-sonnet-5-5');
  const llm: LlmConfig | undefined = useMemo(
    () => (apiKey.trim() ? { client: anthropicClient({ apiKey: apiKey.trim(), model: llmModel }), modelName: llmModel, timeoutMs: 30_000 } : undefined),
    [apiKey, llmModel],
  );
  const selA = useMemo(() => (compiled ? selectRuleBased(compiled, validCandidates) : null), [compiled, validCandidates]);
  const selC = useMemo(
    () => (compiled && profile ? selectPredictorGuided(compiled, profile, model, validCandidates) : null),
    [compiled, profile, model, validCandidates],
  );
  const [selB, setSelB] = useState<SelectionResult | null>(null);
  const [selBBusy, setSelBBusy] = useState(false);
  useEffect(() => {
    setSelB(null);
    if (!compiled || !profile) return;
    let alive = true;
    setSelBBusy(true);
    selectAIAssisted(compiled, profile, llm, validCandidates)
      .then((r) => alive && setSelB(r))
      .finally(() => alive && setSelBBusy(false));
    return () => { alive = false; };
  }, [compiled, profile, llm, validCandidates]);
  const selections: Partial<Record<SelectorMode, SelectionResult>> = { A: selA ?? undefined, B: selB ?? undefined, C: selC ?? undefined };

  // ---- benchmark ----
  const [warmup, setWarmup] = useState(2);
  const [reps, setReps] = useState(7);
  const [bench, setBench] = useState<BenchState | null>(null);
  const [benchBusy, setBenchBusy] = useState(false);
  const [benchError, setBenchError] = useState<string | null>(null);
  const benchKey = `${sql}::${profileId}`;
  const benchValid = bench && bench.key === benchKey ? bench : null;

  const runBenchmark = useCallback(async () => {
    if (!rt || !compiled || !profile) return;
    setBenchBusy(true);
    setBenchError(null);
    await nextPaint();
    const t0 = performance.now();
    try {
      const codes = candidateCodes(compiled);
      const verify = rt.verify(codes, compiled.sql, orderPositions(compiled.bound));
      if (verify.reference_error) throw new Error(`SQLite reference failed: ${verify.reference_error}`);
      const timeable = Object.fromEntries(Object.entries(codes).filter(([id]) => verify.results[id]?.equivalent));
      await nextPaint();
      const timings = rt.timeCandidates(timeable, warmup, reps);
      const rows: Record<string, BenchRow> = {};
      for (const id of Object.keys(codes)) {
        const v = verify.results[id];
        const t = timings[id];
        rows[id] = { id, times: t?.times_ms ?? [], median: t?.times_ms.length ? median(t.times_ms) : NaN, equivalent: !!v?.equivalent, reason: v?.reason ?? '', error: t?.error ?? null };
      }
      const measured = Object.values(rows).filter((r) => r.equivalent && !r.error && Number.isFinite(r.median));
      const best = measured.reduce<BenchRow | null>((a, b) => (!a || b.median < a.median ? b : a), null);
      setBench({ key: benchKey, rows, oracleId: best?.id ?? null, oracleMs: best?.median ?? NaN, seconds: (performance.now() - t0) / 1000 });
    } catch (e) {
      setBenchError(e instanceof Error ? e.message : String(e));
    } finally {
      setBenchBusy(false);
    }
  }, [rt, compiled, profile, warmup, reps, benchKey]);

  // ---- run a plan and show rows ----
  const [display, setDisplay] = useState<{ mode: string; id: string; result: DisplayResult } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  useEffect(() => { setDisplay(null); setRunError(null); }, [sql, profileId]);
  const runPlan = (label: string, c: Candidate) => {
    if (!rt) return;
    setRunError(null);
    try { setDisplay({ mode: label, id: c.id, result: rt.runForDisplay(generatePandas(c.plan), 15) }); }
    catch (e) { setRunError(e instanceof Error ? e.message : String(e)); }
  };

  const onExample = (id: string) => {
    setExampleId(id);
    const w = WORKLOADS.find((x) => x.id === id);
    if (w) { setSql(w.sql); setActiveId('P1'); }
  };
  const lines = sql.split('\n');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Aurora</h1>
          <span>AI-assisted SQL query optimisation · transparent compilation · Query Inspector</span>
        </div>
        <span className="spacer" />
        <span className="pill" title={rtMessage}><span className={`dot ${rtStatus}`} />{rtStatus === 'ready' ? `Pyodide ${env?.python} · pandas ${env?.pandas}` : rtStatus === 'loading' ? rtMessage : 'Runtime failed'}</span>
        <span className="pill">{model ? `Predictor ${model.model_version}` : 'No predictor model'}</span>
      </header>

      {rtStatus === 'error' && (
        <div className="diag"><b>Could not start the Python runtime.</b> Aurora loads Pyodide from the jsDelivr CDN, so an internet connection is required. <pre>{rtMessage}</pre></div>
      )}

      <div className="layout">
        {/* ---------------- left column: editor ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-head"><h2>SQL query</h2><span className="spacer" />
              <label className="small muted" htmlFor="ex">Example&nbsp;</label>
              <select id="ex" value={exampleId} onChange={(e) => onExample(e.target.value)}>
                <option value="">Custom query</option>
                {WORKLOADS.map((w) => <option key={w.id} value={w.id}>{w.id} – {w.description}</option>)}
              </select>
            </div>
            <textarea className="sql" spellCheck={false} aria-label="SQL query" value={sql} onChange={(e) => { setSql(e.target.value); setExampleId(''); setActiveId('P1'); }} />
            {outcome.ok ? (
              <div className="ok-note">✓ Compiled: {outcome.result.tokens.length - 1} tokens · {outcome.result.candidates.length} candidate plans · output {outcome.result.bound.outputs.map((o) => o.as).join(', ')}</div>
            ) : (
              <div className="diag" role="alert">
                {outcome.diagnostics.map((d, i) => (
                  <div key={i}>
                    <b>{d.stage} error</b> at {d.pos.line}:{d.pos.col} — {d.message}
                    <pre>{lines[d.pos.line - 1]}{'\n'}{' '.repeat(Math.max(d.pos.col - 1, 0))}{'^'.repeat(Math.max(1, Math.min(d.length, 40)))}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head"><h2>Dataset</h2></div>
            <div className="row">
              <label htmlFor="prof" className="small muted">Data profile</label>
              <select id="prof" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                {PROFILE_IDS.map((p) => <option key={p} value={p}>{p.replace('_', ' · ')}</option>)}
              </select>
              {profileBusy && <span className="small muted">generating…</span>}
            </div>
            {profile ? (
              <table style={{ marginTop: 10 }}>
                <thead><tr><th>Table</th><th className="num">Rows</th><th className="num">Columns</th></tr></thead>
                <tbody>
                  {Object.entries(profile.tables).map(([name, t]) => (
                    <tr key={name}><td className="mono">{name}</td><td className="num">{t.rows.toLocaleString()}</td><td className="num">{Object.keys(t.columns).length}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted small">Waiting for the runtime…</p>}
            <p className="muted small" style={{ marginBottom: 0 }}>
              Synthetic e-commerce data generated deterministically (fixed seed) so every run, browser or Node, sees identical tables.
              “selective” = 5% of customers in region South; “broad” = 40%. All columns are NULL-free.
            </p>
          </div>
        </div>

        {/* ---------------- right column: inspector ---------------- */}
        <div className="card" style={{ minHeight: 480 }}>
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          {!compiled && tab !== 'evaluation' && <p className="muted">Fix the query on the left to inspect it.</p>}

          {compiled && tab === 'compiler' && <CompilerPanel q={compiled} />}

          {compiled && tab === 'candidates' && (
            <CandidatesPanel q={compiled} activeId={active?.id ?? ''} onPick={setActiveId} bench={benchValid} />
          )}

          {compiled && tab === 'selectors' && (
            <SelectorsPanel
              q={compiled} selections={selections} model={model} profile={profile} selBBusy={selBBusy}
              apiKey={apiKey} setApiKey={setApiKey} llmModel={llmModel} setLlmModel={setLlmModel}
              onRun={(m) => { const s = selections[m]; const c = validCandidates.find((x) => x.id === s?.selectedId); if (c) runPlan(`Mode ${m}`, c); }}
              display={display} runError={runError}
            />
          )}

          {compiled && tab === 'benchmark' && (
            <BenchmarkPanel
              q={compiled} bench={benchValid} busy={benchBusy} error={benchError} ready={!!rt && !!profile}
              warmup={warmup} reps={reps} setWarmup={setWarmup} setReps={setReps} onRun={runBenchmark}
            />
          )}

          {compiled && tab === 'comparison' && (
            <ComparisonPanel q={compiled} selections={selections} bench={benchValid} onRunBenchmark={() => { setTab('benchmark'); void runBenchmark(); }} />
          )}

          {tab === 'evaluation' && <EvaluationPanel />}
        </div>
      </div>

      <footer className="footer">
        BCSE307P Compiler Design Lab · VIT Vellore · Sanath M Koushik (24BCE2187), Tarun T S (24BCE2188). Conclusions apply to Aurora’s own candidate space on the pandas/Pyodide runtime and are not claims about production database engines.
      </footer>
    </div>
  );
}

/* ====================================================================================== */

function CompilerPanel({ q }: { q: CompiledQuery }) {
  const [view, setView] = useState<'tokens' | 'ast' | 'semantic' | 'ir'>('tokens');
  const b = q.bound;
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        {(['tokens', 'ast', 'semantic', 'ir'] as const).map((v) => (
          <button key={v} className={`btn ${view === v ? '' : 'ghost'}`} onClick={() => setView(v)}>
            {{ tokens: '1 · Lexer (DFA)', ast: '2 · Parser (AST)', semantic: '3 · Semantic', ir: '4 · Relational IR' }[v]}
          </button>
        ))}
      </div>
      {view === 'tokens' && (
        <div className="scroll">
          <table>
            <thead><tr><th>#</th><th>Type</th><th>Lexeme</th><th>Line:Col</th></tr></thead>
            <tbody>
              {q.tokens.map((t, i) => (
                <tr key={i}><td>{i + 1}</td><td><span className="badge">{t.type}</span></td><td className="mono">{t.type === 'EOF' ? '⟂' : t.lexeme}</td><td>{t.pos.line}:{t.pos.col}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view === 'ast' && <pre className="code">{JSON.stringify(stripPos(q.ast), null, 2)}</pre>}
      {view === 'semantic' && (
        <dl className="kv">
          <dt>Tables</dt><dd>{b.tables.map((t) => `${t.table} AS ${t.alias}`).join(', ')}</dd>
          <dt>Join keys</dt><dd>{b.joins.length ? b.joins.map((j) => j.keys.map((k) => `${k.l} = ${k.r}`).join(' AND ')).join(' ; ') : '—'}</dd>
          <dt>Aggregation</dt><dd>{b.isAggregate ? `GROUP BY [${b.groupBy.join(', ')}] · ${b.aggs.map((a) => `${a.fn}(${a.arg ?? '*'}) → ${a.as}`).join(', ')}` : 'none'}</dd>
          <dt>Output schema</dt><dd>{b.outputs.map((o, i) => `${o.as}: ${b.outputTypes[i]}`).join(', ')}</dd>
          <dt>Sort</dt><dd>{b.orderBy.length ? b.orderBy.map((k) => `${k.col} ${k.desc ? 'DESC' : 'ASC'}`).join(', ') : '—'}</dd>
          <dt>Diagnostics</dt><dd>none — all names resolved and types checked</dd>
        </dl>
      )}
      {view === 'ir' && (
        <>
          <p className="muted small">Canonical logical plan (P1): every transformation starts from this tree.</p>
          <PlanTree node={q.logicalPlan} />
        </>
      )}
    </div>
  );
}

function CandidatesPanel({ q, activeId, onPick, bench }: { q: CompiledQuery; activeId: string; onPick: (id: string) => void; bench: BenchState | null }) {
  const active = q.candidates.find((c) => c.id === activeId) ?? q.candidates[0];
  return (
    <div>
      <p className="muted small">{q.candidates.length} distinct plans from predicate pushdown, projection pruning, join-side swap and join reordering (duplicates removed by plan signature). All three selectors choose from this same set.</p>
      <div className="scroll" style={{ maxHeight: 220 }}>
        <table>
          <thead><tr><th>ID</th><th>Transformations</th><th>Valid</th>{bench && <th className="num">Median ms</th>}{bench && <th>Equivalent</th>}</tr></thead>
          <tbody>
            {q.candidates.map((c) => (
              <tr key={c.id} className={`click ${c.id === active.id ? 'sel' : ''}`} onClick={() => onPick(c.id)}>
                <td><b>{c.id}</b></td><td>{c.transformations.join(' · ')}</td>
                <td>{c.validity.valid ? <span className="badge good">✓ valid</span> : <span className="badge bad" title={c.validity.errors.join('; ')}>✗ invalid</span>}</td>
                {bench && <td className="num">{fmt(bench.rows[c.id]?.median ?? NaN)}{bench.oracleId === c.id ? ' ★' : ''}</td>}
                {bench && <td>{bench.rows[c.id]?.equivalent ? <span className="badge good">✓</span> : <span className="badge bad">✗</span>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 14 }}>
        <h3 style={{ fontSize: 13, marginBottom: 6 }}>{active.id} · plan tree <span className="muted small mono">{active.fingerprint}</span></h3>
        <PlanTree node={active.plan} />
        <h3 style={{ fontSize: 13, margin: '14px 0 6px' }}>Generated pandas code</h3>
        <pre className="code">{generatePandas(active.plan)}</pre>
      </div>
    </div>
  );
}

function SelectorsPanel(props: {
  q: CompiledQuery; selections: Partial<Record<SelectorMode, SelectionResult>>; model: ForestModel | null; profile: DataProfile | null; selBBusy: boolean;
  apiKey: string; setApiKey: (s: string) => void; llmModel: string; setLlmModel: (s: string) => void;
  onRun: (m: SelectorMode) => void; display: { mode: string; id: string; result: DisplayResult } | null; runError: string | null;
}) {
  const { q, selections, model, profile } = props;
  const [showFeatures, setShowFeatures] = useState(false);
  const featRows = useMemo(() => {
    if (!profile || !showFeatures) return [];
    return q.candidates.filter((c) => c.validity.valid).map((c) => ({ id: c.id, f: featureArray(extractFeatures(c.plan, q.bound, profile)) }));
  }, [q, profile, showFeatures]);
  return (
    <div>
      <p className="muted small">All three strategies rank the same valid candidate set (Figure 3.2). The measured oracle is never an input.</p>
      <div className="grid3">
        {MODES.map((m) => {
          const s = props.selections[m];
          return (
            <div key={m} className="mode-card" style={{ ['--c' as string]: MODE_COLOR[m] }}>
              <h3><span className={`badge ${m.toLowerCase()}`}>Mode {m}</span>{m === 'B' && s && !s.source.startsWith('llm') ? 'AI-assisted (cost model only)' : MODE_NAMES[m]}</h3>
              {!s ? <p className="muted small">{m === 'B' && props.selBBusy ? 'Deciding…' : 'Waiting for the data profile…'}</p> : (
                <>
                  <div className="big">{s.selectedId}</div>
                  <div className="small muted">{q.candidates.find((c) => c.id === s.selectedId)?.transformations.join(' · ')}</div>
                  <p className="small">{s.rationale}</p>
                  <div className="small muted">source: {s.source} · decision {fmt(s.latencyMs, 3)} ms</div>
                  {s.warnings.map((w, i) => <div key={i} className="warnbox">⚠ {w}</div>)}
                  <details style={{ marginTop: 6 }}>
                    <summary className="small">Ranking</summary>
                    <table>
                      <tbody>
                        {s.ranking.slice(0, 8).map((r, i) => (
                          <tr key={r.id}><td>{i + 1}</td><td><b>{r.id}</b></td><td className="small muted">{r.note}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                  <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => props.onRun(m)}>Run {s.selectedId}</button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {props.runError && <div className="diag"><b>Execution failed</b><pre>{props.runError}</pre></div>}
      {props.display && (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ fontSize: 13 }}>{props.display.mode} · {props.display.id} → {props.display.result.row_count.toLocaleString()} rows in {fmt(props.display.result.elapsed_ms)} ms (single run, includes no warm-up)</h3>
          <div className="scroll" style={{ maxHeight: 300 }}>
            <table>
              <thead><tr>{props.display.result.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{props.display.result.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      )}

      <Section title="Mode B – AI assistance (optional)">
        <p className="muted small">Mode B always computes the analytical cost model. If you enter an Anthropic API key it also asks the LLM to choose among the candidates; the answer is accepted only if it names a listed candidate, otherwise Aurora falls back to the cost model and says so. The key stays in this tab’s memory and is sent only to api.anthropic.com.</p>
        <div className="row">
          <input type="password" placeholder="Anthropic API key (optional)" autoComplete="off" value={props.apiKey} onChange={(e) => props.setApiKey(e.target.value)} aria-label="Anthropic API key" />
          <input type="text" value={props.llmModel} onChange={(e) => props.setLlmModel(e.target.value)} aria-label="LLM model name" style={{ width: 180 }} />
        </div>
      </Section>

      <Section title="Mode C – predictor details">
        {model ? (
          <dl className="kv">
            <dt>Model</dt><dd>{model.model_version} · Random Forest, {model.n_estimators} trees · target {model.target_transform}</dd>
            <dt>Feature schema</dt><dd>{model.schema_version} ({model.feature_names.length} features)</dd>
            <dt>Trained from</dt><dd>benchmark generated {model.trained_at}</dd>
          </dl>
        ) : <p className="muted small">No trained model file found — Mode C falls back to the rule-based baseline.</p>}
        <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => setShowFeatures((v) => !v)} disabled={!profile}>{showFeatures ? 'Hide' : 'Show'} feature vectors</button>
        {showFeatures && (
          <div className="scroll" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>ID</th>{FEATURE_NAMES.map((n) => <th key={n} title={n} className="num">{n.replace(/_/g, ' ')}</th>)}</tr></thead>
              <tbody>{featRows.map((r) => <tr key={r.id}><td><b>{r.id}</b></td>{r.f.map((v, i) => <td key={i} className="num">{fmt(v, 2)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        )}
        {selections.C && Object.keys((selections.C as { predictedMs?: Record<string, number> }).predictedMs ?? {}).length > 0 && (
          <p className="small muted">Predicted runtimes appear in the ranking above and next to measured values in the Comparison tab.</p>
        )}
      </Section>
    </div>
  );
}

function BenchmarkPanel(props: {
  q: CompiledQuery; bench: BenchState | null; busy: boolean; error: string | null; ready: boolean;
  warmup: number; reps: number; setWarmup: (n: number) => void; setReps: (n: number) => void; onRun: () => void;
}) {
  const { q, bench } = props;
  const data: BarDatum[] = bench
    ? q.candidates.filter((c) => bench.rows[c.id]?.equivalent && Number.isFinite(bench.rows[c.id].median)).map((c) => {
        const r = bench.rows[c.id];
        return { id: c.id, label: `${c.id} ${c.fingerprint}`, value: r.median, min: Math.min(...r.times), max: Math.max(...r.times), color: 'var(--accent)', oracle: bench.oracleId === c.id, detail: `runs: ${r.times.map((t) => t.toFixed(2)).join(', ')}` };
      })
    : [];
  const failed = bench ? Object.values(bench.rows).filter((r) => !r.equivalent || r.error) : [];
  return (
    <div>
      <p className="muted small">Calibration mode (Figure 3.3): every candidate is executed, compared with SQLite running your original SQL, warmed up, then timed in interleaved repetitions; the median is the label.</p>
      <div className="row">
        <label className="small muted">Warm-up <input type="number" min={0} max={10} value={props.warmup} onChange={(e) => props.setWarmup(Math.max(0, Number(e.target.value)))} style={{ width: 60 }} /></label>
        <label className="small muted">Timed runs <input type="number" min={3} max={30} value={props.reps} onChange={(e) => props.setReps(Math.max(3, Number(e.target.value)))} style={{ width: 60 }} /></label>
        <button className="btn" disabled={!props.ready || props.busy} onClick={props.onRun}>{props.busy ? 'Running…' : 'Run benchmark'}</button>
      </div>
      <div className="hint">Browser timers are coarser than Node’s (≈0.1 ms or worse), so sub-millisecond differences are not meaningful here. The offline benchmark in <code>artifacts/</code> was measured in Node and is what the model was trained on.</div>
      {props.error && <div className="diag"><b>Benchmark failed</b><pre>{props.error}</pre></div>}
      {bench && (
        <>
          <div className="card-head"><h2>Median runtime per equivalent candidate</h2><span className="spacer" /><span className="small muted">{bench.seconds.toFixed(1)} s total · ★ = fastest · whisker = min–max of runs</span></div>
          <BarChart data={data} title="Median runtime per candidate" />
          <p className="small">
            {Object.values(bench.rows).filter((r) => r.equivalent).length}/{q.candidates.length} candidates matched the SQLite reference
            (equivalence rate {fmt((100 * Object.values(bench.rows).filter((r) => r.equivalent).length) / q.candidates.length, 0)}%).
          </p>
          {failed.length > 0 && <div className="warnbox">Excluded from timing: {failed.map((r) => `${r.id} (${r.error ?? r.reason})`).join('; ')}</div>}
        </>
      )}
    </div>
  );
}

function ComparisonPanel(props: { q: CompiledQuery; selections: Partial<Record<SelectorMode, SelectionResult>>; bench: BenchState | null; onRunBenchmark: () => void }) {
  const { q, selections, bench } = props;
  if (!bench) {
    return <div><p className="muted">The comparison needs measured runtimes for this query and data profile.</p><button className="btn" onClick={props.onRunBenchmark}>Run benchmark now</button></div>;
  }
  const predicted = (selections.C as (SelectionResult & { predictedMs?: Record<string, number> }) | undefined)?.predictedMs ?? {};
  const modeName = (m: SelectorMode) =>
    m === 'B' && selections.B && !selections.B.source.startsWith('llm') ? 'AI-assisted (cost model only)' : MODE_NAMES[m];
  const rows = MODES.map((m) => {
    const s = selections[m];
    const r = s ? bench.rows[s.selectedId] : undefined;
    const measured = r && r.equivalent && Number.isFinite(r.median) ? r.median : NaN;
    return { m, s, measured, regret: measured / bench.oracleMs, hit: measured <= bench.oracleMs * 1.05 };
  });
  const allSame = new Set(rows.map((r) => r.s?.selectedId)).size === 1;
  const bars: BarDatum[] = rows.filter((r) => Number.isFinite(r.measured)).map((r) => ({
    id: r.m, label: `Mode ${r.m} → ${r.s!.selectedId}`, value: r.measured, color: MODE_COLOR[r.m], oracle: bench.oracleId === r.s!.selectedId,
    detail: `regret ${r.regret.toFixed(3)}`,
  }));
  return (
    <div>
      <Legend items={MODES.map((m) => ({ label: `Mode ${m}`, color: MODE_COLOR[m] }))} />
      <BarChart data={bars} title="Measured runtime of each mode's chosen plan" />
      <div className="scroll" style={{ marginTop: 12 }}>
        <table>
          <thead><tr><th>Mode</th><th>Selected</th><th className="num">Predicted ms</th><th className="num">Measured ms</th><th className="num">Regret</th><th>Fastest?</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.m}>
                <td><span className={`badge ${r.m.toLowerCase()}`}>{r.m}</span> {modeName(r.m)}</td>
                <td><b>{r.s?.selectedId ?? '–'}</b></td>
                <td className="num">{r.m === 'C' && r.s && predicted[r.s.selectedId] !== undefined ? fmt(predicted[r.s.selectedId], 3) : '–'}</td>
                <td className="num">{fmt(r.measured, 3)}</td>
                <td className="num">{fmt(r.regret, 3)}</td>
                <td>{r.hit ? <span className="badge good">✓ within 5% of fastest</span> : <span className="badge bad">✗</span>}</td>
              </tr>
            ))}
            <tr><td colSpan={3} className="muted">Oracle (fastest measured equivalent plan)</td><td className="num">{fmt(bench.oracleMs, 3)}</td><td className="num">1.000</td><td><b>{bench.oracleId}</b></td></tr>
          </tbody>
        </table>
      </div>
      {allSame && <div className="hint">All three modes selected the same plan ({rows[0].s?.selectedId}). That is a legitimate outcome — the value of this view is the controlled comparison, not forcing a winner.</div>}
      {q.candidates.length < 2 && <div className="hint">This query has a single candidate, so there is nothing to choose between.</div>}
      <p className="small muted">Regret = measured time of the chosen plan ÷ fastest measured time in the candidate set (1.0 is ideal). Run-to-run noise in the browser can exceed small differences; use the held-out evaluation for conclusions.</p>
    </div>
  );
}

function EvaluationPanel() {
  const [ev, setEv] = useState<any | null | undefined>(undefined);
  const [tr, setTr] = useState<any | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    Promise.all([loadEvaluation(), loadTrainReport()]).then(([e, t]) => { setEv(e); setTr(t); }).catch(() => setEv(null));
  }, []);
  if (ev === undefined) return <p className="muted">Loading…</p>;
  if (!ev || !tr) return <p className="muted">No offline evaluation artefacts found. Run <code>npm run benchmark</code>, <code>npm run train</code> and <code>npm run evaluate</code>.</p>;
  const T = ev.test;
  const rowOf = (name: string, s: any) => (
    <tr key={name}><td>{name}</td><td className="num">{fmt(s.median_selected_runtime_ms, 3)}</td><td className="num">{fmt(s.median_regret, 3)} <span className="muted">({fmt(s.median_regret_ci95[0], 3)}–{fmt(s.median_regret_ci95[1], 3)})</span></td><td className="num">{fmt(s.oracle_hit_rate_pct, 1)}</td><td className="num">{fmt(s.median_decision_latency_ms, 3)}</td><td className="num">{s.result_failures}</td></tr>
  );
  const ts = tr.test_scores;
  return (
    <div>
      <p className="muted small">Computed offline from <code>artifacts/benchmark</code> (measured in {ev.environment_id}) on {T.A.cases} test cases drawn from templates the predictor never saw. Generated {ev.generated_at}.</p>
      <h3 style={{ fontSize: 13, margin: '8px 0' }}>Table 4.3 · selector comparison (held-out)</h3>
      <div className="scroll">
        <table>
          <thead><tr><th>Strategy</th><th className="num">Median selected runtime (ms)</th><th className="num">Median regret (95% CI)</th><th className="num">Oracle-hit %</th><th className="num">Decision latency (ms)</th><th className="num">Failures</th></tr></thead>
          <tbody>{rowOf('A. Rule-based', T.A)}{rowOf(ev.llm_used ? 'B. AI-assisted' : 'B. AI-assisted (cost model only)', T.B)}{rowOf('C. Predictor-guided', T.C)}</tbody>
        </table>
      </div>
      <ul className="small">{T.paired.map((p: any) => <li key={p.a + p.b}>{p.a} − {p.b} mean regret {fmt(p.mean_regret_diff, 4)} [{fmt(p.ci95[0], 4)}, {fmt(p.ci95[1], 4)}] → <b>{p.verdict}</b></li>)}</ul>
      <h3 style={{ fontSize: 13, margin: '12px 0 8px' }}>Table 4.4 · predictor validation</h3>
      <table>
        <thead><tr><th>Measure</th><th className="num">Predictor</th><th className="num">Median baseline</th></tr></thead>
        <tbody>
          <tr><td>Held-out MAE (ms)</td><td className="num">{fmt(ts.model.mae_ms, 3)}</td><td className="num">{fmt(ts.baseline_median.mae_ms, 3)}</td></tr>
          <tr><td>Held-out RMSE (ms)</td><td className="num">{fmt(ts.model.rmse_ms, 3)}</td><td className="num">{fmt(ts.baseline_median.rmse_ms, 3)}</td></tr>
          <tr><td>Q-error median / p90</td><td className="num">{fmt(ts.model.q_error_median)} / {fmt(ts.model.q_error_p90)}</td><td className="num">{fmt(ts.baseline_median.q_error_median)} / {fmt(ts.baseline_median.q_error_p90)}</td></tr>
        </tbody>
      </table>
      <p className="small muted">Train / validation / test templates: {tr.split.train.templates.length} / {tr.split.validation.templates.length} / {tr.split.test.templates.length} · records {tr.split.train.records} / {tr.split.validation.records} / {tr.split.test.records} · model {tr.model_version}, schema {tr.schema_version}. The full tables (including leave-one-template-out) are in <code>artifacts/results/RESULTS.md</code>.</p>
    </div>
  );
}
