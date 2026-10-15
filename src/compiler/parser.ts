import {
  AggCall, AggFunc, ColumnRef, CompareOp, Expr, JoinClause, NumberLit, OrderItem, SelectItem,
  SelectStmt, StringLit, TableRef,
} from './ast';
import { CompileError, Diagnostic, diag } from './diagnostics';
import { Token, UNSUPPORTED_KEYWORDS, tokenize } from './lexer';

/**
 * Recursive-descent parser for the supported SELECT subset.
 *
 *   select    := SELECT selectList FROM table { [INNER] JOIN table ON joinCond }
 *                [WHERE expr] [GROUP BY colList] [HAVING expr] [ORDER BY orderList] [;]
 *   expr      := orExpr
 *   orExpr    := andExpr { OR andExpr }
 *   andExpr   := notExpr { AND notExpr }
 *   notExpr   := NOT notExpr | predicate
 *   predicate := operand [ cmp operand | [NOT] BETWEEN operand AND operand
 *                        | [NOT] IN '(' operand {, operand} ')' | [NOT] LIKE string ]
 *   operand   := column | number | string | aggCall | '-' number | '(' expr ')'
 *
 * Precedence (loosest to tightest): OR < AND < NOT < comparison. Unsupported SQL produces a
 * diagnostic; nothing falls through silently.
 */
export function parse(source: string): { ast: SelectStmt; tokens: Token[] } {
  const { tokens, diagnostics } = tokenize(source);
  if (diagnostics.length) throw new CompileError(diagnostics);
  const parser = new Parser(tokens);
  const ast = parser.parseSelect();
  return { ast, tokens };
}

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  private get cur(): Token { return this.toks[this.i]; }
  private peek(n = 1): Token { return this.toks[Math.min(this.i + n, this.toks.length - 1)]; }

  private fail(message: string, tok: Token = this.cur): never {
    const d: Diagnostic = diag('syntax', message, tok.pos, Math.max(tok.lexeme.length, 1));
    throw new CompileError([d]);
  }

  private describe(t: Token): string {
    return t.type === 'EOF' ? 'end of input' : `'${t.lexeme}'`;
  }

  private isKw(kw: string, tok: Token = this.cur): boolean {
    return tok.type === 'KEYWORD' && tok.text === kw;
  }
  private isPunct(p: string, tok: Token = this.cur): boolean {
    return tok.type === 'PUNCT' && tok.text === p;
  }

  private eatKw(kw: string): Token | null {
    if (this.isKw(kw)) return this.toks[this.i++];
    return null;
  }
  private expectKw(kw: string): Token {
    const t = this.eatKw(kw);
    if (!t) this.fail(`Expected ${kw} but found ${this.describe(this.cur)}`);
    return t;
  }
  private expectPunct(p: string): Token {
    if (this.isPunct(p)) return this.toks[this.i++];
    return this.fail(`Expected '${p}' but found ${this.describe(this.cur)}`);
  }

  private rejectUnsupportedKeyword(): void {
    if (this.cur.type === 'KEYWORD' && UNSUPPORTED_KEYWORDS.has(this.cur.text)) {
      this.fail(`${this.cur.text} is not supported by Aurora's SQL subset`);
    }
  }

  // ---- statement -------------------------------------------------------------------------

  parseSelect(): SelectStmt {
    this.expectKw('SELECT');
    this.rejectUnsupportedKeyword();

    let star = false;
    const items: SelectItem[] = [];
    if (this.isPunct('*')) {
      this.i++;
      star = true;
    } else {
      items.push(this.parseSelectItem());
      while (this.isPunct(',')) {
        this.i++;
        items.push(this.parseSelectItem());
      }
    }

    this.expectKw('FROM');
    const from = this.parseTableRef();

    const joins: JoinClause[] = [];
    for (;;) {
      this.rejectUnsupportedKeyword();
      if (this.isKw('INNER') || this.isKw('JOIN')) {
        const start = this.cur;
        if (this.eatKw('INNER')) this.expectKw('JOIN');
        else this.i++; // JOIN
        const table = this.parseTableRef();
        this.expectKw('ON');
        const on = this.parseExpr();
        joins.push({ table, on, pos: start.pos });
      } else break;
    }
    if (this.isPunct(',')) this.fail('Comma joins are not supported; use INNER JOIN ... ON');

    let where: Expr | undefined;
    if (this.eatKw('WHERE')) where = this.parseExpr();

    const groupBy: ColumnRef[] = [];
    if (this.eatKw('GROUP')) {
      this.expectKw('BY');
      groupBy.push(this.parseColumnRef());
      while (this.isPunct(',')) { this.i++; groupBy.push(this.parseColumnRef()); }
    }

    let having: Expr | undefined;
    if (this.eatKw('HAVING')) having = this.parseExpr();

    const orderBy: OrderItem[] = [];
    if (this.eatKw('ORDER')) {
      this.expectKw('BY');
      orderBy.push(this.parseOrderItem());
      while (this.isPunct(',')) { this.i++; orderBy.push(this.parseOrderItem()); }
    }

    if (this.isPunct(';')) this.i++;
    this.rejectUnsupportedKeyword();
    if (this.cur.type !== 'EOF') {
      this.fail(`Unexpected ${this.describe(this.cur)}; expected end of query`);
    }
    return { kind: 'select', star, items, from, joins, where, groupBy, having, orderBy };
  }

  private parseSelectItem(): SelectItem {
    const start = this.cur;
    this.rejectUnsupportedKeyword();
    const expr = this.parseColumnOrAgg('a select item');
    let alias: string | undefined;
    if (this.eatKw('AS')) {
      alias = this.expectIdent('an alias after AS').text;
    } else if (this.cur.type === 'IDENT') {
      alias = this.toks[this.i++].text;
    }
    return { expr, alias, pos: start.pos };
  }

  private parseOrderItem(): OrderItem {
    const start = this.cur;
    const expr = this.parseColumnOrAgg('an ORDER BY key');
    let desc = false;
    if (this.eatKw('DESC')) desc = true;
    else this.eatKw('ASC');
    return { expr, desc, pos: start.pos };
  }

  private parseTableRef(): TableRef {
    const nameTok = this.expectIdent('a table name');
    let alias: string | undefined;
    if (this.eatKw('AS')) alias = this.expectIdent('an alias after AS').text;
    else if (this.cur.type === 'IDENT') alias = this.toks[this.i++].text;
    return { name: nameTok.text, alias, pos: nameTok.pos };
  }

  private expectIdent(what: string): Token {
    if (this.cur.type === 'IDENT') return this.toks[this.i++];
    return this.fail(`Expected ${what} but found ${this.describe(this.cur)}`);
  }

  // ---- column / aggregate ----------------------------------------------------------------

  private parseColumnRef(): ColumnRef {
    const first = this.expectIdent('a column name');
    if (this.isPunct('.')) {
      this.i++;
      const second = this.expectIdent('a column name after "."');
      return { kind: 'column', table: first.text, name: second.text, pos: first.pos };
    }
    return { kind: 'column', name: first.text, pos: first.pos };
  }

  private static readonly AGG_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

  private parseColumnOrAgg(what: string): ColumnRef | AggCall {
    if (this.cur.type === 'KEYWORD' && Parser.AGG_FUNCS.has(this.cur.text)) return this.parseAgg();
    if (this.cur.type === 'IDENT') return this.parseColumnRef();
    return this.fail(`Expected a column or aggregate function for ${what} but found ${this.describe(this.cur)}`);
  }

  private parseAgg(): AggCall {
    const fn = this.toks[this.i++];
    this.expectPunct('(');
    let arg: ColumnRef | null = null;
    if (this.isPunct('*')) {
      if (fn.text !== 'COUNT') this.fail(`${fn.text}(*) is not valid; only COUNT(*) accepts '*'`, fn);
      this.i++;
    } else {
      if (this.isKw('DISTINCT')) this.fail('DISTINCT inside aggregates is not supported by Aurora\'s SQL subset');
      arg = this.parseColumnRef();
    }
    this.expectPunct(')');
    return { kind: 'agg', func: fn.text as AggFunc, arg, pos: fn.pos };
  }

  // ---- expressions -----------------------------------------------------------------------

  parseExpr(): Expr { return this.parseOr(); }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isKw('OR')) {
      const t = this.toks[this.i++];
      left = { kind: 'or', left, right: this.parseAnd(), pos: t.pos };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.isKw('AND')) {
      const t = this.toks[this.i++];
      left = { kind: 'and', left, right: this.parseNot(), pos: t.pos };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.isKw('NOT')) {
      const t = this.toks[this.i++];
      return { kind: 'not', operand: this.parseNot(), pos: t.pos };
    }
    return this.parsePredicate();
  }

  private parsePredicate(): Expr {
    const left = this.parseOperand();
    // A parenthesised boolean sub-expression is already a complete predicate.
    if (['compare', 'and', 'or', 'not', 'between', 'in', 'like'].includes(left.kind)) return left;
    const t = this.cur;

    if (t.type === 'OP' && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(t.text)) {
      this.i++;
      const op: CompareOp = t.text === '!=' ? '<>' : (t.text as CompareOp);
      return { kind: 'compare', op, left, right: this.parseOperand(), pos: t.pos };
    }

    let negated = false;
    if (this.isKw('NOT') && (this.isKw('BETWEEN', this.peek()) || this.isKw('IN', this.peek()) || this.isKw('LIKE', this.peek()))) {
      negated = true;
      this.i++;
    }
    if (this.isKw('BETWEEN')) {
      const kw = this.toks[this.i++];
      const low = this.parseOperand();
      this.expectKw('AND');
      const high = this.parseOperand();
      return { kind: 'between', operand: left, low, high, negated, pos: kw.pos };
    }
    if (this.isKw('IN')) {
      const kw = this.toks[this.i++];
      this.expectPunct('(');
      if (this.isKw('SELECT')) this.fail('Subqueries are not supported by Aurora\'s SQL subset');
      const items: Expr[] = [this.parseOperand()];
      while (this.isPunct(',')) { this.i++; items.push(this.parseOperand()); }
      this.expectPunct(')');
      return { kind: 'in', operand: left, items, negated, pos: kw.pos };
    }
    if (this.isKw('LIKE')) {
      const kw = this.toks[this.i++];
      if (this.cur.type !== 'STRING') this.fail(`LIKE requires a string pattern but found ${this.describe(this.cur)}`);
      const s = this.toks[this.i++];
      const pattern: StringLit = { kind: 'string', value: s.text, pos: s.pos };
      return { kind: 'like', operand: left, pattern, negated, pos: kw.pos };
    }
    if (this.isKw('IS')) this.fail('IS [NOT] NULL is not supported (Aurora assumes NULL-free tables)');
    // A bare operand is not a boolean predicate in this grammar.
    return this.fail(`Expected a comparison operator, BETWEEN, IN or LIKE after ${this.describeExpr(left)} but found ${this.describe(this.cur)}`);
  }

  private describeExpr(e: Expr): string {
    switch (e.kind) {
      case 'column': return `column '${e.table ? e.table + '.' : ''}${e.name}'`;
      case 'number': return `number ${e.value}`;
      case 'string': return `string '${e.value}'`;
      case 'agg': return `${e.func}(...)`;
      default: return 'expression';
    }
  }

  private parseOperand(): Expr {
    const t = this.cur;
    this.rejectUnsupportedKeyword();
    if (t.type === 'NUMBER') {
      this.i++;
      const n: NumberLit = { kind: 'number', value: t.value!, isFloat: !!t.isFloat, pos: t.pos };
      return n;
    }
    if (t.type === 'OP' && t.text === '-') {
      this.i++;
      const num = this.cur;
      if (num.type !== 'NUMBER') this.fail(`Expected a number after '-' but found ${this.describe(num)}`);
      this.i++;
      return { kind: 'number', value: -num.value!, isFloat: !!num.isFloat, pos: t.pos };
    }
    if (t.type === 'STRING') {
      this.i++;
      return { kind: 'string', value: t.text, pos: t.pos };
    }
    if (t.type === 'KEYWORD' && Parser.AGG_FUNCS.has(t.text)) return this.parseAgg();
    if (t.type === 'IDENT') return this.parseColumnRef();
    if (this.isPunct('(')) {
      this.i++;
      if (this.isKw('SELECT')) this.fail('Subqueries are not supported by Aurora\'s SQL subset');
      const e = this.parseExpr();
      this.expectPunct(')');
      return e;
    }
    return this.fail(`Expected a column, literal or '(' but found ${this.describe(t)}`);
  }
}
