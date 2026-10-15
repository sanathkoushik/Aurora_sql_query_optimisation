import { BExpr, IRNode, exprColumns } from '../compiler/ir';

/**
 * Lowers a relational plan to a straight-line pandas function:
 *
 *     def run(T):            # T maps table name -> DataFrame
 *         v0 = T['customers'].add_prefix('c.')
 *         ...
 *         return vN
 *
 * Every column is alias-qualified ("c.region") so joins never collide. The generated text is shown
 * verbatim in the Query Inspector.
 */

const py = (s: string) => JSON.stringify(s); // JSON string literals are valid Python string literals for our character set

function pyLiteral(v: number | string): string {
  return typeof v === 'string' ? py(v) : String(v);
}

function likeToRegex(pattern: string): string {
  let out = '';
  for (const ch of pattern) {
    if (ch === '%') out += '.*';
    else if (ch === '_') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

const isScalar = (e: BExpr) => exprColumns(e).size === 0;

function pyExpr(e: BExpr, v: string): string {
  switch (e.k) {
    case 'col': return `${v}[${py(e.name)}]`;
    case 'lit': return pyLiteral(e.value);
    case 'cmp': {
      const op = e.op === '<>' ? '!=' : e.op === '=' ? '==' : e.op;
      return `(${pyExpr(e.l, v)} ${op} ${pyExpr(e.r, v)})`;
    }
    case 'and': return isScalar(e) ? `(${pyExpr(e.l, v)} and ${pyExpr(e.r, v)})` : `(${pyExpr(e.l, v)} & ${pyExpr(e.r, v)})`;
    case 'or': return isScalar(e) ? `(${pyExpr(e.l, v)} or ${pyExpr(e.r, v)})` : `(${pyExpr(e.l, v)} | ${pyExpr(e.r, v)})`;
    case 'not': return isScalar(e) ? `(not ${pyExpr(e.e, v)})` : `(~${pyExpr(e.e, v)})`;
    case 'between': {
      const core = isScalar(e)
        ? `(${pyExpr(e.low, v)} <= ${pyExpr(e.e, v)} <= ${pyExpr(e.high, v)})`
        : `${pyExpr(e.e, v)}.between(${pyExpr(e.low, v)}, ${pyExpr(e.high, v)})`;
      return e.negated ? (isScalar(e) ? `(not ${core})` : `(~${core})`) : core;
    }
    case 'in': {
      const list = `[${e.items.map((i) => pyExpr(i, v)).join(', ')}]`;
      const core = isScalar(e) ? `(${pyExpr(e.e, v)} in ${list})` : `${pyExpr(e.e, v)}.isin(${list})`;
      return e.negated ? (isScalar(e) ? `(not ${core})` : `(~${core})`) : core;
    }
    case 'like': {
      const core = `${pyExpr(e.e, v)}.str.fullmatch(${py(likeToRegex(e.pattern))}, case=False)`;
      return e.negated ? `(~${core})` : core;
    }
  }
}

/** Boolean mask expression for `v`. A scalar predicate (no columns) is broadcast to all rows. */
function maskExpr(pred: BExpr, v: string): string {
  const body = pyExpr(pred, v);
  return isScalar(pred) ? `np.full(len(${v}), bool(${body}))` : body;
}

const AGG_PD: Record<string, string> = { COUNT: 'count', SUM: 'sum', AVG: 'mean', MIN: 'min', MAX: 'max' };

export function generatePandas(plan: IRNode): string {
  const lines: string[] = ['def run(T):'];
  let counter = 0;
  const fresh = () => `v${counter++}`;

  const emit = (n: IRNode): string => {
    switch (n.op) {
      case 'Scan': {
        const v = fresh();
        lines.push(`    ${v} = T[${py(n.table)}].add_prefix(${py(n.alias + '.')})  # Scan ${n.table}`);
        return v;
      }
      case 'Filter': {
        const c = emit(n.child);
        const v = fresh();
        lines.push(`    ${v} = ${c}[${maskExpr(n.pred, c)}]  # Filter`);
        return v;
      }
      case 'Having': {
        const c = emit(n.child);
        const v = fresh();
        lines.push(`    ${v} = ${c}[${maskExpr(n.pred, c)}]  # Having`);
        return v;
      }
      case 'Project': {
        const c = emit(n.child);
        const v = fresh();
        const srcs = `[${n.cols.map((x) => py(x.src)).join(', ')}]`;
        const renamed = n.cols.some((x) => x.src !== x.as);
        lines.push(`    ${v} = ${c}[${srcs}]${renamed ? `.set_axis([${n.cols.map((x) => py(x.as)).join(', ')}], axis=1)` : ''}  # ${n.purpose === 'prune' ? 'Prune' : 'Project'}`);
        return v;
      }
      case 'Join': {
        const l = emit(n.left);
        const r = emit(n.right);
        const v = fresh();
        const lk = `[${n.keys.map((k) => py(k.l)).join(', ')}]`;
        const rk = `[${n.keys.map((k) => py(k.r)).join(', ')}]`;
        lines.push(`    ${v} = ${l}.merge(${r}, left_on=${lk}, right_on=${rk}, how='inner', sort=False)  # Join`);
        return v;
      }
      case 'Aggregate': {
        const c = emit(n.child);
        const v = fresh();
        if (n.groupBy.length) {
          const specs = n.aggs.map((a) => {
            const col = a.arg ?? n.child.schema[0];
            const fn = a.fn === 'COUNT' && a.arg === null ? 'size' : AGG_PD[a.fn];
            return `${py(a.as)}: (${py(col)}, ${py(fn)})`;
          });
          lines.push(`    ${v} = ${c}.groupby([${n.groupBy.map(py).join(', ')}], sort=False).agg(**{${specs.join(', ')}}).reset_index()  # Aggregate`);
        } else {
          const cells = n.aggs.map((a) => {
            let expr: string;
            if (a.fn === 'COUNT') return `${py(a.as)}: [len(${c})]`;
            const col = `${c}[${py(a.arg!)}]`;
            expr = `${col}.${AGG_PD[a.fn]}()`;
            // SQL aggregates over an empty input (other than COUNT) are NULL, not 0.
            return `${py(a.as)}: [${expr} if len(${c}) else float('nan')]`;
          });
          lines.push(`    ${v} = pd.DataFrame({${cells.join(', ')}})  # Aggregate (global)`);
        }
        return v;
      }
      case 'Sort': {
        const c = emit(n.child);
        const v = fresh();
        lines.push(`    ${v} = ${c}.sort_values(by=[${n.keys.map((k) => py(k.col)).join(', ')}], ascending=[${n.keys.map((k) => (k.desc ? 'False' : 'True')).join(', ')}], kind='mergesort')  # Sort`);
        return v;
      }
    }
  };

  const result = emit(plan);
  lines.push(`    return ${result}`);
  return lines.join('\n') + '\n';
}
