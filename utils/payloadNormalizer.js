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
    na: 'NEUTRAL_AMPERE'
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

    return normalized;
}

module.exports = {
    normalizePayload
};
