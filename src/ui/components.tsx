import { ReactNode, useState } from 'react';
import { IRNode, children, nodeLabel } from '../compiler/ir';

export function PlanTree({ node, highlight }: { node: IRNode; highlight?: (n: IRNode) => boolean }) {
  return (
    <ul className="tree">
      <PlanNode node={node} highlight={highlight} />
    </ul>
  );
}

function PlanNode({ node, highlight }: { node: IRNode; highlight?: (n: IRNode) => boolean }) {
  const kids = children(node);
  const label = nodeLabel(node);
  const [op, ...rest] = label.split(' ');
  return (
    <li>
      <span className="node" style={highlight?.(node) ? { borderColor: 'var(--accent)' } : undefined}>
        <span className="op">{node.op === 'Project' && node.purpose === 'prune' ? 'Prune' : op}</span>
        <span className="lbl mono">{rest.join(' ')}</span>
        <span className="w" title={node.schema.join(', ')}>{node.schema.length} cols</span>
      </span>
      {kids.length > 0 && (
        <ul>
          {kids.map((k, i) => <PlanNode key={i} node={k} highlight={highlight} />)}
        </ul>
      )}
    </li>
  );
}

export interface BarDatum {
  id: string;
  label: string;
  value: number;
  color: string;
  min?: number;
  max?: number;
  oracle?: boolean;
  detail?: string;
}

/** Horizontal bar chart on a single zero-based axis, with per-bar hover tooltip and run-range whiskers. */
export function BarChart({ data, unit = 'ms', title }: { data: BarDatum[]; unit?: string; title: string }) {
  const [tip, setTip] = useState<{ x: number; y: number; d: BarDatum } | null>(null);
  const max = Math.max(...data.map((d) => d.max ?? d.value), 1e-9);
  const pct = (v: number) => `${Math.max((v / max) * 100, 0.4)}%`;
  return (
    <div role="img" aria-label={title}>
      <div className="bars">
        {data.map((d) => (
          <div
            key={d.id}
            className="bar-row"
            onMouseMove={(e) => setTip({ x: e.clientX + 12, y: e.clientY + 12, d })}
            onMouseLeave={() => setTip(null)}
          >
            <div className="bar-label" title={d.label}>{d.label}</div>
            <div className="bar-track">
              <div className={`bar${d.oracle ? ' oracle' : ''}`} style={{ width: pct(d.value), background: d.color }} />
              {d.min !== undefined && d.max !== undefined && (
                <div className="range" style={{ left: pct(d.min), width: `calc(${pct(d.max)} - ${pct(d.min)})` }} />
              )}
            </div>
            <div className="bar-val">{d.value.toFixed(d.value < 10 ? 2 : 1)} {unit}</div>
          </div>
        ))}
      </div>
      {tip && (
        <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
          <b>{tip.d.label}</b>
          <div>{tip.d.value.toFixed(3)} {unit}{tip.d.oracle ? ' · fastest measured' : ''}</div>
          {tip.d.detail && <div className="muted">{tip.d.detail}</div>}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>)}
    </div>
  );
}

export function Section({ title, children: kids, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <div className="card-head"><h2>{title}</h2><span className="spacer" />{aside}</div>
      {kids}
    </section>
  );
}

export const stripPos = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stripPos);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'pos').map(([k, x]) => [k, stripPos(x)]));
  }
  return v;
};
