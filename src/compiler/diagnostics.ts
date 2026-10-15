export type Stage = 'lexical' | 'syntax' | 'semantic' | 'planning';

export interface SourcePos {
  offset: number;
  line: number;
  col: number;
}

/** A located compiler diagnostic. Every stage reports these instead of throwing raw strings. */
export interface Diagnostic {
  stage: Stage;
  message: string;
  pos: SourcePos;
  length: number;
}

export class CompileError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join('\n'));
    this.name = 'CompileError';
    this.diagnostics = diagnostics;
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  return `${d.stage} error at ${d.pos.line}:${d.pos.col}: ${d.message}`;
}

export function diag(stage: Stage, message: string, pos: SourcePos, length = 1): Diagnostic {
  return { stage, message, pos, length };
}
