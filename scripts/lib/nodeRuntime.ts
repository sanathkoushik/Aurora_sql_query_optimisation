import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuroraRuntime, PyodideLike } from '../../src/runtime/runtime';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..');

/** Boot the same Pyodide build used in the browser demo, inside Node (WebAssembly). */
export async function createNodeRuntime(): Promise<AuroraRuntime> {
  const { loadPyodide } = await import('pyodide');
  const py = (await loadPyodide({
    indexURL: join(ROOT, 'node_modules', 'pyodide'),
    packageCacheDir: join(ROOT, '.pyodide-cache'),
  })) as unknown as PyodideLike;
  const source = readFileSync(join(ROOT, 'python', 'aurora_runtime.py'), 'utf8');
  return AuroraRuntime.create(py, source);
}
