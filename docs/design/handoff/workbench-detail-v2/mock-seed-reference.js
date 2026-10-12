// A ready-made example project so a first-time viewer has something to open.
// Written once, only when this browser has no Wizard mock data yet. SEED_VERSION 2 (Train/Test
// validation, 2026-10-07) replaces an older copy of the example project (other projects are kept).
const SEED_VERSION = '19'; // 19 = "No data" seed (STEAM PRESSURE HRSG4, own train period before the data starts); // 14 = Clustering (GENERATOR ACTIVE POWER vs BEARING DE TEMP) trained, 2 criteria ranges; // 13 = BEARING VIBRATION X Complete (Workspace mode) for the Apply warnings; // 12 = Relation model (BEARING DE TEMPERATURE) trained + up to date, set points empty // 9 = repair-mode seed: LO_PRESS_MARGIN (old Excel-style round, used by a model) // 4 = merged mockup (items 3-9): FG count chips, extra example projects
import { computeTrainFingerprint } from '../app/src/utils/trainFingerprint';
export function seedIfEmpty() {
  let upgrade = false;
  try {
    if (localStorage.getItem('wizstore:settings.json') != null) {
      if (localStorage.getItem('wizmock.seed') === SEED_VERSION) return;
      upgrade = true;
    }
    localStorage.setItem('wizmock.seed', SEED_VERSION);
  } catch { return; }
  const id = 'ws_demo_geg4';
  const base = {
    category: 'condition', notes: '', status: false, targetSensor: '', predictorSensors: [], xSensor: '', ySensor: '',
    individualChecked: false, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100000, clusterModelName: '',
    numClusters: 3, criteriaSensor: '', clusterRanges: [{ min: 0, max: 33 }, { min: 33, max: 66 }, { min: 66, max: 100 }],
    filterTimePeriods: [], runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
    customRunningConditionNoneConfirmed: false,
  };
  let n = 0;
  const mk = (kind, groupNos, name, o) => ({ ...JSON.parse(JSON.stringify(base)), id: `model-demo-${++n}`, kind, groupNos, name, ...o });
  const ind = (tag, g, name, lo, hi) => mk('individual', g, name, { targetSensor: tag, individualChecked: true, healthSetPoints: { kind: 'individual', lower: lo, upper: hi, masterLower: lo, masterUpper: hi } });
  const rel = (tag, g, name, preds, cat) => mk('relationship', g, name, { targetSensor: tag, predictorSensors: preds, rcMode: 'relationship', relModelName: `${name} vs ${preds.length} predictors`, category: cat || 'condition', healthSetPoints: { kind: 'relationship', residualAt80Lower: null, residualAt80Upper: null, residualAt0Lower: null, residualAt0Upper: null } });
  const models = [
    ind('11LT1601.PV', [1], 'BOILER DRUM LEVEL', 10, 95),
    // LO_PRESS_MARGIN (repair mode) is used by this model, so the repair demo keeps its 'used by a model' case.
    rel('11LT1601.PV', [1], 'BOILER DRUM LEVEL', ['11FQ1603.PV', '11PT1604.PV', 'LO_PRESS_MARGIN'], 'performance'),
    // Seed 16: own (Custom) running condition with an invalid period -> blocked, the reason points to Model settings.
    { ...ind('11MOV1603.PV', [1], 'DAMPER FOR BOILER BYPASS', null, null), runningConditionMode: 'custom', filterTimePeriods: [{ id: 'cp-1', start: '2026-05-01T00:00', end: '2026-04-01T00:00' }], customRunningConditionFilters: [{ id: 'crc-1', sensor: '11EI1301.PV', operation: 'greater_than', value1: '1000', value2: '' }] },
    { ...ind('11TE1405.PV', [2], 'BEARING DE TEMPERATURE', 40, 85), lastTrainedAt: '2026-10-08T14:22:00', healthVerdict: 'valid' },
    // Seed 12: trained in the same run as the Individual model and up to date; the four residual points start EMPTY.
    { ...rel('11TE1405.PV', [2], 'BEARING DE TEMPERATURE', ['GEN_LOAD_PCT', '11TE1520.PV']), lastTrainedAt: '2026-10-08T14:22:00', healthVerdict: 'incomplete' },
    // Seed 14: trained + up to date, split by cooling water outlet temp into 2 criteria ranges; N starts EMPTY.
    { ...mk('clustering', [2], 'BEARING DE TEMPERATURE', { targetSensor: '11TE1405.PV', xSensor: '11EI1301.PV', ySensor: '11TE1405.PV', rcMode: 'clustering', numClusters: 2, criteriaSensor: '11TE1520.PV', clusterRanges: [{ min: 26, max: 36 }, { min: 36, max: 42 }], clusterModelName: 'BEARING DE TEMPERATURE clusters', healthSetPoints: { kind: 'clustering', outerSd: null } }), lastTrainedAt: '2026-10-08T14:22:00', healthVerdict: 'incomplete' },
    // Seed 13: Complete, Workspace mode — the running-condition Apply warnings have a Complete model to talk about.
    { ...ind('11VT1410.PV', [2], 'BEARING VIBRATION X', 0.2, 4.5), lastTrainedAt: '2026-10-08T14:22:00', status: true, healthVerdict: 'valid',
      healthExport: { at: '2026-10-08T14:31:00', outputDir: 'C:\\Users\\you\\AppData\\Roaming\\com.wizard.app\\workspaces\\ws_demo_geg4\\output\\11VT1410.PV', setPoints: { kind: 'individual', lower: 0.2, upper: 4.5, masterLower: 0.2, masterUpper: 4.5 } } },
    // Seed 17: trained, set points valid, not complete -> Mark complete shows Saving…, and its first save fails (mock).
    { ...ind('11TE1520.PV', [3, 2], 'COOLING WATER OUTLET TEMP', 25, 48), lastTrainedAt: '2026-10-08T14:22:00', healthVerdict: 'valid' },
    // Seed 19: trained, but its own (Custom) train period lies before the loaded data starts -> "No data for this model in the loaded file".
    { ...ind('11PT1604.PV', [1], 'STEAM PRESSURE HRSG4', 5, 30), runningConditionMode: 'custom', filterTimePeriods: [{ id: 'cp-nd', start: '2025-01-01T00:00', end: '2025-03-01T00:00' }], customRunningConditionFilters: [{ id: 'crc-nd', sensor: '11EI1301.PV', operation: 'greater_than', value1: '1000', value2: '' }], lastTrainedAt: '2026-10-08T14:22:00', healthVerdict: 'valid' },
    ind('11PT1522.PV', [3], 'COOLING WATER PRESSURE', 2.2, 4.6),
    // No predictors yet -> "Can't train" in Train all (skipped, never blocks the run).
    rel('11PT1522.PV', [3], 'COOLING WATER PRESSURE', []),
  ];
  const sel = ['11LT1601.PV', '11FQ1603.PV', '11TE1405.PV', '11EI1301.PV'];
  const ws = {
    id, name: 'GEG-4 Bearing study', description: 'Gas engine generator 4 — bearing and cooling water (example data)', lastRoute: 'dashboard',
    dataFilePaths: ['C:\\Data\\GEG-4\\raw_data_2026_Q1.csv', 'C:\\Data\\GEG-4\\raw_data_2026_Q2.csv'], metadataFilePath: null,
    selectedSensors: sel, visibleSensors: sel.slice(), operationConfig: null,
    mappingFilePath: 'C:\\Data\\GEG-4\\master_data.csv', mappingKeyColumn: 'TAG',
    filters: { timestampStart: '2026-02-07T23:50', timestampEnd: '2026-08-07T23:50', sensorFilters: [] },
    chartType: 'line', samplingMethod: 'raw', collapsedPanels: [], layoutSizes: { columns: [66.67, 33.33], leftRows: [60, 40] },
    failureGroupState: {
      groups: [
        { no: 0, name: 'Not in Group' },
        { no: 1, name: 'Abnormal Boiler System', description: 'Drum level or feed water flow drifting away from the load-based expectation.', recommendation: 'Check the feed water control valve and the drum level transmitter.' },
        { no: 2, name: 'Generator mechanical condition', description: 'Bearing wear or misalignment on the generator drive end.', recommendation: 'Check DE bearing vibration trend and lube oil; plan an inspection at the next stop.' },
        { no: 3, name: 'Abnormal cooling water system' },
        { no: 4, name: 'Lube oil pressure low', description: 'Lube oil header pressure falling at the same load.', recommendation: 'Check the lube oil filter differential pressure and pump discharge.' },
      ],
      models, rcLegacyNotice: null, categoryNormalisationNotice: null,
      runningConditionFilters: [{ id: 'rc-1', sensor: '11EI1301.PV', operation: 'greater_than', value1: '1000', value2: '' }],
      runningConditionCombine: 'and',
      runningConditionTimePeriods: [{ id: 'tp-1', start: '2026-02-09T00:00', end: '2026-04-30T23:50' }, { id: 'tp-2', start: '2026-05-11T00:00', end: '2026-06-15T23:50' }],
      runningConditionTestPeriods: [
        { id: 'tt-1', start: '2026-06-01T00:00', end: '2026-07-05T23:50', label: 'unknown' },
        { id: 'tt-2', start: '2026-07-15T00:00', end: '2026-08-07T23:50', label: 'unknown', fromHighlight: 'Bearing DE temp rising' },
      ],
    },
    alarmLinesEnabled: {}, scatterAxes: { x: '11EI1301.PV', y: '11TE1405.PV' },
    // Special sensors: GEN_LOAD_PCT is used by the Relation model above -> LOCKED in Manage;
    // BRG_TEMP_AVG is an existing Average block; LO_TANK_MARGIN references the Thai/spaced tag as ${…}.
    extraSensorMetadata: [
      { tag: 'GEN_LOAD_PCT', description: 'GENERATOR LOAD PERCENT', unit: '%', component: 'GENERATOR' },
      { tag: 'BRG_TEMP_AVG', description: 'BEARING AND COOLING WATER TEMPERATURE AVERAGE', unit: 'DEGC', component: 'GENERATOR' },
      { tag: 'LO_TANK_MARGIN', description: 'LUBE OIL TANK TEMPERATURE MARGIN TO HIGH ALARM', unit: 'DEGC', component: 'LUBE OIL SYSTEM' },
      { tag: 'BRG_RISE_OVER_CW', description: 'BEARING AVG TEMP RISE OVER COOLING WATER', unit: 'DEGC', component: 'GENERATOR' },
      { tag: 'CW_TEMP_RISE', description: 'COOLING WATER TEMPERATURE RISE', unit: 'DEGC', component: 'COOLING AND DRAIN WATER SYSTEM' },
      { tag: 'LO_PRESS_MARGIN', description: 'LUBE OIL PRESSURE MARGIN TO LOW ALARM', unit: 'BAR', component: 'LUBE OIL SYSTEM' },
    ],
    specialSensorRecipes: [
      { kind: 'formula', tag: 'GEN_LOAD_PCT', formula: 'round(0.1, $11EI1301.PV / 8400 * 100)' },
      { kind: 'operation', tag: 'BRG_TEMP_AVG', sourceSensors: ['11TE1405.PV', '11TE1520.PV'], operationConfig: { mode: 'multi', multiOp: { type: 'mean' } } },
      { kind: 'formula', tag: 'LO_TANK_MARGIN', formula: '70 - ${อุณหภูมิ ถังน้ำมัน 2}' },
      // Built on BRG_TEMP_AVG -> that one cannot be deleted ("Used by BRG_RISE_OVER_CW — remove it there first").
      { kind: 'formula', tag: 'BRG_RISE_OVER_CW', formula: '$BRG_TEMP_AVG - $11TE1520.PV' },
      // Its source 11TE1519.PV is not in this dataset (renamed in the historian) -> red token + Replace… in Edit.
      { kind: 'formula', tag: 'CW_TEMP_RISE', formula: '$11TE1520.PV - $11TE1519.PV' },
      // REPAIR MODE (dev 2026-10-09): an old hand-typed Excel-style round(x, n) is refused by the stricter
      // gate, so this sensor has no column this session -> "No data — fix formula"; a model uses it, so
      // normally it would be locked, but the fix is allowed (name stays locked). Saving the fix sets that
      // model back to Incomplete.
      { kind: 'formula', tag: 'LO_PRESS_MARGIN', formula: 'round(($11PT1901.PV - 3.4) * 100) / 100' },
    ],
    sensorColors: {}, sensorAxisRange: {}, scatterAxisPins: {}, timeHighlights: [
      { id: 'hl-1', start: '2026-03-23T00:00', end: '2026-03-24T23:50', label: 'CW pressure dip', color: '#f59e0b', enabled: true },
      { id: 'hl-2', start: '2026-05-01T00:00', end: '2026-05-10T23:50', label: 'Lube oil top-up', color: '#3b82f6', enabled: true },
      { id: 'hl-3', start: '2026-06-16T00:00', end: '2026-07-05T23:50', label: 'After overhaul — normal', color: '#10b981', enabled: true },
      { id: 'hl-4', start: '2026-07-15T00:00', end: '2026-08-07T23:50', label: 'Bearing DE temp rising', color: '#ef4444', enabled: true },
    ], highlightLineDisplay: 'band',
    valueHighlight: { sensor: '', ranges: [] }, relativeTimeRange: { amount: '6', unit: 'M' },
  };
  // Two more example projects on the same data: one saved before the failure-group count existed
  // (no chip on its card), one whose failure-group step was skipped (0 groups -> lands on the FG tab).
  for (const m of ws.failureGroupState.models) if (m.lastTrainedAt && (m.kind === 'individual' || m.id === 'model-demo-5' || m.id === 'model-demo-6')) m.trainedFingerprint = computeTrainFingerprint(m, ws.failureGroupState);
  const old = { ...ws, id: 'ws_demo_geg4_lube', name: 'GEG-4 Lube oil review', description: 'Lube oil pressure and temperature, Q1 2026', lastRoute: 'dashboard',
    failureGroupState: { ...ws.failureGroupState, groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'Lube oil degradation' }], models: [models[0]].map(m => ({ ...m, id: 'model-lube-1', groupNos: [1] })),
      // No running condition yet -> Build Model shows Step 1 NOT SET and nothing can train (0 ready).
      runningConditionFilters: [], runningConditionTimePeriods: [], runningConditionTestPeriods: [] } };
  const skipped = { ...ws, id: 'ws_demo_geg4_cw', name: 'GEG-4 Cooling water check', description: 'Cooling water outlet temperature and pressure, 2026', lastRoute: 'dashboard', selectedSensors: ['11TE1520.PV', '11PT1522.PV'], visibleSensors: ['11TE1520.PV', '11PT1522.PV'],
    failureGroupState: { ...ws.failureGroupState, groups: [{ no: 0, name: 'Not in Group' }], models: [] } };
  const entry = (w, t, extra) => ({ id: w.id, name: w.name, description: w.description, lastModified: t, filePath: `workspaces/${w.id}.json`, ...extra });
  const entries = [
    entry(ws, Date.UTC(2026, 9, 8, 7, 30), { failureGroupCount: 4, failureGroupNos: [1, 2, 3] }),
    entry(skipped, Date.UTC(2026, 9, 7, 15, 10), { failureGroupCount: 0, failureGroupNos: [] }),
    entry(old, Date.UTC(2026, 8, 12, 9, 0)),
  ];
  try {
    for (const w of [ws, old, skipped]) localStorage.setItem(`wizfs:workspaces/${w.id}.json`, JSON.stringify(w));
    localStorage.setItem('wizfs:workspaces/', '');
    let keep = [];
    if (upgrade) { try { keep = (JSON.parse(localStorage.getItem('wizstore:settings.json') || '{}').recent_workspaces || []).filter(r => !entries.some(e => e.id === r.id)); } catch { } }
    let settings = {}; try { settings = JSON.parse(localStorage.getItem('wizstore:settings.json') || '{}'); } catch { }
    localStorage.setItem('wizstore:settings.json', JSON.stringify({ ...settings, recent_workspaces: [...entries, ...keep] }));
  } catch { }
}
