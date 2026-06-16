const admin = require('firebase-admin');
const moment = require('moment');
const { getToday, whatHour, secToTime } = require('../utils/timeHelpers');
const { toRange, countOverlapEvents } = require('../utils/overlapHelpers');

const increment = (value) => admin.database.ServerValue.increment(isNaN(value) ? 0 : value);

const isSameObject = (obj1, obj2) => {
    if (typeof obj1 !== 'object' || typeof obj2 !== 'object' || obj1 === null || obj2 === null) {
        return obj1 === obj2;
    }
    for (let key in obj1) {
        if (obj1.hasOwnProperty(key)) {
            if (!obj2.hasOwnProperty(key)) return false;
            if (typeof obj1[key] === 'object') {
                if (!isSameObject(obj1[key], obj2[key])) return false;
            } else if (obj1[key] !== obj2[key]) {
                return false;
            }
        }
    }
    return true;
};

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

                // --- Active Energy Consumption delta tracking ---
                const activeEnergyKeys = ['SUM_WH_Total', 'SUM_WH_Import', 'SUM_WH_Total_Long', 'SUM_WH_Import_Long'];
                const activeEnergyKey = activeEnergyKeys.find(k => accumulatorPayload[k] !== undefined);
                if (activeEnergyKey) {
                    const incomingValue = Number(accumulatorPayload[activeEnergyKey]);
                    if (Number.isFinite(incomingValue)) {
                        if (!_unit.lastAccumulators) _unit.lastAccumulators = {};
                        const prevValue = Number(_unit.lastAccumulators[activeEnergyKey]) || 0;
                        let incrementBy = 0;
                        if (prevValue > 0) {
                            incrementBy = incomingValue > prevValue ? (incomingValue - prevValue) : 0;
                        }
                        _unit.lastAccumulators[activeEnergyKey] = incomingValue;

                        // Save updated lastAccumulators in background RTDB
                        transactionPromises.push(
                            database.ref(`users/${uid}/units/${unit}/lastAccumulators`).set(_unit.lastAccumulators)
                        );

                        const electricity_consumption = incrementBy / 1000; // Wh to kWh
                        if (electricity_consumption > 0) {
                            transactionPromises.push(
                                countElectricity(database, id, electricity_consumption, 0, uid, unit, unix, _unit, type)
                            );
                        }
                    }
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

    if (type === 'machines' && productionCountIncrement > 0) {
        ioTransactionPromises.push(
            countProduction(database, id, productionCountIncrement, 0, uid, unit, unix, _unit)
        );
    }

    await Promise.all(ioTransactionPromises);
}

async function countProduction(database, name, value, time, uid, unit, unix, _unit) {
    value = value || 0;
    value = Number(value.toFixed(0));

    const machineObj = _unit.machines?.[name];
    if (!machineObj || machineObj.title === undefined) return null;

    const production_meters = machineObj.pulse_width ? (value || 0) * (machineObj.pulse_width || 1) : null;
    let production_meters_speed = null;
    let rotary_rpm = null;
    if (machineObj.pulse_width) {
        if (time && production_meters) {
            production_meters_speed = time / production_meters;
            rotary_rpm = ((value / time) * 60) / 360;
        }
        if (production_meters_speed === Infinity || isNaN(production_meters_speed)) production_meters_speed = 0;
        value = 0;
    }

    const isMultiComponent = !!machineObj.multi_component;
    const cavities = Number(machineObj.installedMold === undefined ? machineObj.cavities : machineObj.installedMold.cavities);
    let product_weight = 0;
    if (machineObj.installedMold === undefined) {
        product_weight = Number(machineObj.product_weight) || 0;
    } else {
        if (Array.isArray(machineObj.installedMold.materials)) {
            for (const material of machineObj.installedMold.materials) {
                product_weight += Number(material.weight) || 0;
            }
        }
    }

    const production = value * cavities;
    const material_consumption = isMultiComponent 
        ? production * (product_weight + Number(machineObj.product_weight_2 || 0)) 
        : (machineObj.pulse_width ? production_meters : production) * product_weight;

    let ontime = machineObj.machine_status ? time : 0;
    let offtime = machineObj.machine_status ? 0 : time;
    const today = getToday(uid, unix, _unit);

    const stats = {
        production: increment(production),
        shots: increment(value),
        production_meters: increment(production_meters || 0),
        material_usage: increment(material_consumption),
        electricity_usage: increment(0),
        ontime: increment(ontime),
        offtime: increment(offtime)
    };

    const details = {};
    machineObj.mold_name = machineObj.mold_name || "NA";
    if (machineObj.installedMold === undefined) {
        details.cavities = machineObj.cavities || 0;
        details.product = machineObj.product || "NA";
        details.isUniversal = !!machineObj.isUniversal;
        details.product_color = machineObj.product_color || "NA";
        details.materials = [{
            name: machineObj.material || "NA",
            weight: machineObj.product_weight || 0
        }];
        details.material = machineObj.material || "NA";
        details.product_weight = machineObj.product_weight || 0;
        if (isMultiComponent) {
            details.multi_component = true;
            details.material_2 = machineObj.material_2 || "NA";
            details.product_weight_2 = machineObj.product_weight_2 || 0;
            details.materials.push({
                name: machineObj.material_2 || "NA",
                weight: machineObj.product_weight_2 || 0
            });
        }
    } else {
        machineObj.mold_name = machineObj.installedMold.name || "NA";
        details.cavities = machineObj.installedMold.cavities || 0;
        details.isUniversal = !!machineObj.installedMold.isUniversal;
        details.product = machineObj.installedMold.productName || "NA";
        details.product_color = machineObj.installedMold.productColor || "NA";
        details.materials = machineObj.installedMold.materials || [];
        if (details.materials.length > 0) {
            details.material = details.materials[0].name || "NA";
            details.product_weight = details.materials[0].weight || 0;
        } else {
            details.material = "NA";
            details.product_weight = 0;
        }
    }

    const breakdown = {};
    for (const material of details.materials) {
        if (material && material.name) {
            breakdown[material.name] = increment(Number(material.weight || 0) * (machineObj.pulse_width ? production_meters : production));
        }
    }

    try {
        const mold = machineObj.mold_name;
        if (mold) {
            const hour = String(whatHour(uid, unix, _unit)).padStart(2, "0");
            const date = getToday(uid, unix, _unit);
            const start = secToTime(Number(_unit.info?.shift_a_start || 0) + ((Number(hour) - 1) * 3600));
            const end = secToTime(Number(_unit.info?.shift_a_start || 0) + (Number(hour) * 3600));
            const timeStr = `${start}-${end}`;
            let hasTarget = false;
            let hourlyTarget = 0;

            await database.ref(`users/${uid}/production-targets/active/${name}/${mold}/target`).transaction((target) => {
                if (target !== null) {
                    hasTarget = true;
                    hourlyTarget = target.hourlyTarget || 0;
                    target.current += production;
                    const percentage = (target.current / target.total) * 100;
                    if (percentage >= 50) target.milestone = 50;
                    if (percentage >= 75) target.milestone = 75;
                    if (percentage >= 100) target.milestone = 100;
                    if (target.current >= target.total) target.completed = true;
                    if (target?.monitorDowntime) machineObj["monitor-downtime"] = percentage < 100;
                    if (target?.due) {
                        const dueMissed = unix > moment(target.due).unix();
                        if (dueMissed && !target.dueMissed) target.dueMissed = dueMissed;
                    }
                    if (!target.startedAt) target.startedAt = admin.database.ServerValue.TIMESTAMP;
                    return target;
                } else return null;
            });

            if (hasTarget) {
                const date = getToday(uid, unix, _unit);
                const month = moment(date).format("YYYY-MM");
                try {
                    await Promise.all([
                        database.ref(`users/${uid}/production-targets/active/${name}/${mold}/hours/${date}-${hour}`).transaction((data) => {
                            if (data === null) {
                                return {
                                    production,
                                    ontime,
                                    downtime: offtime,
                                    time: timeStr
                                };
                            } else {
                                return {
                                    production: data.production + production,
                                    ontime: data.ontime + ontime,
                                    downtime: (data.downtime || 0) + offtime || 0,
                                    time: timeStr
                                };
                            }
                        }),
                        database.ref(`users/${uid}/production-targets/statistics/${month}/machines/${name}/${mold}`).update({
                            current: increment(production),
                            ontime: increment(ontime),
                            downtime: increment(offtime),
                        }),
                        database.ref(`users/${uid}/production-targets/statistics/${month}/days/${date}/${name}/${mold}`).set(increment(production)),
                    ]);
                } catch (err) {
                    console.error("ERROR IN production target update: " + err);
                }
            }
        }
    } catch (err) {
        console.log("ERROR IN target: " + err);
    }

    const promises = [
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total`).update(stats),
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/material_usage_breakdown`).update(breakdown),
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/molds/${machineObj.mold_name || null}/stats`).update(stats),
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/molds/${machineObj.mold_name || null}/details`).set(details),
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/operators/A/${machineObj.operator_a || "NA"}`).set(true),
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/operators/B/${machineObj.operator_b || "NA"}`).set(true),
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/operators/C/${machineObj.operator_c || "NA"}`).set(true),
    ];
    if (value) promises.push(database.ref(`users/${uid}/machines/${name}/last_shot`).set(moment().unix()));
    if (details.isUniversal) promises.push(database.ref(`users/${uid}/reports/UNIVERSAL_MOLDS/${today}/${name}`).set(true));
    await Promise.all(promises);

    // Hourly report logic
    if (_unit.hourlyReportData === undefined) {
        _unit.hourlyReportData = {};
    }
    if (_unit.hourlyReportData[name] === undefined) {
        const snap = await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}`).limitToLast(1).once("value");
        const hourlyData = snap.val();
        if (hourlyData !== null) {
            _unit.hourlyReportData[name] = {
                key: Object.keys(hourlyData)[0],
                values: Object.values(hourlyData)[0]
            };
        } else {
            _unit.hourlyReportData[name] = null;
        }
    }

    const datetime = moment.unix(unix);
    let sec = (datetime.hours() * 3600) + datetime.minutes() * 60 + datetime.seconds();
    let hoursx;
    if (sec <= (+(_unit.info?.shift_a_start || 0) + 59)) {
        hoursx = 24 + datetime.hours();
    } else {
        hoursx = datetime.hours();
    }
    const seconds = (hoursx * 3600) + datetime.minutes() * 60 + datetime.seconds();

    let operator = "NA";
    const shifts = +(_unit.info?.shifts || 1);
    if (shifts === 1) {
        operator = machineObj.operator_a;
    } else if (shifts === 2) {
        if (+(_unit.info?.shift_a_start || 0) <= seconds && seconds <= +(_unit.info?.shift_b_start || 0)) {
            operator = machineObj.operator_a;
        } else {
            operator = machineObj.operator_b;
        }
    } else if (shifts === 3) {
        if (+(_unit.info?.shift_a_start || 0) <= seconds && seconds <= +(_unit.info?.shift_b_start || 0)) {
            operator = machineObj.operator_a;
        } else if (+(_unit.info?.shift_b_start || 0) <= seconds && seconds <= +(_unit.info?.shift_c_start || 0)) {
            operator = machineObj.operator_b;
        } else {
            operator = machineObj.operator_c;
        }
    }

    const hourDetails = {
        status: machineObj.machine_status,
        operator: operator || "NA",
        mold_name: machineObj.mold_name || null,
        ...details
    };

    if (_unit.hourlyReportData[name] !== null) {
        let key = _unit.hourlyReportData[name].key;
        const data = _unit.hourlyReportData[name].values;
        const hasNotChanged = isSameObject(hourDetails, data);
        if (data.from <= seconds && seconds <= data.time) {
            if (hasNotChanged) {
                await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${key}`).update({
                    production: increment(production),
                    shots: increment(value),
                    production_meters: increment(production_meters || 0),
                    material_usage: increment(material_consumption),
                    electricity_usage: increment(0),
                    ontime: increment(ontime),
                    offtime: increment(offtime),
                });
            } else {
                await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${key}`).update({
                    time: seconds
                });
                key = Number(key) + 1;
                _unit.hourlyReportData[name] = {
                    key,
                    values: {
                        from: seconds,
                        time: data.time,
                        ...hourDetails
                    }
                };
                await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${key}`).set({
                    production: increment(production),
                    shots: increment(value),
                    production_meters: increment(production_meters || 0),
                    material_usage: increment(material_consumption),
                    electricity_usage: increment(0),
                    ontime: increment(ontime),
                    offtime: increment(offtime),
                    from: seconds,
                    time: data.time,
                    ...hourDetails
                });
            }
        } else {
            key = Number(key) + 1;
            ontime = ontime > 3600 ? 3600 : ontime;
            offtime = offtime > 3600 ? 3600 : offtime;
            const shiftStartMinutes = (Number(_unit.info?.shift_a_start || 0) % 3600) / 60;
            const shiftStartHours = Math.floor(Number(_unit.info?.shift_a_start || 0) / 3600);
            let timeVal = ((((hoursx - 24 === shiftStartHours || datetime.minutes() < shiftStartMinutes) ? hoursx : hoursx + 1)) * 3600 + shiftStartMinutes * 60) + 59;
            _unit.hourlyReportData[name] = {
                key,
                values: {
                    from: seconds,
                    time: timeVal,
                    ...hourDetails
                }
            };
            await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${key}`).set({
                production: increment(production),
                shots: increment(value),
                production_meters: increment(production_meters || 0),
                material_usage: increment(material_consumption),
                electricity_usage: increment(0),
                ontime: increment(ontime),
                offtime: increment(offtime),
                from: seconds,
                time: timeVal,
                ...hourDetails
            });
        }
    } else {
        let key = 0;
        const shiftStartMinutes = (Number(_unit.info?.shift_a_start || 0) % 3600) / 60;
        const shiftStartHours = Math.floor(Number(_unit.info?.shift_a_start || 0) / 3600);
        let timeVal = ((((hoursx - 24 === shiftStartHours || datetime.minutes() < shiftStartMinutes) ? hoursx : hoursx + 1)) * 3600 + shiftStartMinutes * 60) + 59;
        _unit.hourlyReportData[name] = {
            key,
            values: {
                from: seconds,
                time: timeVal,
                ...hourDetails
            }
        };
        await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${key}`).set({
            production: increment(production),
            shots: increment(value),
            production_meters: increment(production_meters || 0),
            material_usage: increment(material_consumption),
            electricity_usage: increment(0),
            ontime: increment(ontime),
            offtime: increment(offtime),
            from: seconds,
            time: timeVal,
            ...hourDetails
        });
    }

    try {
        await Promise.all([
            database.ref(`users/${uid}/machines/${name}/updated`).set(moment().format('YYYY-MM-DD HH:mm:ss')),
            database.ref(`users/${uid}/machines/${name}/production_meters_speed`).transaction(speed => {
                if (speed === null) return {
                    current: +(production_meters_speed || 0).toFixed(2),
                    previous: +(production_meters_speed || 0).toFixed(2)
                };
                return {
                    current: +(production_meters_speed || 0).toFixed(2),
                    previous: +speed.current.toFixed(2) || 0
                };
            }),
            database.ref(`users/${uid}/machines/${name}/rotary_rpm`).transaction(speed => {
                if (speed === null) return {
                    current: +(rotary_rpm || 0).toFixed(2),
                    previous: +(rotary_rpm || 0).toFixed(2)
                };
                return {
                    current: +(rotary_rpm || 0).toFixed(2),
                    previous: +speed.current.toFixed(2) || 0
                };
            })
        ]);
    } catch (err) {
        console.error("ERROR IN updating machine metrics: " + err);
    }

    const hour = whatHour(uid, unix, _unit);
    await database.ref(`users/${uid}/reports/factory/hourly/${today}/${hour}/machines/${name}`).update({
        production: increment(production),
        shots: increment(value),
        production_meters: increment(production_meters || 0),
        material_usage: increment(material_consumption),
        electricity_usage: increment(0),
    });

    const shiftsData = {
        shifts: _unit.info?.shifts || 1,
        shift_a_start: _unit.info?.shift_a_start || 0,
        shift_b_start: _unit.info?.shift_b_start || 0,
        shift_c_start: _unit.info?.shift_c_start || 0,
        supervisor_a: _unit.info?.supervisor_a || "NA",
        supervisor_b: _unit.info?.supervisor_b || "NA",
        supervisor_c: _unit.info?.supervisor_c || "NA",
        shift_a_hours: _unit.info?.shift_a_hours || 8,
        shift_b_hours: _unit.info?.shift_b_hours || 8,
        shift_c_hours: _unit.info?.shift_c_hours || 8,
    };

    const isSubFactoryNaN = isNaN(Number(_unit.subFactory));
    await database.ref(`users/${uid}/reports/factory/daily/${today}`).update({
        production: increment(production),
        shots: increment(value),
        production_meters: increment(production_meters || 0),
        material_usage: increment(material_consumption),
        electricity_usage: increment(0),
        ...(isSubFactoryNaN ? shiftsData : {})
    });

    if (!isSubFactoryNaN) {
        await database.ref(`users/${uid}/reports/factory/daily/${today}/factories/${_unit.subFactory}`).update(shiftsData);
    }
}

async function countElectricity(database, name, electricity_consumption, time, uid, unit, unix, _unit, type) {
    const isEQ = type === 'equipment' || (name.split('_')[1] !== undefined && name.split('_')[1].split('eq')[1] !== undefined);
    const today = getToday(uid, unix, _unit);
    const hour = whatHour(uid, unix, _unit);

    const shiftsData = {
        shifts: _unit.info?.shifts || 1,
        shift_a_start: _unit.info?.shift_a_start || 0,
        shift_b_start: _unit.info?.shift_b_start || 0,
        shift_c_start: _unit.info?.shift_c_start || 0,
        supervisor_a: _unit.info?.supervisor_a || "NA",
        supervisor_b: _unit.info?.supervisor_b || "NA",
        supervisor_c: _unit.info?.supervisor_c || "NA",
        shift_a_hours: _unit.info?.shift_a_hours || 8,
        shift_b_hours: _unit.info?.shift_b_hours || 8,
        shift_c_hours: _unit.info?.shift_c_hours || 8,
    };

    if (isEQ) {
        const eqObj = _unit.equipments?.[name];
        if (!eqObj) return;

        const division = Number(eqObj.division) || 1;
        const time_in_h = time / 3600;
        const realtime_kw_mn = electricity_consumption / time_in_h;
        const realtime_kw = isNaN(realtime_kw_mn) || !isFinite(realtime_kw_mn) ? 0 : +realtime_kw_mn.toFixed(2);
        const status = eqObj.status;
        const ontime = status ? time : 0;

        const stats = {
            electricity_usage: increment(electricity_consumption),
            ontime: increment(ontime),
            name: eqObj.name || "NA",
            division: division,
        };

        await database.ref(`users/${uid}/reports/equipments/${name}/daily/${today}/`).update(stats);

        if (_unit.hourlyReportData === undefined) _unit.hourlyReportData = {};
        if (_unit.hourlyReportData[name] === undefined) {
            const snap = await database.ref(`users/${uid}/reports/equipments/${name}/hourly/${today}`).limitToLast(1).once("value");
            const hourlyData = snap.val();
            if (hourlyData !== null) {
                _unit.hourlyReportData[name] = {
                    key: Object.keys(hourlyData)[0],
                    values: Object.values(hourlyData)[0]
                };
            } else {
                _unit.hourlyReportData[name] = null;
            }
        }

        const datetime = moment.unix(unix);
        let sec = (datetime.hours() * 3600) + datetime.minutes() * 60 + datetime.seconds();
        let hoursx;
        if (sec <= (+(_unit.info?.shift_a_start || 0) + 59)) {
            hoursx = 24 + datetime.hours();
        } else {
            hoursx = datetime.hours();
        }
        const seconds = (hoursx * 3600) + datetime.minutes() * 60 + datetime.seconds();

        if (_unit.hourlyReportData[name] !== null) {
            let key = _unit.hourlyReportData[name].key;
            const data = _unit.hourlyReportData[name].values;
            if (data.from <= seconds && seconds <= data.time) {
                const hstats = {
                    electricity_usage: increment(electricity_consumption),
                    ontime: increment(ontime)
                };
                await database.ref(`users/${uid}/reports/equipments/${name}/hourly/${today}/${key}`).update(hstats);
            } else {
                key = Number(key) + 1;
                const shiftStartMinutes = (Number(_unit.info?.shift_a_start || 0) % 3600) / 60;
                const shiftStartHours = Math.floor(Number(_unit.info?.shift_a_start || 0) / 3600);
                let timeVal = ((((hoursx - 24 === shiftStartHours || datetime.minutes() < shiftStartMinutes) ? hoursx : hoursx + 1)) * 3600 + shiftStartMinutes * 60) + 59;

                _unit.hourlyReportData[name] = {
                    key,
                    values: {
                        from: seconds,
                        time: timeVal,
                        status: status
                    }
                };

                const hstats = {
                    electricity_usage: increment(electricity_consumption),
                    ontime: increment(ontime),
                    from: seconds,
                    time: timeVal,
                    status: status
                };
                await database.ref(`users/${uid}/reports/equipments/${name}/hourly/${today}/${key}`).update(hstats);
            }
        } else {
            let key = 0;
            const shiftStartMinutes = (Number(_unit.info?.shift_a_start || 0) % 3600) / 60;
            const shiftStartHours = Math.floor(Number(_unit.info?.shift_a_start || 0) / 3600);
            let timeVal = ((((hoursx - 24 === shiftStartHours || datetime.minutes() < shiftStartMinutes) ? hoursx : hoursx + 1)) * 3600 + shiftStartMinutes * 60) + 59;

            _unit.hourlyReportData[name] = {
                key,
                values: {
                    from: seconds,
                    time: timeVal,
                    status: status
                }
            };

            const hstats = {
                electricity_usage: increment(electricity_consumption),
                ontime: increment(ontime),
                from: seconds,
                time: timeVal,
                status: status
            };
            await database.ref(`users/${uid}/reports/equipments/${name}/hourly/${today}/${key}`).update(hstats);
        }

        try {
            await Promise.all([
                database.ref(`users/${uid}/equipments/${name}/updated`).set(moment().format("YYYY-MM-DD HH:mm:ss")),
                database.ref(`users/${uid}/reports/factory/hourly/${today}/${hour}/equipments/${name}/electricity_usage`).set(increment(electricity_consumption)),
                database.ref(`users/${uid}/reports/factory/daily/${today}`).update({
                    electricity_usage: increment(electricity_consumption),
                    ...(isNaN(Number(_unit.subFactory)) ? shiftsData : {})
                }),
                database.ref(`users/${uid}/equipments/${name}/realtime_kw`).transaction(load => {
                    if (load === null) return {
                        current: +realtime_kw.toFixed(2),
                        previous: +realtime_kw.toFixed(2)
                    };
                    return {
                        current: +realtime_kw.toFixed(2),
                        previous: +load.current.toFixed(2) || 0
                    };
                })
            ]);
        } catch (err) {
            console.error("ERROR IN countElectricity (eq): " + err);
        }

        if (!isNaN(Number(_unit.subFactory))) {
            await database.ref(`users/${uid}/reports/factory/daily/${today}/factories/${_unit.subFactory}`).update(shiftsData);
        }
    } else {
        const machineObj = _unit.machines?.[name];
        if (!machineObj) return;

        const isMultiComponent = !!machineObj.multi_component;
        const division = Number(machineObj.division) || 1;
        const time_in_h = time / 3600;
        const realtime_kw_mn = electricity_consumption / time_in_h;
        const realtime_kw = isNaN(realtime_kw_mn) || !isFinite(realtime_kw_mn) ? 0 : +realtime_kw_mn.toFixed(2);
        time = 0; // Hardcoded in start.js

        const status = machineObj.machine_status;
        const ontime = status ? time : 0;
        const offtime = status ? 0 : time;

        const stats = {
            production: increment(0),
            shots: increment(0),
            material_usage: increment(0),
            electricity_usage: increment(electricity_consumption),
            ontime: increment(ontime),
            offtime: increment(offtime)
        };

        const details = {};
        if (machineObj.installedMold === undefined) {
            details.cavities = machineObj.cavities || 0;
            details.product = machineObj.product || "NA";
            details.isUniversal = !!machineObj.isUniversal;
            details.product_color = machineObj.product_color || "NA";
            details.materials = [{
                name: machineObj.material || "NA",
                weight: machineObj.product_weight || 0
            }];
            details.material = machineObj.material || "NA";
            details.product_weight = machineObj.product_weight || 0;
            if (isMultiComponent) {
                details.multi_component = true;
                details.material_2 = machineObj.material_2 || "NA";
                details.product_weight_2 = machineObj.product_weight_2 || 0;
                details.materials.push({
                    name: machineObj.material_2 || "NA",
                    weight: machineObj.product_weight_2 || 0
                });
            }
        } else {
            machineObj.mold_name = machineObj.installedMold.name || "NA";
            details.cavities = machineObj.installedMold.cavities || 0;
            details.isUniversal = !!machineObj.installedMold.isUniversal;
            details.product = machineObj.installedMold.productName || "NA";
            details.product_color = machineObj.installedMold.productColor || "NA";
            details.materials = machineObj.installedMold.materials || [];
            if (details.materials.length > 0) {
                details.material = details.materials[0].name || "NA";
                details.product_weight = details.materials[0].weight || 0;
            } else {
                details.material = "NA";
                details.product_weight = 0;
            }
        }

        const breakdown = {};
        for (const material of details.materials) {
            if (material && material.name) breakdown[material.name] = increment(0);
        }

        const promises = [
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total`).update(stats),
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/material_usage_breakdown`).update(breakdown),
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/molds/${machineObj.mold_name || null}/stats`).update(stats),
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/molds/${machineObj.mold_name || null}/details`).set(details),
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/operators/A/${machineObj.operator_a || "NA"}`).set(true),
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/operators/B/${machineObj.operator_b || "NA"}`).set(true),
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/operators/C/${machineObj.operator_c || "NA"}`).set(true)
        ];
        if (details.isUniversal) promises.push(database.ref(`users/${uid}/reports/UNIVERSAL_MOLDS/${today}/${name}`).set(true));
        await Promise.all(promises);

        if (_unit.hourlyReportData === undefined || _unit.hourlyReportData[name] === undefined) {
            const snap = await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}`).limitToLast(1).once("value");
            const hourlyData = snap.val();
            if (hourlyData !== null) {
                if (!_unit.hourlyReportData) _unit.hourlyReportData = {};
                _unit.hourlyReportData[name] = {
                    key: Object.keys(hourlyData)[0],
                    values: Object.values(hourlyData)[0]
                };
            } else {
                _unit.hourlyReportData[name] = null;
            }
        }

        const datetime = moment.unix(unix);
        let sec = (datetime.hours() * 3600) + datetime.minutes() * 60 + datetime.seconds();
        let hoursx;
        if (sec <= (+(_unit.info?.shift_a_start || 0) + 59)) {
            hoursx = 24 + datetime.hours();
        } else {
            hoursx = datetime.hours();
        }
        const seconds = (hoursx * 3600) + datetime.minutes() * 60 + datetime.seconds();

        let operator = "NA";
        const shifts = +(_unit.info?.shifts || 1);
        if (shifts === 1) {
            operator = machineObj.operator_a;
        } else if (shifts === 2) {
            if (+(_unit.info?.shift_a_start || 0) <= seconds && seconds <= +(_unit.info?.shift_b_start || 0)) {
                operator = machineObj.operator_a;
            } else {
                operator = machineObj.operator_b;
            }
        } else if (shifts === 3) {
            if (+(_unit.info?.shift_a_start || 0) <= seconds && seconds <= +(_unit.info?.shift_b_start || 0)) {
                operator = machineObj.operator_a;
            } else if (+(_unit.info?.shift_b_start || 0) <= seconds && seconds <= +(_unit.info?.shift_c_start || 0)) {
                operator = machineObj.operator_b;
            } else {
                operator = machineObj.operator_c;
            }
        }

        const hourDetails = {
            status: status,
            operator: operator || "NA",
            mold_name: machineObj.mold_name || null,
            ...details
        };

        if (_unit.hourlyReportData[name] !== null) {
            let key = _unit.hourlyReportData[name].key;
            const data = _unit.hourlyReportData[name].values;
            const hasNotChanged = isSameObject(hourDetails, data);
            if (data.from <= seconds && seconds <= data.time) {
                if (hasNotChanged) {
                    await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${key}`).update({
                        production: increment(0),
                        shots: increment(0),
                        material_usage: increment(0),
                        electricity_usage: increment(electricity_consumption),
                        ontime: increment(ontime),
                        offtime: increment(offtime),
                    });
                } else {
                    await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${key}/time`).set(seconds);
                    key = Number(key) + 1;
                    _unit.hourlyReportData[name] = {
                        key,
                        values: {
                            from: seconds,
                            time: data.time,
                            ...hourDetails
                        }
                    };
                    await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${key}`).set({
                        production: increment(0),
                        shots: increment(0),
                        material_usage: increment(0),
                        electricity_usage: increment(electricity_consumption),
                        ontime: increment(ontime),
                        offtime: increment(offtime),
                        from: seconds,
                        time: data.time,
                        ...hourDetails
                    });
                }
            } else {
                key = Number(key) + 1;
                ontime = ontime > 3600 ? 3600 : ontime;
                offtime = offtime > 3600 ? 3600 : offtime;
                const shiftStartMinutes = (Number(_unit.info?.shift_a_start || 0) % 3600) / 60;
                const shiftStartHours = Math.floor(Number(_unit.info?.shift_a_start || 0) / 3600);
                let timeVal = ((((hoursx - 24 === shiftStartHours || datetime.minutes() < shiftStartMinutes) ? hoursx : hoursx + 1)) * 3600 + shiftStartMinutes * 60) + 59;

                _unit.hourlyReportData[name] = {
                    key,
                    values: {
                        from: seconds,
                        time: timeVal,
                        ...hourDetails
                    }
                };

                await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${key}`).set({
                    production: increment(0),
                    shots: increment(0),
                    material_usage: increment(0),
                    electricity_usage: increment(electricity_consumption),
                    ontime: increment(ontime),
                    offtime: increment(offtime),
                    from: seconds,
                    time: timeVal,
                    ...hourDetails
                });
            }
        } else {
            let key = 0;
            const shiftStartMinutes = (Number(_unit.info?.shift_a_start || 0) % 3600) / 60;
            const shiftStartHours = Math.floor(Number(_unit.info?.shift_a_start || 0) / 3600);
            let timeVal = ((((hoursx - 24 === shiftStartHours || datetime.minutes() < shiftStartMinutes) ? hoursx : hoursx + 1)) * 3600 + shiftStartMinutes * 60) + 59;

            _unit.hourlyReportData[name] = {
                key,
                values: {
                    from: seconds,
                    time: timeVal,
                    ...hourDetails
                }
            };

            await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${key}`).set({
                production: increment(0),
                shots: increment(0),
                material_usage: increment(0),
                electricity_usage: increment(electricity_consumption),
                ontime: increment(ontime),
                offtime: increment(offtime),
                from: seconds,
                time: timeVal,
                ...hourDetails
            });
        }

        try {
            await Promise.all([
                database.ref(`users/${uid}/machines/${name}/updated`).set(moment().format('YYYY-MM-DD HH:mm:ss')),
                database.ref(`users/${uid}/reports/factory/hourly/${today}/${hour}/machines/${name}/electricity_usage`).set(increment(electricity_consumption)),
                database.ref(`users/${uid}/reports/factory/daily/${today}`).update({
                    production: increment(0),
                    shots: increment(0),
                    material_usage: increment(0),
                    electricity_usage: increment(electricity_consumption),
                    ...(isNaN(Number(_unit.subFactory)) ? shiftsData : {})
                }),
                database.ref(`users/${uid}/machines/${name}/realtime_kw`).transaction(load => {
                    if (load === null) return {
                        current: +realtime_kw.toFixed(2),
                        previous: +realtime_kw.toFixed(2)
                    };
                    return {
                        current: +realtime_kw.toFixed(2),
                        previous: +load.current.toFixed(2) || 0
                    };
                })
            ]);
        } catch (err) {
            console.error("ERROR IN countElectricity (mach): " + err);
        }

        if (!isNaN(Number(_unit.subFactory))) {
            await database.ref(`users/${uid}/reports/factory/daily/${today}/factories/${_unit.subFactory}`).update(shiftsData);
        }
    }
}

async function processValues(database, uid, unit, values, unix, _unit) {
    if (!values || typeof values !== 'object') return;

    for (const key of Object.keys(values)) {
        let address;
        let buffer;
        let value;
        try {
            address = Number(key.split('_')[0]);
            buffer = key.split('_')[1];
            value = Number(values[key]) || 0;
        } catch (err) {
            console.error(`unable to extract data from key ${key}: ${err}`);
            continue;
        }

        if (!_unit.address || !_unit.address[address] || !_unit.address[address][buffer]) {
            continue;
        }

        const target = _unit.address[address][buffer];
        if (target === "NONE") continue;

        const name = target.split('&')[0];
        const type = target.split('&')[1];

        if (type === 'production' || type === 'production_in_meter') {
            if (value > 0) {
                let names = [];
                if (name.includes('-')) names = name.split('-');
                else if (name.includes('+')) names = name.split('+');
                else names.push(name);

                for (const subName of names) {
                    await countProduction(database, subName, value, 0, uid, unit, unix, _unit);
                }
            }
        } else {
            if (value > 0) {
                let names = [];
                if (name.includes('-')) names = name.split('-');
                else if (name.includes('+')) names = name.split('+');
                else names.push(name);

                for (const subName of names) {
                    await countElectricity(database, subName, value, 0, uid, unit, unix, _unit, type);
                }
            }
        }
    }
}

async function processDirectTelemetry(database, uid, unit, connectionType, connectionId, payload, unix, _unit) {
    const promises = [];
    let updatedAccumulators = false;

    if (!_unit.lastAccumulators) {
        _unit.lastAccumulators = {};
    }

    if (payload.production !== undefined) {
        const currentProd = Number(payload.production);
        if (Number.isFinite(currentProd)) {
            const prevProd = _unit.lastAccumulators.production !== undefined ? Number(_unit.lastAccumulators.production) : null;
            let deltaProduction = 0;
            if (prevProd !== null) {
                deltaProduction = currentProd > prevProd ? (currentProd - prevProd) : 0;
            }
            _unit.lastAccumulators.production = currentProd;
            updatedAccumulators = true;

            if (connectionType === 'machines' && deltaProduction > 0) {
                promises.push(
                    countProduction(database, connectionId, deltaProduction, 0, uid, unit, unix, _unit)
                );
            }
        }
    }

    if (payload.kwhr !== undefined) {
        const currentKwhr = Number(payload.kwhr);
        if (Number.isFinite(currentKwhr)) {
            const prevKwhr = _unit.lastAccumulators.kwhr !== undefined ? Number(_unit.lastAccumulators.kwhr) : null;
            let deltaKwhr = 0;
            if (prevKwhr !== null) {
                deltaKwhr = currentKwhr > prevKwhr ? (currentKwhr - prevKwhr) : 0;
            }
            _unit.lastAccumulators.kwhr = currentKwhr;
            updatedAccumulators = true;

            if (deltaKwhr > 0) {
                promises.push(
                    countElectricity(database, connectionId, deltaKwhr, 0, uid, unit, unix, _unit, connectionType)
                );
            }
        }
    }

    if (updatedAccumulators) {
        promises.push(
            database.ref(`users/${uid}/units/${unit}/lastAccumulators`).set(_unit.lastAccumulators)
        );
    }

    if (promises.length > 0) {
        await Promise.all(promises);
    }
}

/**
 * Always called for every packet to ensure the daily/hourly report total node
 * exists and to track ontime/offtime based on machine_status.
 * Calculates elapsed time since the last packet using _unit.targets.
 */
async function touchReports(database, uid, unit, connectionType, connectionId, unix, _unit) {
    const promises = [];

    // Calculate time since last packet
    if (!_unit.targets) _unit.targets = {};
    if (!_unit.targets[connectionId]) {
        _unit.targets[connectionId] = {
            previousUnix: unix
        };
    }

    const previousUnix = _unit.targets[connectionId].previousUnix || unix;
    let time = unix - previousUnix;
    if (time < 0 || time > 3600) time = 0; // sanity cap: ignore gaps > 1 hour or negative
    _unit.targets[connectionId].previousUnix = unix;

    if (connectionType === 'machines') {
        promises.push(
            countProduction(database, connectionId, 0, time, uid, unit, unix, _unit)
        );
    }

    promises.push(
        countElectricity(database, connectionId, 0, time, uid, unit, unix, _unit, connectionType)
    );

    // Persist updated targets
    promises.push(
        database.ref(`users/${uid}/targets/${unit}/${connectionId}/previousUnix`).set(unix)
    );

    await Promise.all(promises);
}

module.exports = {
    checkDuplicate,
    verifySequence,
    trackTemperature,
    processPhaseValues,
    processDigitalValues,
    processValues,
    processDirectTelemetry,
    touchReports
};

