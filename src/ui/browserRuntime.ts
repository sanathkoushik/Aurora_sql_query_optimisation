import pythonSource from '../../python/aurora_runtime.py?raw';
import { AuroraRuntime, PYODIDE_VERSION, PyodideLike } from '../runtime/runtime';
import type { ForestModel } from '../predictor/forest';

const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/** Boot Pyodide from the CDN (same pinned version as the Node benchmark) and load the runtime. */
export async function bootRuntime(onStatus: (s: string) => void): Promise<AuroraRuntime> {
  onStatus('Downloading Pyodide…');
  const mod = await import(/* @vite-ignore */ `${CDN}pyodide.mjs`);
  const py = (await mod.loadPyodide({ indexURL: CDN })) as PyodideLike;
  onStatus('Loading pandas, numpy and sqlite3…');
  return AuroraRuntime.create(py, pythonSource);
}

const modelFiles = import.meta.glob('../../artifacts/model/aurora_rf_v1.json', { import: 'default' });
const evalFiles = import.meta.glob('../../artifacts/results/evaluation.json', { import: 'default' });
const trainFiles = import.meta.glob('../../artifacts/model/train_report.json', { import: 'default' });

const first = async <T,>(files: Record<string, () => Promise<unknown>>): Promise<T | null> => {
  const loader = Object.values(files)[0];
  return loader ? ((await loader()) as T) : null;
};

export const loadModel = () => first<ForestModel>(modelFiles);
export const loadEvaluation = () => first<any>(evalFiles);
export const loadTrainReport = () => first<any>(trainFiles);
