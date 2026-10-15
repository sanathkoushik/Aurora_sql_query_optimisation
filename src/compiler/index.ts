import { SelectStmt } from './ast';
import { Candidate, generateCandidates } from './candidates';
import { Catalog, ECOMMERCE_CATALOG } from './catalog';
import { CompileError, Diagnostic } from './diagnostics';
import { IRNode } from './ir';
import { Token, tokenize } from './lexer';
import { parse } from './parser';
import { BoundQuery, analyze } from './semantic';

export * from './ast';
export * from './candidates';
export * from './catalog';
export * from './diagnostics';
export * from './ir';
export * from './lexer';
export { parse } from './parser';
export * from './semantic';

export interface CompiledQuery {
  sql: string;
  tokens: Token[];
  ast: SelectStmt;
  bound: BoundQuery;
  /** P1: the canonical (untransformed) logical plan. */
  logicalPlan: IRNode;
  candidates: Candidate[];
}

/** Full deterministic front end: lex -> parse -> semantic analysis -> IR -> candidate plans. */
export function compile(sql: string, catalog: Catalog = ECOMMERCE_CATALOG): CompiledQuery {
  const { ast, tokens } = parse(sql);
  const bound = analyze(ast, catalog);
  const candidates = generateCandidates(bound);
  return { sql, tokens, ast, bound, logicalPlan: candidates[0].plan, candidates };
}

export type CompileOutcome =
  | { ok: true; result: CompiledQuery }
  | { ok: false; diagnostics: Diagnostic[]; tokens: Token[] };

/** Non-throwing variant for the UI: returns diagnostics (and whatever tokens were produced). */
export function tryCompile(sql: string, catalog: Catalog = ECOMMERCE_CATALOG): CompileOutcome {
  const lexed = tokenize(sql);
  try {
    return { ok: true, result: compile(sql, catalog) };
  } catch (e) {
    if (e instanceof CompileError) return { ok: false, diagnostics: e.diagnostics, tokens: lexed.tokens };
    throw e;
  }
}
