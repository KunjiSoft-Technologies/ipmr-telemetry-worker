const ROOT_KEYS = {
    pv: 'phase_values',
    av: 'analog_values',
    dv: 'digital_values',
    pid: 'packet_id',
    rtc: 'using_external_rtc'
};

const PHASE_KEYS = {
    v: 'VOLTAGE',
    llv: 'L_L_VOLTAGE',
    a: 'AMPERE',
    p: 'POWER',
    pf: 'POWER_FACTOR',
    f: 'FREQUENCY',
    ap: 'APPARENT_POWER',
    rp: 'REACTIVE_POWER',
    thd_a: 'CURRENT_THD',
    thd_v: 'VOLTAGE_THD',
    thd_ll: 'L_L_VOLTAGE_THD',
    cthd: 'CURRENT_THD',
    vthd: 'VOLTAGE_THD',
    llvthd: 'L_L_VOLTAGE_THD',
    na: 'NEUTRAL_AMPERE',
    vah: 'SUM_VAH',
    wh_i: 'SUM_WH_Import',
    wh_e: 'SUM_WH_Export',
    wh_t: 'SUM_WH_Total',
    varh_i: 'SUM_VarH_Ind',
    varh_c: 'SUM_VarH_Cap',
    varh_t: 'SUM_VarH_Total',
    vah_l: 'SUM_VAH_Long',
    wh_i_l: 'SUM_WH_Import_Long',
    wh_e_l: 'SUM_WH_Export_Long',
    wh_t_l: 'SUM_WH_Total_Long',
    varh_i_l: 'SUM_VarH_Ind_Long',
    varh_c_l: 'SUM_VarH_Cap_Long',
    varh_t_l: 'SUM_VarH_Total_Long'
};

const STATS_KEYS = {
    n: 'min',
    x: 'max',
    g: 'avg',
    w: 'now'
};

const ANALOG_KEYS = {
    temp: 'temperature',
    t: 'temperature',
    temp_status: 'temperature_status',
    ts: 'temperature_status',
    supply_v: 'supply_voltage',
    sv: 'supply_voltage',
    bat_v: 'battery_voltage',
    bv: 'battery_voltage',
    bat_state: 'battery_state',
    bs: 'battery_state'
};

/**
 * Inflates a minified IoT payload back to its standard/expanded key format.
 * Works recursively for phase values, analog values, and aggregation sub-objects.
 * Falls back to original keys if they are already in standard format.
 * 
 * @param {Object} raw - Minified or standard telemetry payload
 * @returns {Object} - Standard/expanded telemetry payload
 */
function normalizePayload(raw) {
    if (!raw || typeof raw !== 'object') return raw;

    const normalized = {};

    // Map top-level keys
    for (const [key, val] of Object.entries(raw)) {
        const standardKey = ROOT_KEYS[key] || key;
        normalized[standardKey] = val;
    }

    // Normalize phase_values
    if (normalized.phase_values && typeof normalized.phase_values === 'object') {
        const pv = {};
        for (const [phase, phaseData] of Object.entries(normalized.phase_values)) {
            if (!phaseData || typeof phaseData !== 'object') {
                pv[phase] = phaseData;
                continue;
            }

            const pData = {};
            for (const [param, pvObj] of Object.entries(phaseData)) {
                const standardParam = PHASE_KEYS[param] || param;
                
                if (pvObj && typeof pvObj === 'object') {
                    const mappedObj = {};
                    for (const [stat, value] of Object.entries(pvObj)) {
                        const standardStat = STATS_KEYS[stat] || stat;
                        mappedObj[standardStat] = value;
                    }
                    pData[standardParam] = mappedObj;
                } else {
                    pData[standardParam] = pvObj;
                }
            }
            pv[phase] = pData;
        }
        normalized.phase_values = pv;
    }

    // Normalize analog_values
    if (normalized.analog_values && typeof normalized.analog_values === 'object') {
        const av = {};
        for (const [key, val] of Object.entries(normalized.analog_values)) {
            const standardKey = ANALOG_KEYS[key] || key;
            if (val && typeof val === 'object') {
                const mappedObj = {};
                for (const [stat, value] of Object.entries(val)) {
                    const standardStat = STATS_KEYS[stat] || stat;
                    mappedObj[standardStat] = value;
                }
                av[standardKey] = mappedObj;
            } else {
                av[standardKey] = val;
            }
        }
        normalized.analog_values = av;
    }

    // Normalize digital_values
    if (normalized.digital_values && typeof normalized.digital_values === 'object') {
        const dv = {};
        for (const [signal, signalData] of Object.entries(normalized.digital_values)) {
            let rawLogs = [];
            if (Array.isArray(signalData)) {
                rawLogs = signalData;
            } else if (signalData && typeof signalData === 'object') {
                rawLogs = signalData.v || signalData.values || [];
            }

            if (Array.isArray(rawLogs)) {
                dv[signal] = rawLogs.map(entry => {
                    if (entry && typeof entry === 'object') {
                        // Object entry: { h, l } or { high, low }
                        return {
                            high: entry.h !== undefined ? entry.h : (entry.high !== undefined ? entry.high : null),
                            low: entry.l !== undefined ? entry.l : (entry.low !== undefined ? entry.low : null)
                        };
                    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
                        // Plain timestamp: treat as a pulse at that time
                        return { high: entry, low: entry };
                    }
                    return null;
                }).filter(entry => entry !== null && entry.high !== null);
            } else {
                dv[signal] = [];
            }
        }
        normalized.digital_values = dv;
    }

    return normalized;
}

module.exports = {
    normalizePayload
};
