/**
 * Normalize and evaluate alert thresholds against incoming telemetry payload.
 */

const SUPPORTED_PARAMS = [
    'voltage_ln_SUM',
    'voltage_ll_SUM',
    'current_R', 'current_S', 'current_T',
    'pf_SUM',
    'thd_v_SUM', 'thd_a_SUM'
];

const MAX_ONLY_PARAMS = [
    'current_R', 'current_S', 'current_T',
    'thd_v_SUM', 'thd_a_SUM'
];

function normalizeThresholds(rawThresholds) {
    if (!rawThresholds || typeof rawThresholds !== 'object') return {};

    const normalized = {};

    for (const [key, config] of Object.entries(rawThresholds)) {
        if (!SUPPORTED_PARAMS.includes(key)) continue;
        if (!config || typeof config !== 'object') continue;

        const isMaxOnly = MAX_ONLY_PARAMS.includes(key);

        const safeConfig = {
            enabled: config.enabled !== undefined ? Boolean(config.enabled) : (config.min !== undefined || config.max !== undefined),
            severity: String(config.severity || 'warning'),
            max: config.max !== undefined && config.max !== null ? Number(config.max) : null
        };

        if (config.hysteresis !== undefined && config.hysteresis !== null) {
            safeConfig.hysteresis = Number(config.hysteresis);
        } else {
            if (key.startsWith('voltage_')) safeConfig.hysteresis = 2;
            else if (key.startsWith('current_')) safeConfig.hysteresis = 3;
            else if (key.startsWith('thd_')) safeConfig.hysteresis = 5;
            else safeConfig.hysteresis = 2;
        }

        if (!isMaxOnly) {
            safeConfig.min = config.min !== undefined && config.min !== null ? Number(config.min) : null;
        }

        normalized[key] = safeConfig;
    }

    return normalized;
}

function extractMetrics(payload) {
    if (!payload || typeof payload !== 'object') return {};

    const metrics = {};

    // Helper to wrap value into {now, min, max} object
    const wrap = (val) => {
        if (val === undefined || val === null) return null;
        if (typeof val === 'object') {
            const now = val.now ?? val.avg ?? val.max ?? val.min;
            const min = val.min ?? now;
            const max = val.max ?? now;
            return { now, min, max };
        }
        return { now: val, min: val, max: val };
    };

    const averageMetric = (...metricList) => {
        const validMetrics = metricList.filter((metric) => metric && Number.isFinite(Number(metric.now)));
        if (validMetrics.length === 0) return null;

        const avgNow = validMetrics.reduce((sum, metric) => sum + Number(metric.now), 0) / validMetrics.length;
        const avgMin = validMetrics.reduce((sum, metric) => sum + Number(metric.min), 0) / validMetrics.length;
        const avgMax = validMetrics.reduce((sum, metric) => sum + Number(metric.max), 0) / validMetrics.length;

        return {
            now: avgNow,
            min: avgMin,
            max: avgMax
        };
    };

    // 1. Try NEW Flat Format
    const vRn = wrap(payload.V_RN);
    const vSn = wrap(payload.V_SN);
    const vTn = wrap(payload.V_TN);
    const vRs = wrap(payload.V_RS);
    const vSt = wrap(payload.V_ST);
    const vTr = wrap(payload.V_TR);

    metrics.voltage_ln_SUM = wrap(payload.V_LN_SUM) || wrap(payload.V_LN) || averageMetric(vRn, vSn, vTn);
    metrics.voltage_ll_SUM = wrap(payload.V_LL_SUM) || wrap(payload.V_LL) || averageMetric(vRs, vSt, vTr);

    if (payload.I_R !== undefined) metrics.current_R = wrap(payload.I_R);
    if (payload.I_S !== undefined) metrics.current_S = wrap(payload.I_S);
    if (payload.I_T !== undefined) metrics.current_T = wrap(payload.I_T);

    metrics.pf_SUM = wrap(payload.PF_SUM) || wrap(payload.PF) || wrap(payload.SUM_PF);

    if (payload.SUM_V_THD !== undefined) metrics.thd_v_SUM = wrap(payload.SUM_V_THD);
    if (payload.SUM_A_THD !== undefined) metrics.thd_a_SUM = wrap(payload.SUM_A_THD);

    // 2. Try NESTED format
    if (payload.phase_values) {
        const pv = payload.phase_values;
        const nVrn = wrap(pv.R?.VOLTAGE);
        const nVsn = wrap(pv.S?.VOLTAGE);
        const nVtn = wrap(pv.T?.VOLTAGE);

        if (!metrics.voltage_ln_SUM) {
            metrics.voltage_ln_SUM = wrap(pv.SUM?.VOLTAGE) || averageMetric(nVrn, nVsn, nVtn);
        }

        if (!metrics.voltage_ll_SUM) {
            metrics.voltage_ll_SUM = wrap(pv.SUM?.VOLTAGE_LL);
        }

        if (pv.R?.AMPERE) metrics.current_R = wrap(pv.R.AMPERE);
        if (pv.S?.AMPERE) metrics.current_S = wrap(pv.S.AMPERE);
        if (pv.T?.AMPERE) metrics.current_T = wrap(pv.T.AMPERE);

        if (!metrics.pf_SUM) metrics.pf_SUM = wrap(pv.SUM?.POWER_FACTOR);
        if (!metrics.thd_v_SUM) metrics.thd_v_SUM = wrap(pv.SUM?.VOLTAGE_THD);
        if (!metrics.thd_a_SUM) metrics.thd_a_SUM = wrap(pv.SUM?.AMPERE_THD);
    }

    return metrics;
}

/**
 * Evaluates a single metric against a single threshold config.
 * @param {Object} metric - { now, min, max }
 */
const evaluateMetric = (metric, config, activeSession) => {
    if (!config || !config.enabled || !metric) return null;

    const { max, min, hysteresis } = config;
    const valNow = metric.now;
    const valMax = metric.max;
    const valMin = metric.min;

    // Logic for High Violation (max)
    if (max !== null && max !== undefined) {
        if (!activeSession || activeSession.thresholdType === 'max') {
            // Trigger check using interval MAX
            if (valMax > max) {
                console.log(`[EVAL_DEBUG] MAX Trigger: interval max ${valMax} > threshold ${max}`);
                return { action: activeSession ? 'UPDATE_PEAK' : 'OPEN', type: 'max', value: valMax };
            }
            if (activeSession && activeSession.thresholdType === 'max') {
                const hysFactor = (hysteresis || 2) / 100;
                const clearThreshold = max - (max * hysFactor);
                if (valMax <= clearThreshold) {
                    console.log(`[EVAL_DEBUG] MAX Resolve: interval max ${valMax} <= clear ${clearThreshold}`);
                    return { action: 'RESOLVE', value: valMax };
                }
                return { action: 'UPDATE_PEAK', type: 'max', value: valMax };
            }
        }
    }

    // Logic for Low Violation (min)
    if (min !== null && min !== undefined) {
        if (!activeSession || activeSession.thresholdType === 'min') {
            // Trigger check using interval MIN
            if (valMin < min) {
                console.log(`[EVAL_DEBUG] MIN Trigger: interval min ${valMin} < threshold ${min}`);
                return { action: activeSession ? 'UPDATE_PEAK' : 'OPEN', type: 'min', value: valMin };
            }
            if (activeSession && activeSession.thresholdType === 'min') {
                const hysFactor = (hysteresis || 2) / 100;
                const clearThreshold = min + (min * hysFactor);
                if (valMin >= clearThreshold) {
                    console.log(`[EVAL_DEBUG] MIN Resolve: interval min ${valMin} >= clear ${clearThreshold}`);
                    return { action: 'RESOLVE', value: valMin };
                }
                return { action: 'UPDATE_PEAK', type: 'min', value: valMin };
            }
        }
    }

    return null;
};

/**
 * Run evaluation for all parameters.
 */
function evaluateAll(normalizedThresholds, extractedMetrics, activeSessionsMap = {}) {
    const results = {};

    for (const [param, config] of Object.entries(normalizedThresholds)) {
        if (!config.enabled) continue;

        const metric = extractedMetrics[param];
        if (!metric) continue;

        const activeSession = activeSessionsMap[`${param}_max`] ||
            activeSessionsMap[`${param}_min`] ||
            activeSessionsMap[param] ||
            null;

        const action = evaluateMetric(metric, config, activeSession);

        if (action) {
            results[param] = action;
        }
    }

    return results;
}

module.exports = {
    normalizeThresholds,
    extractMetrics,
    evaluateMetric,
    evaluateAll,
    SUPPORTED_PARAMS,
    MAX_ONLY_PARAMS
};
