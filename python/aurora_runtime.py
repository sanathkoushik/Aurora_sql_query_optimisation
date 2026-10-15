"""Aurora runtime: deterministic data, plan execution, timing and result verification.

This single file is loaded unchanged into Pyodide (browser and Node) and can also be imported by
native CPython for unit tests. All functions exchange JSON-serialisable values with the TypeScript
host. Nothing here fabricates measurements: timings come from ``time.perf_counter_ns`` around the
generated pandas plan.
"""
from __future__ import annotations

import gc
import json
import math
import sqlite3
import sys
import time

import numpy as np
import pandas as pd

RUNTIME_VERSION = "aurora-runtime-1.0"

# ---------------------------------------------------------------------------------------------
# Deterministic benchmark database
# ---------------------------------------------------------------------------------------------

SIZES = {
    # name: (customers, orders, products)
    "small": (1_000, 5_000, 200),
    "medium": (5_000, 50_000, 500),
    "large": (20_000, 200_000, 2_000),
}

REGIONS = ["North", "South", "East", "West", "Central"]
SEGMENTS = ["Consumer", "Corporate", "SmallBusiness", "Enterprise"]
CITIES = [
    "Chennai", "Mumbai", "Delhi", "Bengaluru", "Hyderabad", "Kolkata", "Pune", "Ahmedabad", "Jaipur",
    "Surat", "Lucknow", "Kanpur", "Nagpur", "Indore", "Bhopal", "Patna", "Vadodara", "Coimbatore",
    "Kochi", "Madurai", "Vellore", "Mysuru", "Visakhapatnam", "Nashik", "Ranchi", "Guwahati",
    "Chandigarh", "Dehradun", "Bhubaneswar", "Thiruvananthapuram",
]
STATUSES = ["delivered", "shipped", "processing", "cancelled", "returned"]
STATUS_P = [0.60, 0.15, 0.12, 0.08, 0.05]
CHANNELS = ["web", "mobile", "store", "partner"]
CATEGORIES = ["Books", "Electronics", "Fashion", "Home", "Toys", "Sports", "Grocery", "Beauty"]
BRANDS = [f"Brand{i:02d}" for i in range(1, 21)]

# Data profiles: (size, share of customers located in region 'South').
PROFILES = {
    f"{size}_{sel}": (size, share)
    for size in SIZES
    for sel, share in (("selective", 0.05), ("broad", 0.40))
}

ORPHAN_RATE = 0.10  # fraction of orders whose customer_id has no matching customer (join match rate 90%)


def _dates(rs: np.random.RandomState, start: str, span_days: int, n: int):
    days = rs.randint(0, span_days, size=n).astype("timedelta64[D]")
    return (np.datetime64(start) + days).astype(str).astype(object)


def generate_database(size: str, south_share: float, seed: int = 20260101) -> dict[str, pd.DataFrame]:
    n_c, n_o, n_p = SIZES[size]
    rs = np.random.RandomState(seed)

    others = (1.0 - south_share) / 4.0
    region_p = [others, south_share, others, others, others]
    cid = np.arange(1, n_c + 1, dtype=np.int64)
    customers = pd.DataFrame({
        "customer_id": cid,
        "name": ["Customer %d" % i for i in cid],
        "email": ["user%d@example.com" % i for i in cid],
        "region": np.array(REGIONS, dtype=object)[rs.choice(len(REGIONS), size=n_c, p=region_p)],
        "segment": np.array(SEGMENTS, dtype=object)[rs.choice(len(SEGMENTS), size=n_c, p=[0.5, 0.2, 0.2, 0.1])],
        "city": np.array(CITIES, dtype=object)[rs.randint(0, len(CITIES), size=n_c)],
        "age": rs.randint(18, 81, size=n_c).astype(np.int64),
        "signup_date": _dates(rs, "2019-01-01", 2000, n_c),
        "loyalty_score": np.round(rs.uniform(0, 100, size=n_c), 2),
    })

    oid = np.arange(1, n_o + 1, dtype=np.int64)
    cust = rs.randint(1, n_c + 1, size=n_o).astype(np.int64)
    orphan = rs.random_sample(n_o) < ORPHAN_RATE
    cust = np.where(orphan, n_c + rs.randint(1, n_c + 1, size=n_o), cust).astype(np.int64)
    orders = pd.DataFrame({
        "order_id": oid,
        "customer_id": cust,
        "product_id": rs.randint(1, n_p + 1, size=n_o).astype(np.int64),
        "amount": np.round(rs.lognormal(4.0, 0.8, size=n_o), 2),
        "quantity": rs.randint(1, 11, size=n_o).astype(np.int64),
        "status": np.array(STATUSES, dtype=object)[rs.choice(len(STATUSES), size=n_o, p=STATUS_P)],
        "order_date": _dates(rs, "2023-01-01", 730, n_o),
        "channel": np.array(CHANNELS, dtype=object)[rs.randint(0, len(CHANNELS), size=n_o)],
        "discount": np.round(rs.uniform(0, 0.3, size=n_o), 2),
        "shipping_cost": np.round(rs.uniform(0, 25, size=n_o), 2),
    })

    pid = np.arange(1, n_p + 1, dtype=np.int64)
    products = pd.DataFrame({
        "product_id": pid,
        "product_name": ["Product %d" % i for i in pid],
        "category": np.array(CATEGORIES, dtype=object)[rs.randint(0, len(CATEGORIES), size=n_p)],
        "brand": np.array(BRANDS, dtype=object)[rs.randint(0, len(BRANDS), size=n_p)],
        "price": np.round(rs.lognormal(3.5, 0.7, size=n_p), 2),
        "stock": rs.randint(0, 1000, size=n_p).astype(np.int64),
        "rating": np.round(rs.uniform(1, 5, size=n_p), 1),
    })
    return {"customers": customers, "orders": orders, "products": products}


def profile_tables(tables: dict[str, pd.DataFrame]) -> dict:
    """Data profile used by the cost model and the predictor's selectivity feature.

    For every column: row count, distinct count, min/max (numeric and ISO-date columns) and, for
    low-cardinality text columns, the exact value-frequency map. These are computed directly from
    the data with one documented method (exact counts), never guessed.
    """
    prof: dict = {}
    for name, df in tables.items():
        cols: dict = {}
        n = len(df)
        for c in df.columns:
            s = df[c]
            info: dict = {"distinct": int(s.nunique())}
            if pd.api.types.is_numeric_dtype(s):
                info["min"] = float(s.min())
                info["max"] = float(s.max())
            else:
                info["min"] = str(s.min())
                info["max"] = str(s.max())
                if info["distinct"] <= 64:
                    vc = s.value_counts()
                    info["freq"] = {str(k): int(v) / n for k, v in vc.items()}
            cols[c] = info
        prof[name] = {"rows": int(n), "columns": cols}
    return prof


# ---------------------------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------------------------

_state: dict = {"tables": None, "sqlite": None, "profile_id": None}


def environment_info() -> str:
    return json.dumps({
        "runtime": RUNTIME_VERSION,
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "pandas": pd.__version__,
        "numpy": np.__version__,
        "sqlite": sqlite3.sqlite_version,
    })


def load_profile(profile_id: str, seed: int = 20260101) -> str:
    size, share = PROFILES[profile_id]
    tables = generate_database(size, share, seed)
    con = sqlite3.connect(":memory:")
    for name, df in tables.items():
        df.to_sql(name, con, index=False)
    old = _state.get("sqlite")
    if old is not None:
        old.close()
    _state.update(tables=tables, sqlite=con, profile_id=profile_id)
    return json.dumps(profile_tables(tables))


# ---------------------------------------------------------------------------------------------
# Plan execution
# ---------------------------------------------------------------------------------------------

def _compile(code: str):
    ns: dict = {"pd": pd, "np": np}
    exec(compile(code, "<aurora-plan>", "exec"), ns)  # noqa: S102 - code is produced by Aurora's own code generator
    return ns["run"]


def execute(code: str) -> pd.DataFrame:
    return _compile(code)(_state["tables"])


def run_for_display(code: str, limit: int = 20) -> str:
    """Execute a plan once and return a JSON preview (used by the live demo)."""
    fn = _compile(code)
    t0 = time.perf_counter_ns()
    out = fn(_state["tables"])
    ms = (time.perf_counter_ns() - t0) / 1e6
    return json.dumps({
        "columns": [str(c) for c in out.columns],
        "rows": json.loads(out.head(limit).to_json(orient="values", double_precision=10)),
        "row_count": int(len(out)),
        "elapsed_ms": ms,
    })


def _time_call(fn) -> float:
    tables = _state["tables"]
    gc.collect()
    gc.disable()
    try:
        t0 = time.perf_counter_ns()
        out = fn(tables)
        t1 = time.perf_counter_ns()
    finally:
        gc.enable()
    del out
    return (t1 - t0) / 1e6


def time_candidates(codes_json: str, warmup: int, reps: int) -> str:
    """Time several candidate plans on the loaded database.

    Warm-up runs are excluded from the sample. Timed runs are interleaved round-robin with a
    rotating start so ordering/cache bias is spread evenly over candidates.
    Returns ``{candidate_id: {"times_ms": [...], "error": null | str}}``.
    """
    codes: dict[str, str] = json.loads(codes_json)
    fns: dict = {}
    result: dict = {}
    for cid, code in codes.items():
        try:
            fns[cid] = _compile(code)
            result[cid] = {"times_ms": [], "error": None}
        except Exception as e:  # noqa: BLE001
            result[cid] = {"times_ms": [], "error": f"compile: {e!r}"}
    ids = list(fns)
    for cid in ids:
        try:
            for _ in range(warmup):
                _time_call(fns[cid])
        except Exception as e:  # noqa: BLE001
            result[cid]["error"] = f"execute: {e!r}"
    ids = [c for c in ids if result[c]["error"] is None]
    for r in range(reps):
        k = r % max(len(ids), 1)
        for cid in ids[k:] + ids[:k]:
            try:
                result[cid]["times_ms"].append(_time_call(fns[cid]))
            except Exception as e:  # noqa: BLE001
                result[cid]["error"] = f"execute: {e!r}"
    return json.dumps(result)


# ---------------------------------------------------------------------------------------------
# Result verification against an independent engine (SQLite)
# ---------------------------------------------------------------------------------------------

def reference_result(sql: str) -> pd.DataFrame:
    return pd.read_sql_query(sql, _state["sqlite"])


def _canonical(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [f"c{i}" for i in range(df.shape[1])]
    df = df.reset_index(drop=True)
    key = df.copy()
    for c in key.columns:
        if pd.api.types.is_float_dtype(key[c]):
            key[c] = key[c].round(4)
    order = key.sort_values(by=list(key.columns), kind="mergesort").index
    return df.loc[order].reset_index(drop=True)


def _as_float(s: pd.Series):
    """Float view of a column, mapping SQL NULL (None/NaN) to NaN; None if the column is not numeric."""
    if pd.api.types.is_numeric_dtype(s):
        return s.to_numpy(dtype="float64")
    if s.map(lambda x: x is None or isinstance(x, (int, float, np.integer, np.floating))).all():
        return s.astype("float64").to_numpy()
    return None


def _col_equal(a: pd.Series, b: pd.Series, rtol: float, atol: float) -> bool:
    av, bv = _as_float(a), _as_float(b)
    if av is not None and bv is not None:
        both_nan = np.isnan(av) & np.isnan(bv)
        close = np.isclose(av, bv, rtol=rtol, atol=atol)
        return bool(np.all(close | both_nan))
    if av is not None or bv is not None:
        return False  # one side numeric, the other textual
    return bool((a.astype(str).to_numpy() == b.astype(str).to_numpy()).all())


def frames_equivalent(cand: pd.DataFrame, ref: pd.DataFrame, order_positions: list[int] | None = None,
                      rtol: float = 1e-6, atol: float = 1e-6) -> tuple[bool, str]:
    """Multiset equality of rows (order ignored) with a documented float tolerance.

    * Columns are matched by position (names may differ between engines).
    * Float columns compare with ``rtol``/``atol`` = 1e-6 (aggregates are summed in different orders).
    * When ORDER BY keys are present in the output (``order_positions``), the key columns must also
      appear in the same sequence as the reference, so an incorrect sort is detected even though tied
      rows may legitimately be ordered differently.
    """
    if cand.shape[1] != ref.shape[1]:
        return False, f"column count differs ({cand.shape[1]} vs {ref.shape[1]})"
    if len(cand) != len(ref):
        return False, f"row count differs ({len(cand)} vs {len(ref)})"
    if len(cand) == 0:
        return True, "both results empty"
    a, b = _canonical(cand), _canonical(ref)
    for c in a.columns:
        if not _col_equal(a[c], b[c], rtol, atol):
            return False, f"values differ in output column {c[1:]}"
    if order_positions:
        for p in order_positions:
            ca = cand.iloc[:, p].reset_index(drop=True)
            cb = ref.iloc[:, p].reset_index(drop=True)
            if not _col_equal(ca, cb, rtol, atol):
                return False, f"ORDER BY key column {p} is not in the required order"
    return True, "rows match reference"


def verify_candidates(codes_json: str, sql: str, order_positions_json: str = "[]") -> str:
    """Execute every candidate once and compare with SQLite running the *original* SQL text."""
    codes: dict[str, str] = json.loads(codes_json)
    order_positions = json.loads(order_positions_json)
    try:
        ref = reference_result(sql)
    except Exception as e:  # noqa: BLE001
        return json.dumps({"reference_error": repr(e), "results": {}})
    out: dict = {}
    for cid, code in codes.items():
        try:
            df = execute(code)
            ok, why = frames_equivalent(df, ref, order_positions)
            out[cid] = {"equivalent": ok, "reason": why, "rows": int(len(df))}
        except Exception as e:  # noqa: BLE001
            out[cid] = {"equivalent": False, "reason": f"execution failed: {e!r}", "rows": 0}
    return json.dumps({"reference_error": None, "reference_rows": int(len(ref)), "results": out})
