import { Diagnostic, SourcePos, diag } from './diagnostics';

/**
 * Lexical analysis driven by an explicitly constructed DFA.
 *
 * The automaton is encoded as a transition function `delta(state, char)` over a small set of
 * character classes. The scanner applies the maximal-munch rule: it keeps consuming while the
 * DFA has a transition and remembers the last accepting state, then backs up to it.
 */

export type TokenType = 'KEYWORD' | 'IDENT' | 'NUMBER' | 'STRING' | 'OP' | 'PUNCT' | 'EOF';

export interface Token {
  type: TokenType;
  /** Canonical text: upper-case for keywords, raw for identifiers, decoded for strings. */
  text: string;
  /** Original source slice. */
  lexeme: string;
  pos: SourcePos;
  /** Numeric value for NUMBER tokens. */
  value?: number;
  /** True when a NUMBER token contained a decimal point. */
  isFloat?: boolean;
}

export const SUPPORTED_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'ON', 'GROUP', 'BY', 'HAVING', 'ORDER',
  'ASC', 'DESC', 'AS', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
]);

/** Reserved words that are lexed but rejected by the parser with a precise "unsupported" message. */
export const UNSUPPORTED_KEYWORDS = new Set([
  'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'UNION', 'INTERSECT', 'EXCEPT',
  'LIMIT', 'OFFSET', 'DISTINCT', 'ALL', 'OVER', 'PARTITION', 'WITH', 'EXISTS', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'IS', 'NULL', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER',
]);

// ---------------------------------------------------------------------------------------------
// DFA definition
// ---------------------------------------------------------------------------------------------

export enum S {
  START, IDENT, INT, DOT_PENDING, FLOAT,
  STR_BODY, STR_QUOTE, STR_DONE,
  LT, GT, EQ, BANG, NEQ, LE, GE, NE2,
  MINUS, COMMENT_LINE, SLASH, COMMENT_BLOCK, COMMENT_BLOCK_STAR, COMMENT_BLOCK_DONE,
  PUNCT, PLUS_STAR_PCT,
  DEAD,
}

type CharClass = 'letter' | 'digit' | 'dot' | 'quote' | 'lt' | 'gt' | 'eq' | 'bang' | 'minus' | 'slash' | 'star' | 'newline' | 'punct' | 'space' | 'other';

function classify(ch: string): CharClass {
  if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') return 'letter';
  if (ch >= '0' && ch <= '9') return 'digit';
  switch (ch) {
    case '.': return 'dot';
    case "'": return 'quote';
    case '<': return 'lt';
    case '>': return 'gt';
    case '=': return 'eq';
    case '!': return 'bang';
    case '-': return 'minus';
    case '/': return 'slash';
    case '*': return 'star';
    case '\n': return 'newline';
    case ',': case '(': case ')': case ';': return 'punct';
    case ' ': case '\t': case '\r': return 'space';
    default: return 'other';
  }
}

/** The transition function delta: Q x Sigma -> Q (S.DEAD means "no transition"). */
export function delta(state: S, ch: string): S {
  const c = classify(ch);
  switch (state) {
    case S.START:
      switch (c) {
        case 'letter': return S.IDENT;
        case 'digit': return S.INT;
        case 'quote': return S.STR_BODY;
        case 'lt': return S.LT;
        case 'gt': return S.GT;
        case 'eq': return S.EQ;
        case 'bang': return S.BANG;
        case 'minus': return S.MINUS;
        case 'slash': return S.SLASH;
        case 'star': return S.PLUS_STAR_PCT;
        case 'punct': return S.PUNCT;
        case 'dot': return S.PUNCT; // qualified-name separator
        default: return S.DEAD;
      }
    case S.IDENT: return c === 'letter' || c === 'digit' ? S.IDENT : S.DEAD;
    case S.INT:
      if (c === 'digit') return S.INT;
      if (c === 'dot') return S.DOT_PENDING;
      return S.DEAD;
    case S.DOT_PENDING: return c === 'digit' ? S.FLOAT : S.DEAD;
    case S.FLOAT: return c === 'digit' ? S.FLOAT : S.DEAD;
    case S.STR_BODY: return c === 'quote' ? S.STR_QUOTE : S.STR_BODY; // any char (incl. newline) inside
    case S.STR_QUOTE: return c === 'quote' ? S.STR_BODY : S.DEAD; // '' is an escaped quote
    case S.LT:
      if (c === 'eq') return S.LE;
      if (c === 'gt') return S.NE2;
      return S.DEAD;
    case S.GT: return c === 'eq' ? S.GE : S.DEAD;
    case S.BANG: return c === 'eq' ? S.NEQ : S.DEAD;
    case S.MINUS: return c === 'minus' ? S.COMMENT_LINE : S.DEAD;
    case S.COMMENT_LINE: return c === 'newline' ? S.DEAD : S.COMMENT_LINE;
    case S.SLASH: return c === 'star' ? S.COMMENT_BLOCK : S.DEAD;
    case S.COMMENT_BLOCK: return c === 'star' ? S.COMMENT_BLOCK_STAR : S.COMMENT_BLOCK;
    case S.COMMENT_BLOCK_STAR:
      if (c === 'slash') return S.COMMENT_BLOCK_DONE;
      if (c === 'star') return S.COMMENT_BLOCK_STAR;
      return S.COMMENT_BLOCK;
    default: return S.DEAD;
  }
}

/** Accepting states and the token they emit. Comments are accepted but discarded. */
const ACCEPT: Partial<Record<S, TokenType | 'COMMENT'>> = {
  [S.IDENT]: 'IDENT',
  [S.INT]: 'NUMBER',
  [S.FLOAT]: 'NUMBER',
  [S.STR_QUOTE]: 'STRING',
  [S.LT]: 'OP', [S.GT]: 'OP', [S.EQ]: 'OP', [S.NEQ]: 'OP', [S.LE]: 'OP', [S.GE]: 'OP', [S.NE2]: 'OP',
  [S.MINUS]: 'OP',
  [S.PLUS_STAR_PCT]: 'PUNCT',
  [S.PUNCT]: 'PUNCT',
  [S.COMMENT_LINE]: 'COMMENT',
  [S.COMMENT_BLOCK_DONE]: 'COMMENT',
};

export interface LexResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
}

export function tokenize(source: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (text: string) => {
    for (const ch of text) {
      if (ch === '\n') { line++; col = 1; } else col++;
    }
  };

  while (i < source.length) {
    const startPos: SourcePos = { offset: i, line, col };
    const first = source[i];

    // whitespace is skipped without entering the token DFA
    if (classify(first) === 'space' || first === '\n') {
      advance(first);
      i++;
      continue;
    }

    // run the DFA (maximal munch with last-accept backtracking)
    let state: S = S.START;
    let j = i;
    let lastAccept = -1;
    let lastAcceptState: S = S.DEAD;
    while (j < source.length) {
      const next = delta(state, source[j]);
      if (next === S.DEAD) break;
      state = next;
      j++;
      if (ACCEPT[state] !== undefined) { lastAccept = j; lastAcceptState = state; }
    }

    if (lastAccept < 0) {
      // Distinguish an unterminated string/comment from a stray symbol for better messages.
      if (state === S.STR_BODY) {
        diagnostics.push(diag('lexical', 'Unterminated string literal', startPos, source.length - i));
        advance(source.slice(i));
        i = source.length;
      } else if (state === S.COMMENT_BLOCK || state === S.COMMENT_BLOCK_STAR) {
        diagnostics.push(diag('lexical', 'Unterminated block comment', startPos, source.length - i));
        advance(source.slice(i));
        i = source.length;
      } else {
        diagnostics.push(diag('lexical', `Invalid symbol '${first}'`, startPos));
        advance(first);
        i++;
      }
      continue;
    }

    // unterminated string whose prefix happened to be accepted (e.g. 'abc'' ...) is impossible:
    // STR_QUOTE is only accepting when the closing quote is not followed by another quote.
    const lexeme = source.slice(i, lastAccept);
    const kind = ACCEPT[lastAcceptState]!;
    if (kind !== 'COMMENT') {
      tokens.push(makeToken(kind, lexeme, startPos));
    }
    advance(lexeme);
    i = lastAccept;
  }

  // A trailing unterminated block/line construct is reported above; add EOF.
  tokens.push({ type: 'EOF', text: '<EOF>', lexeme: '', pos: { offset: source.length, line, col } });
  return { tokens, diagnostics };
}

function makeToken(kind: TokenType, lexeme: string, pos: SourcePos): Token {
  switch (kind) {
    case 'IDENT': {
      const upper = lexeme.toUpperCase();
      if (SUPPORTED_KEYWORDS.has(upper) || UNSUPPORTED_KEYWORDS.has(upper)) {
        return { type: 'KEYWORD', text: upper, lexeme, pos };
      }
      return { type: 'IDENT', text: lexeme, lexeme, pos };
    }
    case 'NUMBER':
      return { type: 'NUMBER', text: lexeme, lexeme, pos, value: Number(lexeme), isFloat: lexeme.includes('.') };
    case 'STRING':
      return { type: 'STRING', text: lexeme.slice(1, -1).replace(/''/g, "'"), lexeme, pos };
    default:
      return { type: kind, text: lexeme, lexeme, pos };
  }
}

/** Human-readable DFA description used by the Query Inspector's lexer panel. */
export const DFA_DESCRIPTION = {
  states: Object.keys(S).filter((k) => isNaN(Number(k))),
  accepting: Object.entries(ACCEPT).map(([s, t]) => ({ state: S[Number(s)], token: t })),
};
