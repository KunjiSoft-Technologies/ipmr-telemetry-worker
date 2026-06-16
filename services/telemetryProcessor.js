const admin = require('firebase-admin');
const moment = require('moment');
const { getToday, whatHour } = require('../utils/timeHelpers');
const { toRange, countOverlapEvents } = require('../utils/overlapHelpers');

/**
 * Checks for replay/duplicate packets.
 * @returns {Promise<boolean>} - True if it is a duplicate and we should abort.
 */
async function checkDuplicate(database, uid, unit, unix, _unit, redis, saveUnitToCache) {
    const lastUnix = _unit.packetID?.val || 0;
    if (unix <= lastUnix) {
        // Increment /users/${uid}/units/${unit}/repeatedID by 1 in RTDB
        await database.ref(`/users/${uid}/units/${unit}/repeatedID`).set(admin.database.ServerValue.increment(1));
        // Save the updated _unit in Redis (which updates expiration/state)
        if (saveUnitToCache) {
            await saveUnitToCache(uid, unit, _unit);
        }
        return true;
    }
    // Update local _unit and write to RTDB
    _unit.packetID = _unit.packetID || {};
    _unit.packetID.val = unix;
    await database.ref(`/users/${uid}/units/${unit}/packetID`).set(unix);
    return false;
}

/**
 * Performs packet sequencing verification.
 */
async function verifySequence(database, uid, unit, payload, _unit) {
    const packet_id_new = payload.packet_id;
    if (packet_id_new === undefined || packet_id_new === null) return;

    let expectedPacketID = (_unit.packetOrder || 0) + 1;
    if (_unit.packetOrder === undefined || _unit.packetOrder === null) {
        expectedPacketID = packet_id_new;
    }

    if (packet_id_new <= expectedPacketID) {
        expectedPacketID = packet_id_new;
    }

    if (packet_id_new !== expectedPacketID) {
        // Log error to /users/${uid}/packetIDErrors/units/${unit}/
        await database.ref(`/users/${uid}/packetIDErrors/units/${unit}/`).push({
            expected: expectedPacketID,
            got: packet_id_new,
            time: moment().format('YYYY-MM-DD HH:mm:ss')
        });
    }

    _unit.packetOrder = expectedPacketID;
    await database.ref(`/users/${uid}/units/${unit}/packetOrder`).set(expectedPacketID);
}

/**
 * Tracks and saves temperature.
 */
async function trackTemperature(database, uid, unit, payload) {
    const temperature = payload.analog_values?.temperature?.now !== undefined
        ? payload.analog_values.temperature.now
        : payload.temp;

    if (temperature !== undefined && temperature !== null) {
        await database.ref(`/users/${uid}/units/${unit}/temperature`).set(temperature);
        return temperature;
    }
    return null;
}

const ALLOWED_HOURLY_METRICS = {
    // For individual phases R, S, T
    phase: {
        "VOLTAGE": ["min", "max", "avg"],
        "L_L_VOLTAGE": ["min", "max", "avg"],
        "AMPERE": ["max", "avg"],
        "POWER": ["max", "avg"]
    },
    // For SUM phase
    SUM: {
        "VOLTAGE": ["min", "max", "avg"],
        "L_L_VOLTAGE": ["min", "max", "avg"],
        "FREQUENCY": ["min", "max", "avg"],
        "POWER_FACTOR": ["max", "avg"],
        "CURRENT_THD": ["max", "avg"],
        "VOLTAGE_THD": ["max", "avg"],
        "AMPERE": ["max", "avg"],
        "APPARENT_POWER": ["max", "avg"],
        "REACTIVE_POWER": ["max", "avg"],
        "POWER": ["max", "avg"],
        "NEUTRAL_AMPERE": ["max", "avg"]
    }
};

async function processPhaseValues(database, uid, unit, type, id, phase_values, unix, _unit) {
    const today = getToday(uid, unix, _unit);
    const hour = whatHour(uid, unix, _unit);
    const phases = ["R", "S", "T", "SUM"];
    const transactionPromises = [];

    for (const phase of phases) {
        const phaseData = phase_values?.[phase];
        if (!phaseData) continue;
        const isAccumulatorKey = (key) => /^SUM_(VAH|WH_(Import|Export|Total)|VarH_(Ind|Cap|Total))(?:_Long)?$/.test(key);

        if (phase === "SUM") {
            const accumulatorPayload = {};
            for (const [param, rawValue] of Object.entries(phaseData)) {
                if (!isAccumulatorKey(param)) continue;
                const incomingValue = typeof rawValue === "object" && rawValue !== null ? rawValue.now : rawValue;
                if (incomingValue === undefined || incomingValue === null) continue;
                accumulatorPayload[param] = incomingValue;
            }

            if (Object.keys(accumulatorPayload).length > 0) {
                for (const [param, rawIncomingValue] of Object.entries(accumulatorPayload)) {
                    const incomingValue = Number(rawIncomingValue);
                    if (!Number.isFinite(incomingValue)) continue;

                    transactionPromises.push(
                        database.ref(`users/${uid}/reports/${type}/${id}/accumulators/${param}`).transaction((current) => {
                            const currentValue = Number(current);
                            const dbValue = Number.isFinite(currentValue) ? currentValue : 0;
                            const incrementBy = dbValue < incomingValue ? (incomingValue - dbValue) : incomingValue;
                            return dbValue + incrementBy;
                        })
                    );
                }
            }
        }

        for (const [param, pv] of Object.entries(phaseData)) {
            if (phase === "SUM" && isAccumulatorKey(param)) continue;

            const incomingMin = pv?.min !== undefined && pv?.min !== null ? Number(pv.min) : (pv?.now !== undefined ? Number(pv.now) : null);
            const incomingMax = pv?.max !== undefined && pv?.max !== null ? Number(pv.max) : (pv?.now !== undefined ? Number(pv.now) : null);
            const incomingAvg = pv?.avg !== undefined && pv?.avg !== null ? Number(pv.avg) : (pv?.now !== undefined ? Number(pv.now) : null);

            // 1. Process Daily Report (retain everything, auto-detect stats keys)
            const dailyStatsKeys = pv?.min !== undefined && pv?.min !== null ? ["min", "max", "avg"] : ["max", "avg"];
            const hasDailyMin = dailyStatsKeys.includes("min") && incomingMin !== null && Number.isFinite(incomingMin);
            const hasDailyMax = dailyStatsKeys.includes("max") && incomingMax !== null && Number.isFinite(incomingMax);
            const hasDailyAvg = dailyStatsKeys.includes("avg") && incomingAvg !== null && Number.isFinite(incomingAvg);

            if (hasDailyMin || hasDailyMax || hasDailyAvg) {
                const txFnDaily = (current) => {
                    const nextVal = {};
                    if (current === null) {
                        if (hasDailyMin) nextVal.min = incomingMin;
                        if (hasDailyMax) nextVal.max = incomingMax;
                        if (hasDailyAvg) {
                            nextVal.avg = incomingAvg;
                            nextVal.avg_sum = incomingAvg;
                            nextVal.avg_count = 1;
                        }
                        return nextVal;
                    }
                    if (hasDailyMin) nextVal.min = Math.min(current.min ?? incomingMin, incomingMin);
                    if (hasDailyMax) nextVal.max = Math.max(current.max ?? incomingMax, incomingMax);
                    if (hasDailyAvg) {
                        const newAvgSum = (current.avg_sum ?? 0) + incomingAvg;
                        const newAvgCount = (current.avg_count ?? 0) + 1;
                        nextVal.avg = newAvgSum / newAvgCount;
                        nextVal.avg_sum = newAvgSum;
                        nextVal.avg_count = newAvgCount;
                    }
                    return nextVal;
                };

                transactionPromises.push(
                    database.ref(`users/${uid}/reports/${type}/${id}/daily/${today}/phase_values/${phase}/${param}`).transaction(txFnDaily)
                );
            }

            // 2. Process Hourly Report (restricted keys and specific stats)
            const allowedHourlyStats = phase === "SUM" ? ALLOWED_HOURLY_METRICS.SUM[param] : ALLOWED_HOURLY_METRICS.phase[param];
            if (allowedHourlyStats) {
                const hasHourlyMin = allowedHourlyStats.includes("min") && incomingMin !== null && Number.isFinite(incomingMin);
                const hasHourlyMax = allowedHourlyStats.includes("max") && incomingMax !== null && Number.isFinite(incomingMax);
                const hasHourlyAvg = allowedHourlyStats.includes("avg") && incomingAvg !== null && Number.isFinite(incomingAvg);

                if (hasHourlyMin || hasHourlyMax || hasHourlyAvg) {
                    const txFnHouly = (current) => {
                        const nextVal = {};
                        if (current === null) {
                            if (hasHourlyMin) nextVal.min = incomingMin;
                            if (hasHourlyMax) nextVal.max = incomingMax;
                            if (hasHourlyAvg) {
                                nextVal.avg = incomingAvg;
                                nextVal.avg_sum = incomingAvg;
                                nextVal.avg_count = 1;
                            }
                            return nextVal;
                        }
                        if (hasHourlyMin) nextVal.min = Math.min(current.min ?? incomingMin, incomingMin);
                        if (hasHourlyMax) nextVal.max = Math.max(current.max ?? incomingMax, incomingMax);
                        if (hasHourlyAvg) {
                            const newAvgSum = (current.avg_sum ?? 0) + incomingAvg;
                            const newAvgCount = (current.avg_count ?? 0) + 1;
                            nextVal.avg = newAvgSum / newAvgCount;
                            nextVal.avg_sum = newAvgSum;
                            nextVal.avg_count = newAvgCount;
                        }
                        return nextVal;
                    };

                    transactionPromises.push(
                        database.ref(`users/${uid}/reports/${type}/${id}/new_hourly/${today}/${hour}/phase_values/${phase}/${param}`).transaction(txFnHouly)
                    );
                }
            }
        }
    }
    await Promise.all(transactionPromises);
}

async function processDigitalValues(database, uid, unit, type, id, digital_values, unix, _unit) {
    const today = getToday(uid, unix, _unit);
    const hour = whatHour(uid, unix, _unit);
    const ioTransactionPromises = [];
    const connectionInputs = _unit.connection?.inputs || {};
    const productionSignal = typeof connectionInputs.production === "string" ? connectionInputs.production : null;
    let productionCountIncrement = 0;

    for (const [signal, logs] of Object.entries(digital_values || {})) {
        if (!Array.isArray(logs)) continue;
        const validLogs = logs.filter((entry) => toRange(entry) !== null);

        let countToIncrement = validLogs.length;
        if (productionSignal && signal === productionSignal) {
            const seriesSignal = connectionInputs?.[signal]?.series;
            if (typeof seriesSignal === "string" && Array.isArray(digital_values?.[seriesSignal])) {
                countToIncrement = countOverlapEvents(validLogs, digital_values[seriesSignal]);
            }
            productionCountIncrement = countToIncrement;
        }

        const txFn = (current) => {
            const existing = Array.isArray(current) ? current : [];
            const map = new Map();
            for (const entry of existing) {
                if (!entry || typeof entry !== "object") continue;
                const key = `${entry.high ?? ""}-${entry.low ?? ""}`;
                map.set(key, entry);
            }
            for (const entry of logs) {
                if (!entry || typeof entry !== "object") continue;
                const key = `${entry.high ?? ""}-${entry.low ?? ""}`;
                map.set(key, entry);
            }
            return Array.from(map.values());
        };

        ioTransactionPromises.push(
            database.ref(`users/${uid}/reports/${type}/${id}/daily/${today}/digital_values/${signal}`).transaction(txFn),
            database.ref(`users/${uid}/reports/${type}/${id}/new_hourly/${today}/${hour}/digital_values/${signal}`).transaction(txFn)
        );
    }

    ioTransactionPromises.push(
        database.ref(`users/${uid}/reports/${type}/${id}/daily/${today}/digital_values/total`).set(admin.database.ServerValue.increment(productionCountIncrement)),
        database.ref(`users/${uid}/reports/${type}/${id}/new_hourly/${today}/${hour}/digital_values/total`).set(admin.database.ServerValue.increment(productionCountIncrement))
    );

    await Promise.all(ioTransactionPromises);
}

module.exports = {
    checkDuplicate,
    verifySequence,
    trackTemperature,
    processPhaseValues,
    processDigitalValues
};
