"""Sidecar backend for Soothsayer-Wizard.

Reads a single JSON line from stdin in the form:
    {"action": "<name>", "payload": {...}}
Writes a single JSON line to stdout with the result (or {"error": ...}).

Currently supported actions:
    - preview_relationship  → LinearGAM cumulative-feature preview
    - train_relationship    → LinearGAM full-feature fit + pickle save
    - train_clustering      → Per-cluster 2D Gaussian (GMM n_components=1)
                              fit + optional CLUS_INFO_*.json save.

Phase 1 (Hybrid Rust/Python architecture) goals satisfied by this file:
    - No `pandas`, no `sklearn`, no `wizard` import.
    - Only `numpy + pygam` plus stdlib.
    - Accepts pre-cleaned `X` matrix and `y` vector — Rust handles
      column projection and NaN-drop before invoking the sidecar.

Phase 5: the legacy compat shim has been removed. The response now contains
only the new shape: `request, r2_per_step, rmse2_per_step, predicted,
residual`. The TypeScript types and PredictiveModelBuild UI consume this
shape directly.
"""

import sys
import os
import math
import json
import pickle
import traceback
from datetime import datetime, timezone

import numpy as np
import pygam


# ── numpy-only metric helpers ───────────────────────────────────────────
def _r2(y_true, y_pred):
    """Coefficient of determination, sklearn-compatible (uniform sample weight)."""
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    ss_res = float(np.sum((y_true - y_pred) ** 2))
    ss_tot = float(np.sum((y_true - np.mean(y_true)) ** 2))
    if ss_tot == 0.0:
        return 0.0
    return 1.0 - ss_res / ss_tot


def _rmse(y_true, y_pred):
    """Root mean squared error."""
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


# ── action handlers ─────────────────────────────────────────────────────
def preview_relationship(payload):
    """Cumulative LinearGAM preview.

    Expected payload keys (Phase 1 contract — Rust pre-cleans the data):
        predictors        : list[str]   feature names (informational only)
        target            : str         target name (informational only)
        X                 : list[list]  n_rows × n_predictors, no NaN
        y                 : list[float] n_rows, no NaN
        linearGAM_lambda  : float       optional, default 10000

    Returns:
        request, r2_per_step, rmse2_per_step, predicted, residual
    """
    features = payload["predictors"]
    lamb = payload.get("linearGAM_lambda", 10000)

    X = np.asarray(payload["X"], dtype=float)
    y = np.asarray(payload["y"], dtype=float)
    if X.ndim == 1:
        X = X.reshape(-1, 1)
    if X.shape[0] != y.shape[0]:
        raise ValueError(
            f"X has {X.shape[0]} rows but y has {y.shape[0]}"
        )
    if X.shape[1] != len(features):
        raise ValueError(
            f"X has {X.shape[1]} columns but {len(features)} predictors named"
        )

    n_rows = X.shape[0]
    r2_per_step = []
    rmse2_per_step = []

    last_predicted = None
    for i in range(len(features)):
        Xi = X[:, : i + 1]
        model = pygam.LinearGAM(lam=lamb).fit(Xi, y)
        pred = np.asarray(model.predict(Xi), dtype=float)

        r2 = round(_r2(y, pred), 2)
        rmse2 = round(2.0 * _rmse(y, pred), 4)
        r2_per_step.append(r2)
        rmse2_per_step.append(rmse2)

        last_predicted = pred

    # Full-model predicted/residual = the LAST cumulative step (uses all features).
    predicted_full = last_predicted if last_predicted is not None else np.zeros(n_rows)
    residual_full = y - predicted_full

    return {
        "request": "PreviewModel/relationship",
        "r2_per_step": r2_per_step,
        "rmse2_per_step": rmse2_per_step,
        "predicted": [_finite_or_none(v) for v in predicted_full.tolist()],
        "residual": [_finite_or_none(v) for v in residual_full.tolist()],
    }


def train_relationship(payload):
    """Full-feature LinearGAM fit + pickle save.

    Expected payload keys:
        predictors        : list[str]
        target            : str
        X                 : list[list]  n_rows × n_predictors, no NaN
        y                 : list[float] n_rows, no NaN
        linearGAM_lambda  : float       optional, default 10000
        saved_path        : str         workspace root (mkdir -p saved_path/output/{target})

    Returns:
        request, r2, rmse2, predicted, residual, model_path
    """
    features = payload["predictors"]
    target = payload["target"]
    lamb = payload.get("linearGAM_lambda", 10000)
    saved_path = payload["saved_path"]

    X = np.asarray(payload["X"], dtype=float)
    y = np.asarray(payload["y"], dtype=float)
    if X.ndim == 1:
        X = X.reshape(-1, 1)

    model = pygam.LinearGAM(lam=lamb).fit(X, y)
    predicted = np.round(np.asarray(model.predict(X), dtype=float), 3)
    residual = np.round(y - predicted, 3)
    r2 = round(_r2(y, predicted), 2)
    rmse2 = round(2.0 * _rmse(y, predicted), 4)

    out_dir = os.path.join(saved_path, "output", target)
    os.makedirs(out_dir, exist_ok=True)
    # Use a stable filename — feature list joined with '+' to avoid the
    # python-list repr that wizard.py used.
    feat_token = "+".join(features)
    model_path = os.path.join(out_dir, f"REL_MODEL_{feat_token}_{target}.pkl")
    with open(model_path, "wb") as f:
        pickle.dump(model, f)

    return {
        "request": "SaveThisSensor/relationship",
        "r2": r2,
        "rmse2": rmse2,
        "predicted": [_finite_or_none(v) for v in predicted.tolist()],
        "residual": [_finite_or_none(v) for v in residual.tolist()],
        "model_path": model_path,
    }


def _finite_or_none(v):
    """JSON-safe scalar: NaN/inf → None."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(x):
        return None
    return x


# ── clustering helpers ─────────────────────────────────────────────────
def _fit_gaussian_2d(xy):
    """Fit a 2D Gaussian (GMM with n_components=1, full covariance).

    Numerically equivalent to sklearn.mixture.GaussianMixture
    (n_components=1, covariance_type='full').fit(xy):
        mean = sample mean (axis=0)
        cov  = (X - mean).T @ (X - mean) / N    (biased estimator)

    The major-/minor-axis std and rotation angle are recovered via SVD
    of the 2x2 covariance matrix.

    Args:
        xy: (n, 2) array-like — pre-cleaned, no NaN/inf, n ≥ 1.

    Returns:
        dict with keys x_center, y_center, x_sd (major), y_sd (minor),
        angle_deg (rotation of major axis, degrees).
    """
    xy = np.asarray(xy, dtype=float)
    if xy.ndim != 2 or xy.shape[1] != 2:
        raise ValueError(f"_fit_gaussian_2d: expected (n, 2) array, got shape {xy.shape}")
    if xy.shape[0] == 0:
        raise ValueError("_fit_gaussian_2d: empty input")

    mean = xy.mean(axis=0)
    centered = xy - mean
    # Biased covariance (divide by N) — matches sklearn's empirical_covariance
    # used by GaussianMixture for the .covariances_ attribute.
    cov = (centered.T @ centered) / xy.shape[0]

    if cov.shape == (2, 2):
        u, s, _ = np.linalg.svd(cov)
        s0 = max(float(s[0]), 0.0)
        s1 = max(float(s[1]), 0.0)
        angle_deg = float(np.degrees(np.arctan2(u[1, 0], u[0, 0])))
        major_sd = math.sqrt(s0)
        minor_sd = math.sqrt(s1)
    else:
        # Defensive: 1-d degenerate input. Shouldn't happen with the (n, 2) check above.
        angle_deg = 0.0
        major_sd = math.sqrt(max(float(cov.flat[0]), 0.0))
        minor_sd = major_sd

    return {
        "x_center": float(mean[0]),
        "y_center": float(mean[1]),
        "x_sd": major_sd,
        "y_sd": minor_sd,
        "angle_deg": angle_deg,
    }


def _build_cluster_info_entry(cluster_id, details, cluster_ranges):
    """Map a single cluster's details + range to wizard.py's `cluster_info` shape."""
    item = {}
    if cluster_ranges and cluster_id in cluster_ranges:
        a, b = cluster_ranges[cluster_id]
        a_neginf = math.isinf(a) and a < 0
        b_posinf = math.isinf(b) and b > 0
        if a_neginf and not b_posinf:
            item["criteria_sensor_value_lower_than"] = b
        elif not a_neginf and not b_posinf:
            item["criteria_sensor_value_higher_than"] = a
            item["criteria_sensor_value_lower_than"] = b
        elif not a_neginf and b_posinf:
            item["criteria_sensor_value_higher_than"] = a
        else:
            raise ValueError(f"Invalid cluster range for {cluster_id}: [{a}, {b}]")
    item["x_cluster_center"] = details["x_center"]
    item["y_cluster_center"] = details["y_center"]
    item["x_sd"] = details["x_sd"]
    item["y_sd"] = details["y_sd"]
    item["angle_deg"] = details["angle_deg"]
    item["boundary_sd_health_score"] = None
    return item


def _save_clustering_info(
    saved_path,
    first_sensor,
    second_sensor,
    cluster_count,
    criteria_sensor,
    cluster_ranges,
    cluster_details,
    model_name,
    training_set_start_date,
    training_set_end_date,
):
    """Write CLUS_INFO_<first>_<second>.json mirroring wizard.py CLUSTERING_INFO."""
    out_dir = os.path.join(saved_path, "output", second_sensor)
    os.makedirs(out_dir, exist_ok=True)

    if not model_name:
        model_name = f"({first_sensor}) VS ({second_sensor})"

    cluster_info = {
        cid: _build_cluster_info_entry(cid, details, cluster_ranges)
        for cid, details in cluster_details.items()
    }

    info = {
        "model_name": model_name,
        "model_composition": {
            "first_sensor": first_sensor,
            "second_sensor": second_sensor,
            "criteria_sensor": criteria_sensor or "",
            "cluster_count": cluster_count,
        },
        "model_training_set_info": {
            "publish_id": 0,
            "training_set_start_date": training_set_start_date or "",
            "training_set_end_date": training_set_end_date or "",
            "training_set_comments": "",
        },
        "cluster_info": cluster_info,
        "model_update_record": [
            {
                "publish_id": 0,
                "updated_timestamp": datetime.now(timezone.utc).isoformat(),
                "updated_by": "Wizard",
                "activity": "Wizard",
                "comments": "",
            }
        ],
    }

    out_path = os.path.join(
        out_dir, f"CLUS_INFO_{first_sensor}_{second_sensor}.json"
    )
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(info, f, indent=4)
    return out_path


def train_clustering(payload):
    """Train per-cluster 2D Gaussian fits (GMM n_components=1).

    Mirrors `wizard.py::SaveThisSensor._execute_clustering` — but using
    numpy only (no sklearn) and accepting pre-cleaned data from Rust.

    Expected payload (Rust pre-cleans X — no NaN, columns already projected):
        first_sensor      : str
        second_sensor     : str
        cluster_count     : int                1 = single, >1 = multi
        X                 : list[list[float]]
            shape (n, 2) when cluster_count == 1   → cols [first, second]
            shape (n, 3) when cluster_count >  1   → cols [first, second, criteria]
        criteria_sensor   : str  (optional)    informational, multi-cluster only
        cluster_ranges    : dict (optional)    required when cluster_count > 1
            keys "1".."N" → [lower, upper) over the criteria column.
            Use math.inf / -math.inf for open ends.
        saved_path        : str  (optional)    if given, writes
            {saved_path}/output/{second_sensor}/CLUS_INFO_{first}_{second}.json
        model_name        : str  (optional)
        training_set_start_date : str (optional, passed through to JSON)
        training_set_end_date   : str (optional, passed through to JSON)

    Returns:
        request          : "train_clustering"
        cluster_count    : int
        cluster_details  : { "1": {x_center, y_center, x_sd, y_sd, angle_deg, n_rows} }
        info_path        : str | None
    """
    first_sensor = payload["first_sensor"]
    second_sensor = payload["second_sensor"]
    cluster_count = int(payload["cluster_count"])

    if cluster_count < 1:
        raise ValueError(f"cluster_count must be ≥ 1, got {cluster_count}")

    X = np.asarray(payload["X"], dtype=float)
    if X.ndim != 2:
        raise ValueError(f"X must be a 2-D matrix, got shape {X.shape}")
    if X.shape[0] == 0:
        raise ValueError("X has 0 rows — nothing to cluster.")
    if X.shape[1] < 2:
        raise ValueError(
            f"X must have ≥ 2 columns (first, second[, criteria]), got {X.shape[1]}"
        )

    # Assign each row to a cluster id (1..cluster_count). 0 = unassigned.
    assignments = np.zeros(X.shape[0], dtype=int)
    cluster_ranges = None
    criteria_sensor = payload.get("criteria_sensor")

    if cluster_count == 1:
        assignments[:] = 1
    else:
        if X.shape[1] < 3:
            raise ValueError(
                "Multi-cluster requires X with 3 columns (first, second, criteria); "
                f"got {X.shape[1]}."
            )
        cluster_ranges = payload.get("cluster_ranges")
        if not cluster_ranges:
            raise ValueError("Multi-cluster requires `cluster_ranges`.")
        criteria_col = X[:, 2]
        for cid_str, range_pair in cluster_ranges.items():
            try:
                cid = int(cid_str)
            except (TypeError, ValueError):
                raise ValueError(
                    f"cluster_ranges keys must be int strings, got {cid_str!r}"
                )
            if cid < 1 or cid > cluster_count:
                raise ValueError(
                    f"Cluster id {cid} out of range [1, {cluster_count}]"
                )
            if (
                not isinstance(range_pair, (list, tuple))
                or len(range_pair) != 2
            ):
                raise ValueError(
                    f"cluster_ranges[{cid_str!r}] must be [lower, upper], "
                    f"got {range_pair!r}"
                )
            lo, hi = float(range_pair[0]), float(range_pair[1])
            if not lo < hi:
                raise ValueError(
                    f"cluster_ranges[{cid_str!r}] must satisfy lower < upper, "
                    f"got [{lo}, {hi}]"
                )
            mask = (criteria_col >= lo) & (criteria_col < hi)
            # Last write wins on overlap — matches wizard.py's loop.
            assignments[mask] = cid

    # Per-cluster fit
    cluster_details = {}
    for cid in range(1, cluster_count + 1):
        member_mask = assignments == cid
        n_members = int(member_mask.sum())
        if n_members == 0:
            raise ValueError(
                f"Cluster {cid} has 0 members — check cluster_ranges or input data."
            )
        members_xy = X[member_mask, :2]
        ellipse = _fit_gaussian_2d(members_xy)
        cluster_details[str(cid)] = {
            "x_center": round(ellipse["x_center"], 3),
            "y_center": round(ellipse["y_center"], 3),
            "x_sd": round(ellipse["x_sd"], 3),
            "y_sd": round(ellipse["y_sd"], 3),
            "angle_deg": round(ellipse["angle_deg"], 3),
            "n_rows": n_members,
        }

    # Optional persistence
    info_path = None
    saved_path = payload.get("saved_path")
    if saved_path:
        info_path = _save_clustering_info(
            saved_path=saved_path,
            first_sensor=first_sensor,
            second_sensor=second_sensor,
            cluster_count=cluster_count,
            criteria_sensor=criteria_sensor,
            cluster_ranges=cluster_ranges,
            cluster_details=cluster_details,
            model_name=payload.get("model_name"),
            training_set_start_date=payload.get("training_set_start_date"),
            training_set_end_date=payload.get("training_set_end_date"),
        )

    return {
        "request": "train_clustering",
        "cluster_count": cluster_count,
        "cluster_details": cluster_details,
        "info_path": info_path,
    }


DISPATCH = {
    "preview_relationship": preview_relationship,
    "train_relationship": train_relationship,
    "train_clustering": train_clustering,
}


# ── entry point ─────────────────────────────────────────────────────────
def main():
    try:
        line = sys.stdin.readline()
        if not line:
            return

        msg = json.loads(line)
        action = msg.get("action")
        payload = msg.get("payload", {})

        handler = DISPATCH.get(action)
        if handler is None:
            print(json.dumps({"error": f"Unknown action: {action!r}"}))
            sys.stdout.flush()
            return

        result = handler(payload)
        print(json.dumps(result))
        sys.stdout.flush()

    except Exception as e:
        print(json.dumps({
            "error": str(e),
            "trace": traceback.format_exc(),
        }))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
