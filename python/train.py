"""Offline training of Aurora's runtime predictor (Random Forest regressor).

    python python/train.py [--records artifacts/benchmark/records.jsonl] [--out artifacts/model]

Protocol (report sections 3.7-3.8):
  * records come only from measured, result-equivalent candidate executions (artifacts/benchmark);
  * the train / validation / test partition is by QUERY TEMPLATE (fixed in src/data/workloads.ts
    before any measurement), so no template appears on both sides of a split;
  * hyper-parameters (and whether to use a log1p target) are chosen on the validation partition
    only; the test partition is used once, for reporting;
  * the final model is refit on train+validation with the chosen configuration;
  * a median-runtime baseline predictor is reported next to the model;
  * leave-one-template-out CV over all templates measures stability on unseen query groups.

The fitted forest is exported as plain JSON arrays for the TypeScript interpreter, together with
a parity fixture (inputs + sklearn outputs) used by the test-suite.
"""
from __future__ import annotations

import argparse
import itertools
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor

SEED = 20260101
Q_FLOOR_MS = 0.01  # documented floor for the multiplicative (Q-error) metric

ROOT = Path(__file__).resolve().parent.parent


def load_records(path: Path) -> tuple[pd.DataFrame, list[str]]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf8").splitlines() if line.strip()]
    if not rows:
        raise SystemExit(f"no records in {path}")
    feature_names = list(rows[0]["features"].keys())
    flat = []
    for r in rows:
        flat.append({
            "template": r["query_template_id"], "profile": r["data_profile_id"], "candidate": r["candidate_id"],
            "split": r["split"], "status": r["status"], "equivalent": r["result_equivalent"],
            "runtime_ms": r["runtime_ms_median"], "fingerprint": r["plan_fingerprint"],
            **{f: r["features"][f] for f in feature_names},
        })
    df = pd.DataFrame(flat)
    return df, feature_names


def q_error(pred: np.ndarray, true: np.ndarray) -> np.ndarray:
    p = np.maximum(pred, Q_FLOOR_MS)
    t = np.maximum(true, Q_FLOOR_MS)
    return np.maximum(p / t, t / p)


def metrics(pred_ms: np.ndarray, true_ms: np.ndarray) -> dict:
    q = q_error(pred_ms, true_ms)
    return {
        "n": int(len(true_ms)),
        "mae_ms": float(np.mean(np.abs(true_ms - pred_ms))),
        "rmse_ms": float(np.sqrt(np.mean((true_ms - pred_ms) ** 2))),
        "q_error_median": float(np.median(q)),
        "q_error_p90": float(np.percentile(q, 90)),
    }


def selection_regret(df: pd.DataFrame, pred_ms: np.ndarray) -> dict:
    """Regret of 'pick the candidate with the lowest prediction' per (template, profile) case."""
    d = df.assign(pred=pred_ms)
    regrets, hits = [], []
    for _, g in d.groupby(["template", "profile"]):
        chosen = g.sort_values(["pred", "candidate"]).iloc[0]
        best = g["runtime_ms"].min()
        regrets.append(chosen["runtime_ms"] / best)
        hits.append(bool(chosen["runtime_ms"] <= best * 1.05))
    return {"cases": len(regrets), "median_regret": float(np.median(regrets)), "oracle_hit_rate_5pct": float(np.mean(hits))}


def fit(X: np.ndarray, y_ms: np.ndarray, cfg: dict) -> RandomForestRegressor:
    y = np.log1p(y_ms) if cfg["log_target"] else y_ms
    m = RandomForestRegressor(
        n_estimators=cfg["n_estimators"], max_depth=cfg["max_depth"], min_samples_leaf=cfg["min_samples_leaf"],
        max_features=cfg["max_features"], random_state=SEED, n_jobs=1,
    )
    m.fit(X, y)
    return m


def predict_ms(m: RandomForestRegressor, X: np.ndarray, cfg: dict) -> np.ndarray:
    p = m.predict(X)
    return np.expm1(p) if cfg["log_target"] else p


def export_forest(m: RandomForestRegressor, feature_names: list[str], cfg: dict, version: str, schema: str, trained_at: str) -> dict:
    trees = []
    for est in m.estimators_:
        t = est.tree_
        trees.append({
            "feature": t.feature.tolist(),
            "threshold": [float(x) for x in t.threshold],
            "left": t.children_left.tolist(),
            "right": t.children_right.tolist(),
            "value": [float(x) for x in t.value[:, 0, 0]],
        })
    return {
        "model_type": "random_forest_regressor",
        "model_version": version,
        "schema_version": schema,
        "feature_names": feature_names,
        "target_transform": "log1p" if cfg["log_target"] else "none",
        "trained_at": trained_at,
        "n_estimators": len(trees),
        "trees": trees,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", default=str(ROOT / "artifacts/benchmark/records.jsonl"))
    ap.add_argument("--meta", default=str(ROOT / "artifacts/benchmark/meta.json"))
    ap.add_argument("--out", default=str(ROOT / "artifacts/model"))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    t_start = time.time()

    meta = json.loads(Path(args.meta).read_text(encoding="utf8"))
    all_df, feats = load_records(Path(args.records))
    usable = all_df[(all_df.status == "ok") & (all_df.equivalent == True) & all_df.runtime_ms.notna()].reset_index(drop=True)  # noqa: E712
    failed = int(len(all_df) - len(usable))
    print(f"records: {len(all_df)} total, {len(usable)} usable, {failed} excluded (failed / inequivalent)")

    parts = {s: usable[usable.split == s] for s in ("train", "validation", "test")}
    for s, d in parts.items():
        print(f"  {s:<10} templates={sorted(d.template.unique())} records={len(d)}")
    leak = set(parts["train"].template) & (set(parts["validation"].template) | set(parts["test"].template))
    leak |= set(parts["validation"].template) & set(parts["test"].template)
    assert not leak, f"template leakage between splits: {leak}"

    Xtr, ytr = parts["train"][feats].to_numpy(float), parts["train"].runtime_ms.to_numpy(float)
    Xva, yva = parts["validation"][feats].to_numpy(float), parts["validation"].runtime_ms.to_numpy(float)

    # ---- baseline: median training runtime --------------------------------------------------
    base_value = float(np.median(ytr))

    # ---- model selection on validation only -----------------------------------------------
    grid = [
        {"n_estimators": n, "max_depth": d, "min_samples_leaf": leaf, "max_features": mf, "log_target": lg}
        for n, d, leaf, mf, lg in itertools.product([60, 120], [8, 14, None], [1, 3], [1.0, 0.6], [True, False])
    ]
    scored = []
    for cfg in grid:
        m = fit(Xtr, ytr, cfg)
        p = predict_ms(m, Xva, cfg)
        scored.append((metrics(p, yva)["mae_ms"], cfg))
    scored.sort(key=lambda s: (s[0], json.dumps(s[1], sort_keys=True)))
    best_val_mae, best_cfg = scored[0]
    print(f"selected config (validation MAE {best_val_mae:.3f} ms): {best_cfg}")

    # ---- validation scores of the chosen config + baseline -----------------------------------
    m_tr = fit(Xtr, ytr, best_cfg)
    val_scores = {
        "model": metrics(predict_ms(m_tr, Xva, best_cfg), yva),
        "baseline_median": metrics(np.full_like(yva, base_value), yva),
    }

    # ---- final model: refit on train+validation, report ONCE on test ------------------------
    trval = pd.concat([parts["train"], parts["validation"]])
    Xtv, ytv = trval[feats].to_numpy(float), trval.runtime_ms.to_numpy(float)
    final = fit(Xtv, ytv, best_cfg)
    base_final = float(np.median(ytv))
    te = parts["test"]
    Xte, yte = te[feats].to_numpy(float), te.runtime_ms.to_numpy(float)
    pte = predict_ms(final, Xte, best_cfg)
    test_scores = {
        "model": metrics(pte, yte),
        "baseline_median": metrics(np.full_like(yte, base_final), yte),
        "selection_model": selection_regret(te, pte),
    }

    # ---- leave-one-template-out CV (RQ5) -----------------------------------------------------
    loto = []
    for t in sorted(usable.template.unique()):
        tr, ho = usable[usable.template != t], usable[usable.template == t]
        m = fit(tr[feats].to_numpy(float), tr.runtime_ms.to_numpy(float), best_cfg)
        p = predict_ms(m, ho[feats].to_numpy(float), best_cfg)
        b = np.full(len(ho), float(np.median(tr.runtime_ms)))
        loto.append({
            "template": t, "model": metrics(p, ho.runtime_ms.to_numpy(float)),
            "baseline_median": metrics(b, ho.runtime_ms.to_numpy(float)),
            "selection_model": selection_regret(ho, p),
        })
    loto_summary = {
        "model_mae_ms_mean": float(np.mean([r["model"]["mae_ms"] for r in loto])),
        "baseline_mae_ms_mean": float(np.mean([r["baseline_median"]["mae_ms"] for r in loto])),
        "model_q_median_of_medians": float(np.median([r["model"]["q_error_median"] for r in loto])),
        "baseline_q_median_of_medians": float(np.median([r["baseline_median"]["q_error_median"] for r in loto])),
        "median_regret_median_over_templates": float(np.median([r["selection_model"]["median_regret"] for r in loto])),
    }

    # ---- feature importances (interpretability) ---------------------------------------------
    importances = sorted(zip(feats, final.feature_importances_.tolist()), key=lambda kv: -kv[1])

    # ---- export ------------------------------------------------------------------------------
    version = "aurora-rf-v1"
    model_json = export_forest(final, feats, best_cfg, version, meta["schema_version"], meta["generated_at"])
    (out / "aurora_rf_v1.json").write_text(json.dumps(model_json, separators=(",", ":")), encoding="utf8")

    rng = np.random.RandomState(SEED)
    pick = rng.choice(len(usable), size=min(64, len(usable)), replace=False)
    Xpar = usable.iloc[pick][feats].to_numpy(float)
    (out / "parity.json").write_text(json.dumps({
        "inputs": Xpar.tolist(),
        "expected_ms": predict_ms(final, Xpar, best_cfg).tolist(),
    }), encoding="utf8")

    report = {
        "model_version": version,
        "schema_version": meta["schema_version"],
        "trained_from": {"records_total": int(len(all_df)), "records_used": int(len(usable)), "records_excluded": failed,
                         "benchmark_generated_at": meta["generated_at"], "environment_id": meta["environment_id"]},
        "split": {s: {"templates": sorted(d.template.unique().tolist()), "records": int(len(d))} for s, d in parts.items()},
        "selected_config": best_cfg,
        "validation_mae_ms_of_selected": best_val_mae,
        "validation_scores": val_scores,
        "test_scores": test_scores,
        "leave_one_template_out": {"summary": loto_summary, "per_template": loto},
        "feature_importances": importances,
        "training_wall_clock_seconds": time.time() - t_start,
        "baseline_median_runtime_ms_train": base_value,
    }
    (out / "train_report.json").write_text(json.dumps(report, indent=2), encoding="utf8")

    print("\n== held-out TEST (templates never seen in training/validation) ==")
    for name in ("model", "baseline_median"):
        s = test_scores[name]
        print(f"  {name:<16} MAE={s['mae_ms']:.3f} ms  RMSE={s['rmse_ms']:.3f} ms  Q-err median={s['q_error_median']:.3f} p90={s['q_error_p90']:.3f}")
    print(f"  selection (model)  {test_scores['selection_model']}")
    print(f"\nwrote {out / 'aurora_rf_v1.json'} ({(out / 'aurora_rf_v1.json').stat().st_size / 1024:.0f} KiB)")


if __name__ == "__main__":
    main()
