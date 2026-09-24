import type { FailureModel } from '../../types';

export function mk(over: Partial<FailureModel> & { id: string }): FailureModel {
    return {
        groupNos: [1], name: over.id, kind: 'individual', category: null, notes: '', status: false,
        xSensor: '', ySensor: '', targetSensor: '', predictorSensors: [], individualChecked: false,
        rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 0, clusterModelName: '',
        numClusters: 1, criteriaSensor: '', clusterRanges: [], filterTimeStart: '', filterTimeEnd: '',
        runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
        ...over,
    };
}
