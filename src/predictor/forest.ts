import { FEATURE_NAMES, FEATURE_SCHEMA_VERSION } from './features';

/**
 * Browser-side inference for the scikit-learn Random Forest exported by python/train.py.
 *
 * Export format (one object per tree, parallel arrays indexed by node id):
 *   feature[i]   split feature index, or -2 for a leaf
 *   threshold[i] split threshold (go left when x <= threshold)
 *   left[i], right[i]  child node ids (-1 for a leaf)
 *   value[i]     mean target of the node (prediction when i is a leaf), in transformed space
 *
 * scikit-learn evaluates tree splits on float32 copies of the inputs, so inference rounds each
 * feature with Math.fround to reproduce its decisions exactly.
 */

export interface ExportedTree { feature: number[]; threshold: number[]; left: number[]; right: number[]; value: number[] }

export interface ForestModel {
  model_type: 'random_forest_regressor';
  model_version: string;
  schema_version: string;
  feature_names: string[];
  target_transform: 'log1p' | 'none';
  trained_at: string;
  n_estimators: number;
  trees: ExportedTree[];
}

export class ModelCompatibilityError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelCompatibilityError'; }
}

/** Throws a controlled diagnostic if the model does not match the current feature contract. */
export function assertCompatible(model: ForestModel): void {
  if (model.schema_version !== FEATURE_SCHEMA_VERSION) {
    throw new ModelCompatibilityError(`model schema '${model.schema_version}' != code schema '${FEATURE_SCHEMA_VERSION}'; re-train the predictor`);
  }
  if (model.feature_names.length !== FEATURE_NAMES.length || model.feature_names.some((n, i) => n !== FEATURE_NAMES[i])) {
    throw new ModelCompatibilityError('model feature names/order differ from the code feature schema; re-train the predictor');
  }
}

function predictTree(t: ExportedTree, x: Float32Array): number {
  let i = 0;
  while (t.feature[i] !== -2) {
    i = x[t.feature[i]] <= t.threshold[i] ? t.left[i] : t.right[i];
  }
  return t.value[i];
}

/** Predicted runtime in milliseconds for one feature vector (ordered as FEATURE_NAMES). */
export function predictMs(model: ForestModel, features: number[]): number {
  if (features.length !== model.feature_names.length) {
    throw new ModelCompatibilityError(`expected ${model.feature_names.length} features, got ${features.length}`);
  }
  if (features.some((v) => !Number.isFinite(v))) throw new ModelCompatibilityError('feature vector contains a non-finite value');
  const x = Float32Array.from(features);
  let sum = 0;
  for (const t of model.trees) sum += predictTree(t, x);
  const mean = sum / model.trees.length;
  return model.target_transform === 'log1p' ? Math.expm1(mean) : mean;
}
