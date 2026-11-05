"""Sidecar backend: reads one signed JSON line from stdin, writes one JSON line (result or {"error": ...}).

Request: {"action": "<name>", "payload": {...}}. Actions:
    - preview_relationship  -> LinearGAM cumulative-feature preview
    - predict_relationship  -> LinearGAM full-feature fit on the TRAIN rows, predictions for extra (test) rows only

Only numpy + pygam + stdlib. X and y arrive pre-cleaned: Rust projects columns and drops NaN.
"""

import sys
import math
import json
import hmac
import hashlib
import time
import traceback

import numpy as np
import pygam


# Each stdin line is `<unix seconds> <hex HMAC-SHA256> <request JSON>`, signed by Rust
# (`lib.rs::signed_sidecar_line`) over `<unix seconds>\n<request JSON>`.
# `_KEY` must match `SIDECAR_KEY` in lib.rs (a Rust test checks it).
_KEY = bytes.fromhex("284e88bf1b87ea1628f1cd3c0d6da3fa10d9b04e883ea389911ab87704bab7b7")
# Max age of a line. Generous: the first launch on a slow machine (unpacking, antivirus) is slow;
# older lines are refused so a captured line cannot be replayed.
_MAX_AGE_S = 300


class _Refused(Exception):
    pass


def _signature(ts_text, body):
    return hmac.new(_KEY, ts_text + b"\n" + body, hashlib.sha256).hexdigest().encode()


def _verified_body(line):
    """The request JSON (bytes) of a correctly signed, fresh line, else _Refused."""
    parts = line.rstrip(b"\r\n").split(b" ", 2)
    if len(parts) != 3:
        raise _Refused()
    ts_text, sig, body = parts
    try:
        ts = int(ts_text)
    except ValueError:
        raise _Refused()
    if abs(time.time() - ts) > _MAX_AGE_S:
        raise _Refused()
    if not hmac.compare_digest(_signature(ts_text, body), sig):
        raise _Refused()
    return body


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


# Mirror of src-tauri/src/metrics.rs::round_metric (keep in sync): 3 decimals when that keeps >= 4
# significant digits (|x| >= 1), else 4 significant digits. 0 stays 0; NaN/inf pass through.
_METRIC_MIN_DECIMALS = 3


def _metric_decimals(x):
    """max(3, 3 - floor(log10|x|)); 3 for 0 / non-finite."""
    x = float(x)
    if x == 0.0 or not math.isfinite(x):
        return _METRIC_MIN_DECIMALS
    return max(_METRIC_MIN_DECIMALS, _METRIC_MIN_DECIMALS - int(math.floor(math.log10(abs(x)))))


def _round_metric(x, scale=None):
    """Scalar round_metric. `scale` (e.g. the matching SD) makes the rounding fine enough to resolve mean±k·sd."""
    x = float(x)
    if not math.isfinite(x) or abs(x) >= 1e15:
        return x
    d = _metric_decimals(x)
    if scale is not None:
        d = max(d, _metric_decimals(scale))
    try:
        r = round(x, d)
    except OverflowError:
        return x
    return r if math.isfinite(r) else x


def _extra_matrix(payload, n_features):
    """Optional `X_extra` as an n_extra x n_features float matrix, or None if absent/empty. Predict-only: never refitted on."""
    raw = payload.get("X_extra")
    if raw is None or len(raw) == 0:
        return None
    xe = np.asarray(raw, dtype=float)
    if xe.ndim == 1:
        xe = xe.reshape(-1, 1)
    if xe.shape[1] != n_features:
        raise ValueError(
            f"X_extra has {xe.shape[1]} columns but the model has {n_features} predictors"
        )
    return xe


def preview_relationship(payload):
    """Cumulative LinearGAM preview.

    Payload (Rust pre-cleans, no NaN): predictors (names), target (name), X (n_rows x n_predictors),
    y, smoothing (optional, default 10000), X_extra (optional: rows predicted by the final train-only
    model, so the Train/Test validation needs no second fit; never fitted on).
    Returns: request, r2_per_step, rmse2_per_step, predicted, residual (+ predicted_extra with X_extra).
    """
    features = payload["predictors"]
    lamb = payload.get("smoothing", 10000)

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
    # Best-effort: pre-warm must not fail the Train. A bad X_extra is dropped; if predicting fails,
    # predicted_extra is omitted and Rust predicts the test rows via `predict_relationship`.
    try:
        X_extra = _extra_matrix(payload, X.shape[1])
    except Exception as e:  # noqa: BLE001 - deliberately broad, see above
        print(f"preview_relationship: X_extra ignored: {e}", file=sys.stderr)
        X_extra = None

    n_rows = X.shape[0]
    r2_per_step = []
    rmse2_per_step = []

    last_predicted = None
    last_model = None
    for i in range(len(features)):
        Xi = X[:, : i + 1]
        model = pygam.LinearGAM(lam=lamb).fit(Xi, y)
        pred = np.asarray(model.predict(Xi), dtype=float)

        r2 = round(_r2(y, pred), 2)
        rmse2 = _round_metric(2.0 * _rmse(y, pred))
        r2_per_step.append(r2)
        rmse2_per_step.append(rmse2)

        last_predicted = pred
        last_model = model

    # Full-model predicted/residual = the last cumulative step (all features).
    predicted_full = last_predicted if last_predicted is not None else np.zeros(n_rows)
    residual_full = y - predicted_full

    out = {
        "request": "PreviewModel/relationship",
        "r2_per_step": r2_per_step,
        "rmse2_per_step": rmse2_per_step,
        "predicted": [_finite_or_none(v) for v in predicted_full.tolist()],
        "residual": [_finite_or_none(v) for v in residual_full.tolist()],
    }
    # Pre-warm: the same full-feature model as `predict_relationship` predicts the test rows, raw like `predicted`.
    if X_extra is not None and last_model is not None:
        try:
            extra = np.asarray(last_model.predict(X_extra), dtype=float)
            out["predicted_extra"] = [_finite_or_none(v) for v in extra.tolist()]
        except Exception as e:  # noqa: BLE001 - pre-warm is best-effort (see above)
            print(f"preview_relationship: predicting X_extra failed: {e}", file=sys.stderr)
    return out


def predict_relationship(payload):
    """Full-feature LinearGAM fitted on the TRAIN rows (same fit as `preview_relationship`'s last step),
    used only to predict `X_extra` (the test periods). No refit, nothing saved.

    Payload: X, y (train rows), X_extra (rows to predict), smoothing (optional, default 10000).
    Returns: request, predicted_extra (raw, None where non-finite).
    """
    lamb = payload.get("smoothing", 10000)
    X = np.asarray(payload["X"], dtype=float)
    y = np.asarray(payload["y"], dtype=float)
    if X.ndim == 1:
        X = X.reshape(-1, 1)
    if X.shape[0] != y.shape[0]:
        raise ValueError(f"X has {X.shape[0]} rows but y has {y.shape[0]}")
    X_extra = _extra_matrix(payload, X.shape[1])
    if X_extra is None:
        return {"request": "predict_relationship", "predicted_extra": []}
    model = pygam.LinearGAM(lam=lamb).fit(X, y)
    extra = np.asarray(model.predict(X_extra), dtype=float)
    return {
        "request": "predict_relationship",
        "predicted_extra": [_finite_or_none(v) for v in extra.tolist()],
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
    "predict_relationship": predict_relationship,
}


def main():
    try:
        line = sys.stdin.buffer.readline()
        if not line:
            return

        msg = json.loads(_verified_body(line))
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

    except _Refused:
        # No trace: it would reveal where the check lives.
        print(json.dumps({"error": "Request refused."}))
        sys.stdout.flush()

    except Exception as e:
        print(json.dumps({
            "error": str(e),
            "trace": traceback.format_exc(),
        }))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
