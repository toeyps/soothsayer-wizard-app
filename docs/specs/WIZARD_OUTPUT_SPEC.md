# Wizard Output Specification — v1.0

**Audience:** Wizard developers. **Status:** agreed 2026-10-20 · amended 2026-10-26: the model key is `<model_name>_<type>` (section 2.1), no longer `<tag>-<R|I|C><n>`.

This document defines **what the Wizard must export**. It does not prescribe how the Wizard's UI or internals work.

## 1. Principles

1. **Export choices, not models.** The export contains only what the user chose: sensors, model settings, health values, metadata and the exact training data. Everything is retrained downstream from these files.
2. **Nothing trained leaves the Wizard.** Do not export fitted models (`.pkl` or any serialized model), fitted parameters or statistics (means, standard deviations, centers, angles, scores, error metrics), or derived columns such as predicted values or residuals.
3. **No internal method names.** No key, value, file name or column name may reveal the modeling method or library. Use only the neutral vocabulary in this spec.
4. **The training CSV is the source of truth.** The user's slicing and filtering in the Wizard is final. Export the exact rows used, so the data never needs re-filtering downstream.
5. **Free text is allowed where context is enough.** Some fields are plain-language descriptions that a downstream implementation tool parses. Fields that drive calculation are structured and exact.

## 2. Export layout

One export = **one machine, one Wizard session**.

```
<export_folder>/
├── machine_info.json         machine-level information (one per export)
└── models/
    ├── <model_key>.json      model settings (one per model)
    └── <model_key>.csv       exact training data for that model
```

- Each model produces exactly one `.json` and one `.csv` with the same `<model_key>` stem.
- One sensor may have multiple models; each is a separate pair of files.
- Encoding: UTF-8. JSON is pretty-printed.

### 2.1 Model key

- Format: `<model_name>_<type>` (amended 2026-10-26, user decision), where `<type>` is `relationship`, `individual` or `clustering` and `<model_name>` is the model's display name with a trailing Wizard kind label (" (Individual)", " (Relation model)", " (Relationship)", " (Clustering)") removed — a number after the label is kept. Examples: `CITempA_relationship`, `CITempA_individual`, `Feed_flow_2_clustering`.
- Allowed characters: letters, digits, `-`, `_`, `.`. Every run of other characters (spaces, brackets, quotes, slashes, non-ASCII) becomes one `_`; `_` and `.` are trimmed from both ends; the name part is capped at 120 characters. An empty name part falls back to the model's sensor tag (`output` / `sensor` / `x_sensor`). A key whose part before the first dot is a Windows device name (`CON`, `NUL`, `COM1` …) gets a leading `_`.
- Keys are unique in one export, compared case-insensitively: when two names give the same key, the later model (in export order) gets `_2`, `_3` … before `_<type>`.
- The model key is only a reference inside the export. It is **not** the platform model ID; IDs are assigned downstream.

## 3. `machine_info.json`

### 3.1 Example

```json
{
  "schema_version": "1.0",
  "exported_at": "2026-10-20T10:00:00+07:00",
  "plant": "Yadana",
  "machine": {
    "tag": "U-2010",
    "name": "MP Compression Train",
    "notes": "Gas turbine driving a 2-stage MP compressor, approx. 13 MW, commissioned 2009. Offshore platform."
  },
  "running_status": {
    "sensor": "SI71089A",
    "stop_if_lower_than": 12000
  },
  "components": ["Gas Generator", "MP Compressor"],
  "sensors": [
    { "tag": "CITempA",  "name": "Average Inlet Temperature",           "description": "", "unit": "DegC", "component": "Gas Generator" },
    { "tag": "SI71089A", "name": "Gas Generator Speed Signal",          "description": "", "unit": "RPM",  "component": "Gas Generator" },
    { "tag": "TC21A",    "name": "GG Input Thrust Bearing Temperature", "description": "", "unit": "DegC", "component": "Gas Generator" },
    { "tag": "TC22A",    "name": "GG Input Thrust Bearing Temperature", "description": "", "unit": "DegC", "component": "Gas Generator" },
    { "tag": "FQI72144", "name": "MP COMP SURGE CTRL",                  "description": "", "unit": "",     "component": "MP Compressor" },
    { "tag": "ZI72144A", "name": "MP COMP ANTI-SURGE",                  "description": "", "unit": "%",    "component": "MP Compressor" }
  ],
  "derived_sensors": [
    {
      "tag": "dTC21_22",
      "name": "Thrust bearing temperature difference",
      "unit": "DegC",
      "component": "Gas Generator",
      "how_to_build": "TC21A minus TC22A"
    }
  ],
  "failure_groups": [
    {
      "name": "GG Mechanical Condition",
      "description": "Mechanical degradation of the gas generator thrust bearing area.",
      "recommendation": "Inspect thrust bearing and lube oil supply.",
      "models": ["CITempA_relationship", "CITempA_individual"]
    }
  ]
}
```

### 3.2 Fields

| Field | Type | Required | Meaning / rules |
|---|---|---|---|
| `schema_version` | string | ✅ | Always `"1.0"` for this spec. |
| `exported_at` | string | ✅ | ISO 8601 timestamp with UTC offset. |
| `plant` | string | ✅ | Plant name as the customer calls it. |
| `machine.tag` | string | ✅ | Machine tag/code (e.g. `U-2010`). |
| `machine.name` | string | ✅ | Machine display name. |
| `machine.notes` | string | – | Free text: nameplate data, ratings, manufacturer, commissioning year, site notes. Empty string if none. |
| `running_status.sensor` | string | ✅ | Tag of the sensor that tells whether the machine is running. Must appear in `sensors` or `derived_sensors`. |
| `running_status.stop_if_lower_than` | number | ✅ | The machine is considered stopped when the sensor is at or below this value. |
| `components` | array of string | ✅ | Component names of the machine, at least one. Names must be unique. |
| `sensors[]` | array | ✅ | Every **raw** sensor used by any model, plus the running-status sensor. One entry per tag; tags must be unique. |
| `sensors[].tag` | string | ✅ | Exactly as in the data source. |
| `sensors[].name` | string | ✅ | Display name. |
| `sensors[].description` | string | – | Empty string if none. |
| `sensors[].unit` | string | – | Engineering unit. Empty string if unknown. |
| `sensors[].component` | string | ✅ | Must be one of `components`. |
| `derived_sensors[]` | array | – | Every calculated sensor used by any model. Empty array if none. |
| `derived_sensors[].tag` | string | ✅ | The column name used in the model training CSVs. Must not collide with a raw tag. |
| `derived_sensors[].name`, `.unit`, `.component` | string | ✅ / – / ✅ | Same rules as `sensors[]`. |
| `derived_sensors[].how_to_build` | string | ✅ | Plain-language recipe that references raw tags exactly (e.g. `"TC21A minus TC22A"`, `"PI101 converted from barg to kPa"`). It must be complete enough to rebuild the value from raw data. |
| `failure_groups[]` | array | – | Empty array if none. |
| `failure_groups[].name` | string | ✅ | Unique within the export. |
| `failure_groups[].description` | string | ✅ | Customer-facing text describing the failure group. |
| `failure_groups[].recommendation` | string | ✅ | Customer-facing recommended action. |
| `failure_groups[].models` | array of string | ✅ | Model keys (section 2.1). Each must exist in `models/`. A model may belong to several groups. |

## 4. Model settings files — `models/<model_key>.json`

### 4.1 Fields common to all kinds

| Field | Type | Required | Meaning / rules |
|---|---|---|---|
| `schema_version` | string | ✅ | `"1.0"` |
| `model_key` | string | ✅ | Equal to the file stem. |
| `kind` | string | ✅ | `"relationship"`, `"individual"` or `"clustering"`. |
| `display_name` | string | – | Optional user-given name. Empty string means a name is generated downstream. |
| `category` | string | ✅ | `"PERFORMANCE"` or `"CONDITION"`. |
| `component` | string | ✅ | One of `machine_info.json` → `components`. |
| `health` | object | ✅ | Kind-specific; see below. All values are user-set in the Wizard and required. |
| `training_data.file` | string | ✅ | `<model_key>.csv` |
| `training_data.note` | string | – | Free text: how the user selected the data (e.g. "running only; excluded Feb-10 trip"). For traceability only; it is never used to re-filter. |

Every tag referenced in a model file must appear in `machine_info.json` → `sensors` or `derived_sensors`.

### 4.2 Relationship

The output sensor is modeled from one or more input sensors. Health is judged on how far the actual value deviates from the expected value.

```json
{
  "schema_version": "1.0",
  "model_key": "CITempA_relationship",
  "kind": "relationship",
  "display_name": "",
  "category": "PERFORMANCE",
  "component": "Gas Generator",
  "output": "CITempA",
  "inputs": ["SI71089A", "TC21A", "TC22A"],
  "fit_profile": "standard",
  "health": {
    "warning": { "low": -4.0, "high": 4.0 },
    "failure": { "low": -8.0, "high": 8.0 }
  },
  "training_data": {
    "file": "CITempA_relationship.csv",
    "note": "running only"
  }
}
```

| Field | Type | Rules |
|---|---|---|
| `output` | string | One tag. |
| `inputs` | array of string | One or more tags, in the order the user selected them. Must not contain `output`. |
| `fit_profile` | string | One of `"very_loose"`, `"loose"`, `"standard"`, `"strict"` (see section 4.5). Export **the name only, never the underlying numeric value**. |
| `health.warning.low/high` | number | Deviation of actual from expected (actual − expected), in the output sensor's unit, at which health reaches the warning level. Requires `low < 0 < high`. |
| `health.failure.low/high` | number | Same, at which health reaches zero. Requires `failure.low < warning.low` and `failure.high > warning.high`. |

### 4.3 Individual

A single sensor is judged against its own normal range.

```json
{
  "schema_version": "1.0",
  "model_key": "CITempA_individual",
  "kind": "individual",
  "display_name": "",
  "category": "PERFORMANCE",
  "component": "Gas Generator",
  "sensor": "CITempA",
  "health": {
    "limits": { "low": 20.0, "high": 35.0 }
  },
  "training_data": {
    "file": "CITempA_individual.csv",
    "note": ""
  }
}
```

| Field | Type | Rules |
|---|---|---|
| `sensor` | string | One tag. |
| `health.limits.low/high` | number | Absolute values in the sensor's unit at which health reaches zero. `low < high`. |

### 4.4 Clustering

Two sensors are judged together against their normal operating pattern. The pattern can be split into regimes by ranges of a criteria sensor.

```json
{
  "schema_version": "1.0",
  "model_key": "FQI72144_clustering",
  "kind": "clustering",
  "display_name": "",
  "category": "CONDITION",
  "component": "MP Compressor",
  "x_sensor": "FQI72144",
  "y_sensor": "ZI72144A",
  "criteria_sensor": "FQI72144",
  "regimes": [
    { "from": null, "to": 200 },
    { "from": 200,  "to": null }
  ],
  "health": {
    "failure_distance": 5
  },
  "training_data": {
    "file": "FQI72144_clustering.csv",
    "note": ""
  }
}
```

| Field | Type | Rules |
|---|---|---|
| `x_sensor`, `y_sensor` | string | Two different tags. |
| `criteria_sensor` | string or null | Tag that splits the regimes. Set to `null` when there is a single regime. |
| `regimes` | array | At least one entry. With a single regime: `[{"from": null, "to": null}]`. |
| `regimes[].from` / `.to` | number or null | A value belongs to a regime when `from < value <= to`; `null` means unbounded. Regimes must be ordered, contiguous and non-overlapping: each `from` equals the previous `to`, the first `from` is `null` and the last `to` is `null`. |
| `health.failure_distance` | number | The value the user set in the Wizard for the distance from the normal pattern at which health reaches zero. Must be > 3. |

### 4.5 `fit_profile` mapping — INTERNAL, never exported

The Wizard uses this table to train its preview. The implementation module uses the same table when it retrains. Only the profile name appears in the export.

| `fit_profile` | UI label | Internal value |
|---|---|---|
| `very_loose` | Very loose | 1,000 |
| `loose` | Loose | 10,000 |
| `standard` | Standard | 100,000 |
| `strict` | Strict | 1,000,000 |

Do not change these values without bumping `schema_version`; otherwise the retrained model will no longer match the Wizard preview.

## 5. Training data files — `models/<model_key>.csv`

- Contains **exactly** the rows the user selected and trained on in the Wizard, after all user slicing and filtering, and after removing rows with missing values in the model's columns.
- Columns, in this order:
  1. `TimeStamp`: ISO 8601 with UTC offset, e.g. `2024-01-09T22:05:00+07:00`.
  2. The model's sensor columns only:
     - relationship: `inputs…`, then `output`;
     - individual: `sensor`;
     - clustering: `x_sensor`, `y_sensor`, then `criteria_sensor` if it is not already one of the two.
- Derived sensors appear as already-computed columns named by their `tag`.
- Header names are exactly the tags. No index column and no extra columns: no predictions, residuals, cluster labels or flags.
- Rows are sorted by `TimeStamp` ascending, with no duplicate timestamps.
- Comma-separated, `.` as decimal separator, UTF-8, no thousands separators.

## 6. Must NOT appear anywhere in the export

- Serialized models (`.pkl`, `.joblib` or any other binary).
- Fitted results: mean, sd, sigma bands, cluster centers, axis spreads, angles, R², RMSE or any other fit metric.
- Predicted or residual values.
- Internal parameter names or the numeric values behind `fit_profile`.
- Library or algorithm names in keys, values, file names or column names.
- Platform IDs (plant, machine, component or model IDs), publish IDs, update records or storage paths.
- Python object representations in any string (e.g. `['A', 'B']`, `{'A'}`).

## 7. Export checklist (Wizard self-validation before writing)

1. `machine_info.json` exists and every required field is filled.
2. Every model has both `.json` and `.csv`, with the key matching the file stem.
3. Every tag referenced by a model or by `running_status` is listed in `sensors` or `derived_sensors`.
4. Every `component` reference (sensors, derived sensors, models) is in `components`.
5. Every model key in `failure_groups[].models` exists.
6. Health value ordering rules (sections 4.2–4.4) hold.
7. Nothing listed in section 6 is present.
