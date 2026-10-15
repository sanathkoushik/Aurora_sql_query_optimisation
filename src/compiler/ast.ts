import { SourcePos } from './diagnostics';

export type AggFunc = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
export type CompareOp = '=' | '<>' | '<' | '<=' | '>' | '>=';

export interface ColumnRef { kind: 'column'; table?: string; name: string; pos: SourcePos }
export interface NumberLit { kind: 'number'; value: number; isFloat: boolean; pos: SourcePos }
export interface StringLit { kind: 'string'; value: string; pos: SourcePos }
export interface AggCall {
  kind: 'agg';
  func: AggFunc;
  /** null for COUNT(*) */
  arg: ColumnRef | null;
  pos: SourcePos;
}
export interface Compare { kind: 'compare'; op: CompareOp; left: Expr; right: Expr; pos: SourcePos }
export interface Logical { kind: 'and' | 'or'; left: Expr; right: Expr; pos: SourcePos }
export interface Not { kind: 'not'; operand: Expr; pos: SourcePos }
export interface Between { kind: 'between'; operand: Expr; low: Expr; high: Expr; negated: boolean; pos: SourcePos }
export interface InList { kind: 'in'; operand: Expr; items: Expr[]; negated: boolean; pos: SourcePos }
export interface Like { kind: 'like'; operand: Expr; pattern: StringLit; negated: boolean; pos: SourcePos }

export type Expr =
  | ColumnRef | NumberLit | StringLit | AggCall
  | Compare | Logical | Not | Between | InList | Like;

export interface SelectItem { expr: ColumnRef | AggCall; alias?: string; pos: SourcePos }
export interface TableRef { name: string; alias?: string; pos: SourcePos }
export interface JoinClause { table: TableRef; on: Expr; pos: SourcePos }
export interface OrderItem { expr: ColumnRef | AggCall; desc: boolean; pos: SourcePos }

export interface SelectStmt {
  kind: 'select';
  star: boolean;
  items: SelectItem[];
  from: TableRef;
  joins: JoinClause[];
  where?: Expr;
  groupBy: ColumnRef[];
  having?: Expr;
  orderBy: OrderItem[];
}

/** Compact S-expression rendering of an expression (used in the AST viewer and plan labels). */
export function exprToString(e: Expr): string {
  switch (e.kind) {
    case 'column': return e.table ? `${e.table}.${e.name}` : e.name;
    case 'number': return String(e.value);
    case 'string': return `'${e.value.replace(/'/g, "''")}'`;
    case 'agg': return `${e.func}(${e.arg ? exprToString(e.arg) : '*'})`;
    case 'compare': return `${exprToString(e.left)} ${e.op} ${exprToString(e.right)}`;
    case 'and': return `(${exprToString(e.left)} AND ${exprToString(e.right)})`;
    case 'or': return `(${exprToString(e.left)} OR ${exprToString(e.right)})`;
    case 'not': return `NOT ${exprToString(e.operand)}`;
    case 'between':
      return `${exprToString(e.operand)} ${e.negated ? 'NOT ' : ''}BETWEEN ${exprToString(e.low)} AND ${exprToString(e.high)}`;
    case 'in':
      return `${exprToString(e.operand)} ${e.negated ? 'NOT ' : ''}IN (${e.items.map(exprToString).join(', ')})`;
    case 'like':
      return `${exprToString(e.operand)} ${e.negated ? 'NOT ' : ''}LIKE ${exprToString(e.pattern)}`;
  }
}
