# Wizard Output Specification — v1.1

**Audience:** Wizard developers. **Status:** issued 2026-11-10. **Replaces:** v1.0 (2026-10-20).

This document defines **what the Wizard must export**. It does not prescribe how the Wizard's UI or internals work.

## 0. Changes from v1.0

Based on the review of the test export `test_export (1)` (bangchak / GEG-4). That export complies with v1.0: format, file layout and values were all correct, and the models were rebuilt successfully from it. The changes below come from new requirements, not from defects.

| # | Change | Sections | What the Wizard must do |
|---|---|---|---|
| C1 | **`sensors[]` lists every raw sensor in the machine's data**, not only the ones used by models. | 3.2 | Export one entry per raw tag in the data loaded in the Wizard session, whether or not a model uses it. The test export listed 4 sensors; it must list all of them. |
| C2 | **`derived_sensors[]` lists every derived sensor defined in the session**, not only the ones used by models. | 3.2 | Export every derived sensor the user created. |
| C3 | **New folder `derived/` with one data file per derived sensor.** | 2, 5.1 | Write `derived/<derived_tag>.csv` containing the derived value and the inputs it is built from. |
| C4 | **Clarification: regime boundaries.** No format change. | 4.4 | When the Wizard assigns training rows to clustering regimes for its preview, it must use `from < value <= to` (lower bound excluded, upper bound included), the same rule as the export. The current Wizard code uses `from <= value < to`. |
| C5 | `schema_version` is `"1.1"`. | 3.2, 4.1 | — |
| C6 | Export checklist extended. | 7 | New checks for C1–C3. |

Everything else is unchanged from v1.0.

**Request for the next test export:** please include at least one derived sensor (with its `derived/` file) and at least one sensor that no model uses. It also helps if the test data have plausible units: in the current test export, `11PDT1247.PV` is labelled `BARG` but reads around −6.0, which is not a possible gauge pressure.

---

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
├── derived/                  only if derived_sensors is non-empty      ← NEW in v1.1
│   └── <derived_tag>.csv     data of one derived sensor and its inputs
└── models/
    ├── <model_key>.json      model settings (one per model)
    └── <model_key>.csv       exact training data for that model
```

- Each model produces exactly one `.json` and one `.csv` with the same `<model_key>` stem.
- One sensor may have multiple models; each is a separate pair of files.
- Each derived sensor produces exactly one `derived/<derived_tag>.csv`.
- Encoding: UTF-8. JSON is pretty-printed.

### 2.1 Model key

- Format: `<target_tag>-<R|I|C><n>`, where `R` = relationship, `I` = individual, `C` = clustering, and `n` is a counter starting at 1 that is unique per target tag and kind. Examples: `CITempA-R1`, `CITempA-I1`, `ZI72144A-C1`.
- `target_tag` is `output` for relationship, `sensor` for individual and `y_sensor` for clustering.
- Allowed characters: letters, digits, `-`, `_`, `.`. No spaces, brackets or quotes. If a tag contains other characters, replace them with `_`. The same rule applies to `<derived_tag>` in `derived/` file names.
- The model key is only a reference inside the export. It is **not** the platform model ID; IDs are assigned downstream.

## 3. `machine_info.json`

### 3.1 Example

```json
{
  "schema_version": "1.1",
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
    { "tag": "ZI72144A", "name": "MP COMP ANTI-SURGE",                  "description": "", "unit": "%",    "component": "MP Compressor" },
    { "tag": "PI71001",  "name": "Fuel Gas Supply Pressure",            "description": "", "unit": "barg", "component": "" }
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
      "models": ["CITempA-R1", "CITempA-I1"]
    }
  ]
}
```

In this example `PI71001` is not used by any model; it is still listed (C1). The example shows only a few sensors; a real export lists every raw sensor in the data.

### 3.2 Fields

| Field | Type | Required | Meaning / rules |
|---|---|---|---|
| `schema_version` | string | ✅ | Always `"1.1"` for this spec. |
| `exported_at` | string | ✅ | ISO 8601 timestamp with UTC offset. |
| `plant` | string | ✅ | Plant name as the customer calls it. |
| `machine.tag` | string | ✅ | Machine tag/code (e.g. `U-2010`). |
| `machine.name` | string | ✅ | Machine display name. |
| `machine.notes` | string | – | Free text: nameplate data, ratings, manufacturer, commissioning year, site notes. Empty string if none. |
| `running_status.sensor` | string | ✅ | Tag of the sensor that tells whether the machine is running. Must appear in `sensors` or `derived_sensors`. |
| `running_status.stop_if_lower_than` | number | ✅ | The machine is considered stopped when the sensor is at or below this value. |
| `components` | array of string | ✅ | Component names of the machine, at least one. Names must be unique. |
| `sensors[]` | array | ✅ | **Changed in v1.1.** Every **raw** sensor in the machine's data loaded in the Wizard session, whether or not a model uses it. One entry per tag; tags must be unique. |
| `sensors[].tag` | string | ✅ | Exactly as in the data source. |
| `sensors[].name` | string | ✅ | Display name. |
| `sensors[].description` | string | – | Empty string if none. |
| `sensors[].unit` | string | – | Engineering unit. Empty string if unknown. |
| `sensors[].component` | string | – | One of `components`, or empty string. |
| `derived_sensors[]` | array | – | **Changed in v1.1.** Every calculated sensor defined in the session, whether or not a model uses it. Empty array if none. |
| `derived_sensors[].tag` | string | ✅ | The column name used in the model training CSVs and in `derived/<tag>.csv`. Must not collide with a raw tag. |
| `derived_sensors[].name` | string | ✅ | Display name. |
| `derived_sensors[].unit` | string | – | Same rule as `sensors[].unit`. |
| `derived_sensors[].component` | string | – | Same rule as `sensors[].component`. |
| `derived_sensors[].how_to_build` | string | ✅ | Plain-language recipe that references its input tags exactly (e.g. `"TC21A minus TC22A"`, `"PI101 converted from barg to kPa"`). It must be complete enough to rebuild the value from its inputs, and must reference the same tags as the input columns of `derived/<tag>.csv`. |
| `failure_groups[]` | array | – | Empty array if none. |
| `failure_groups[].name` | string | ✅ | Unique within the export. |
| `failure_groups[].description` | string | ✅ | Customer-facing text describing the failure group. |
| `failure_groups[].recommendation` | string | ✅ | Customer-facing recommended action. |
| `failure_groups[].models` | array of string | ✅ | Model keys (section 2.1). Each must exist in `models/`. A model may belong to several groups. |

**What counts as a derived sensor.** A derived sensor is a value the Wizard (or the user's data preparation) calculates from other sensors in the same data. If a calculated value arrives already computed in the customer's data and its inputs are not available, it is **not** a derived sensor: list it in `sensors[]` as a raw sensor.

## 4. Model settings files — `models/<model_key>.json`

### 4.1 Fields common to all kinds

| Field | Type | Required | Meaning / rules |
|---|---|---|---|
| `schema_version` | string | ✅ | `"1.1"` |
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
  "schema_version": "1.1",
  "model_key": "CITempA-R1",
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
    "file": "CITempA-R1.csv",
    "note": "running only"
  }
}
```

| Field | Type | Rules |
|---|---|---|
| `output` | string | One tag. |
| `inputs` | array of string | One or more tags, in the order the user selected them. Must not contain `output`. |
| `fit_profile` | string | One of `"very_loose"`, `"loose"`, `"standard"`, `"strict"` (see section 4.5). Export **the name only, never the underlying numeric value**. |
| `health.warning.low/high` | number | Deviation of actual from expected (actual − expected), in the output sensor's unit, at which health reaches the warning level (health 80). Requires `low < 0 < high`. |
| `health.failure.low/high` | number | Same, at which health reaches zero. Requires `failure.low < warning.low` and `failure.high > warning.high`. |

### 4.3 Individual

A single sensor is judged against its own normal range.

```json
{
  "schema_version": "1.1",
  "model_key": "CITempA-I1",
  "kind": "individual",
  "display_name": "",
  "category": "PERFORMANCE",
  "component": "Gas Generator",
  "sensor": "CITempA",
  "health": {
    "limits": { "low": 20.0, "high": 35.0 }
  },
  "training_data": {
    "file": "CITempA-I1.csv",
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
  "schema_version": "1.1",
  "model_key": "ZI72144A-C1",
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
    "file": "ZI72144A-C1.csv",
    "note": ""
  }
}
```

| Field | Type | Rules |
|---|---|---|
| `x_sensor`, `y_sensor` | string | Two different tags. |
| `criteria_sensor` | string or null | Tag that splits the regimes. Set to `null` when there is a single regime. |
| `regimes` | array | At least one entry. With a single regime: `[{"from": null, "to": null}]`. |
| `regimes[].from` / `.to` | number or null | A value belongs to a regime when `from < value <= to`; `null` means unbounded. Regimes must be ordered, contiguous and non-overlapping: each `from` equals the previous `to`, the first `from` is `null` and the last `to` is `null`. **Clarified in v1.1:** the Wizard's own preview must assign training rows to regimes with this same rule (lower bound excluded, upper bound included). |
| `health.failure_distance` | number | The value the user set in the Wizard for the distance from the normal pattern at which health reaches zero. Must be > 3. |

### 4.5 `fit_profile` mapping — INTERNAL, never exported

The Wizard uses this table to train its preview. The implementation module uses the same table when it trains. Only the profile name appears in the export.

| `fit_profile` | UI label | Internal value |
|---|---|---|
| `very_loose` | Very loose | 1,000 |
| `loose` | Loose | 10,000 |
| `standard` | Standard | 100,000 |
| `strict` | Strict | 1,000,000 |

Do not change these values without bumping `schema_version`; otherwise the trained model will no longer match the Wizard preview.

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

### 5.1 Derived sensor data files — `derived/<derived_tag>.csv` (NEW in v1.1)

One file per entry in `derived_sensors[]`. It lets the derived sensor be rebuilt and checked downstream against the exact values the Wizard used.

Example `derived/dTC21_22.csv`:

```
TimeStamp,TC21A,TC22A,dTC21_22
2024-01-09T22:05:00+07:00,63.804,60.298,3.506
2024-01-09T22:10:00+07:00,63.804,60.298,3.506
```

- Columns, in this order:
  1. `TimeStamp`, same format as section 5.
  2. Every input tag the derived sensor is built from, in the order they appear in `how_to_build`.
  3. The derived sensor's own `tag`, as the last column.
- An input may be another derived sensor (a chained calculation). That input then has its own `derived/` file.
- Every input tag must appear in `sensors[]` or `derived_sensors[]`.
- Rows: every row of the session's data where all inputs and the derived value are present (no missing values). This is independent of which models use the derived sensor, and of any model's training selection.
- The derived values must be exactly the values the Wizard computed and used in the model training CSVs: same timestamps give the same value.
- Same formatting rules as section 5: sorted by `TimeStamp`, no duplicate timestamps, no index column, no extra columns, comma-separated, `.` decimal separator, UTF-8.

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
4. Every **non-empty** `component` reference (sensors, derived sensors) and every model `component` is in `components`.
5. Every model key in `failure_groups[].models` exists.
6. Health value ordering rules (sections 4.2–4.4) hold.
7. Nothing listed in section 6 is present.
8. **NEW:** `sensors[]` contains every raw tag in the session's data; `derived_sensors[]` contains every derived sensor defined in the session.
9. **NEW:** Every derived sensor has exactly one `derived/<derived_tag>.csv`; its input columns are all in `sensors` or `derived_sensors`; its last column is the derived tag.
10. **NEW:** For every derived sensor used in a model, its values in the model training CSV equal its values in `derived/<derived_tag>.csv` at the same timestamps.
