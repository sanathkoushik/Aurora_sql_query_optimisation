/** Thin typed wrapper around the Python runtime (python/aurora_runtime.py) hosted in Pyodide. */

export interface PyodideLike {
  runPython(code: string): unknown;
  globals: { get(name: string): any };
  loadPackage(names: string | string[], options?: Record<string, unknown>): Promise<unknown>;
}

export interface ColumnProfile {
  distinct: number;
  min: number | string;
  max: number | string;
  /** Exact value -> fraction map for low-cardinality text columns. */
  freq?: Record<string, number>;
}
export interface TableProfile { rows: number; columns: Record<string, ColumnProfile> }
export interface DataProfile { profileId: string; tables: Record<string, TableProfile> }

export interface EnvironmentInfo {
  runtime: string; python: string; platform: string; pandas: string; numpy: string; sqlite: string;
}

export interface TimingResult { times_ms: number[]; error: string | null }
export interface VerifyResult { equivalent: boolean; reason: string; rows: number }
export interface VerifyReport {
  reference_error: string | null;
  reference_rows?: number;
  results: Record<string, VerifyResult>;
}
export interface DisplayResult { columns: string[]; rows: unknown[][]; row_count: number; elapsed_ms: number }

export const PYODIDE_VERSION = '0.27.8';
export const PYODIDE_PACKAGES = ['numpy', 'pandas', 'sqlite3'];

export class AuroraRuntime {
  private constructor(private readonly py: PyodideLike) {}

  /** Load packages and the Python runtime module into an existing Pyodide instance. */
  static async create(py: PyodideLike, pythonSource: string): Promise<AuroraRuntime> {
    await py.loadPackage(PYODIDE_PACKAGES);
    py.runPython(pythonSource);
    return new AuroraRuntime(py);
  }

  private call(name: string, ...args: unknown[]): string {
    const fn = this.py.globals.get(name);
    try {
      return fn(...args) as string;
    } finally {
      fn.destroy?.();
    }
  }

  environment(): EnvironmentInfo {
    return JSON.parse(this.call('environment_info'));
  }

  /** Generate (deterministically) and load the benchmark database; returns its exact data profile. */
  loadProfile(profileId: string): DataProfile {
    return { profileId, tables: JSON.parse(this.call('load_profile', profileId)) };
  }

  timeCandidates(codes: Record<string, string>, warmup: number, reps: number): Record<string, TimingResult> {
    return JSON.parse(this.call('time_candidates', JSON.stringify(codes), warmup, reps));
  }

  verify(codes: Record<string, string>, sql: string, orderPositions: number[]): VerifyReport {
    return JSON.parse(this.call('verify_candidates', JSON.stringify(codes), sql, JSON.stringify(orderPositions)));
  }

  runForDisplay(code: string, limit = 20): DisplayResult {
    return JSON.parse(this.call('run_for_display', code, limit));
  }
}
