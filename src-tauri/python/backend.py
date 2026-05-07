"""Sidecar backend for Soothsayer-Wizard.

Reads a single JSON line from stdin in the form:
    {"action": "<name>", "payload": {...}}
Writes a single JSON line to stdout with the result (or {"error": ...}).

Currently supported actions:
    - preview_relationship  → LinearGAM cumulative-feature preview
    - train_relationship    → LinearGAM full-feature fit + pickle save

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
import json
import pickle
import traceback

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


DISPATCH = {
    "preview_relationship": preview_relationship,
    "train_relationship": train_relationship,
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
