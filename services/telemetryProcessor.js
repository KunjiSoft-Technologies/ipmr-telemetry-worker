const admin = require('firebase-admin');
const moment = require('moment-timezone');
const { getToday, whatHour, secToTime } = require('../utils/timeHelpers');
const { toRange } = require('../utils/overlapHelpers');

/**
 * Checks for replay/duplicate packets.
 * @returns {Promise<boolean>} - True if it is a duplicate and we should abort.
 */
async function checkDuplicate(database, uid, unit, unix, _unit, redis, saveUnitToCache) {
    if (redis) {
        try {
            const lockKey = `packet_lock:${uid}:${unit}:${unix}`;
            const acquired = await redis.set(lockKey, '1', 'NX', 'EX', 30);
            if (!acquired) {
                console.log(`Lock already exists for packet ${lockKey}. Skipping as duplicate.`);
                return true;
            }
        } catch (err) {
            console.error('Error checking redis concurrent lock:', err);
        }
    }

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
    _unit.previousUnix = lastUnix;
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
            time: moment().tz(_unit?.info?.timezone || "Asia/Karachi").format('YYYY-MM-DD HH:mm:ss')
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

/**
 * Deep equality helper.
 */
const isSameObject = (obj1, obj2) => {
    if (typeof obj1 !== 'object' || typeof obj2 !== 'object' || obj1 === null || obj2 === null) {
        return false;
    }
    for (let key in obj1) {
        if (obj1.hasOwnProperty(key)) {
            if (!obj2.hasOwnProperty(key)) {
                return false;
            }
            if (typeof obj1[key] === 'object' && obj1[key] !== null) {
                if (!isSameObject(obj1[key], obj2[key])) {
                    return false;
                }
            } else if (obj1[key] !== obj2[key]) {
                return false;
            }
        }
    }
    return true;
};

/**
 * Push operational activity log.
 */
async function pushActivity(database, uid, unix, name, title, status, state) {
    const activity = {
        unix,
        title,
        status,
        state,
        name
    };
    try {
        await database.ref(`users/${uid}/activities`).push(activity);
    } catch (err) {
        console.error(`ERROR WHILE PUSHING ACTIVITIES: ${err}`);
    }
}

/**
 * Turn off machine or equipment.
 */
async function turnOff(database, name, uid, unit, isEQ, at, unix, _unit) {
    if (isEQ) {
        if (_unit.equipments[name]) {
            _unit.equipments[name].status = false;
            await pushActivity(
                database,
                uid,
                unix,
                _unit.equipments[name].name,
                `Equipment $NAME$ is now $STATE$.`,
                "ERROR",
                "OFF"
            );
            await database.ref(`users/${uid}/equipments/${name}/status`).set(false);
            await database.ref(`users/${uid}/equipments/${name}/at`).set(at);
            const today = getToday(uid, unix, _unit);
            const snap = await database.ref(`users/${uid}/reports/equipments/${name}/daily/${today}/total_sessions`).get();
            if (!snap.exists()) {
                await database.ref(`users/${uid}/reports/equipments/${name}/daily/${today}/total_sessions`).set(1);
            }
        }
    } else {
        if (_unit.machines[name]) {
            _unit.machines[name].machine_status = false;
            await pushActivity(
                database,
                uid,
                unix,
                _unit.machines[name].machine_model,
                `Machine $NAME$ is now $STATE$.`,
                "ERROR",
                "NOT IN PRODUCTION"
            );
            await database.ref(`users/${uid}/machines/${name}/machine_status`).set(false);
            await database.ref(`users/${uid}/machines/${name}/at`).set(at);
        }
    }
    return _unit;
}

/**
 * Turn on machine or equipment.
 */
async function turnOn(database, name, uid, unit, isEQ, at, unix, _unit) {
    if (isEQ) {
        if (_unit.equipments[name]) {
            _unit.equipments[name].status = true;
            await pushActivity(
                database,
                uid,
                unix,
                _unit.equipments[name].name,
                `Equipment $NAME$ is now $STATE$.`,
                "OK",
                "ON"
            );
            await database.ref(`users/${uid}/equipments/${name}/status`).set(true);
            await database.ref(`users/${uid}/equipments/${name}/at`).set(at);
            const today = getToday(uid, unix, _unit);
            await database.ref(`users/${uid}/reports/equipments/${name}/daily/${today}/total_sessions`).set(admin.database.ServerValue.increment(1));
        }
    } else {
        if (_unit.machines[name]) {
            _unit.machines[name].machine_status = true;
            await pushActivity(
                database,
                uid,
                unix,
                _unit.machines[name].machine_model,
                `Machine $NAME$ is now $STATE$.`,
                "OK",
                "IN PRODUCTION"
            );
            await database.ref(`users/${uid}/machines/${name}/machine_status`).set(true);
            await database.ref(`users/${uid}/machines/${name}/at`).set(at);
        }
    }
    return _unit;
}

/**
 * countProduction implementation.
 */
async function countProduction(database, uid, unit, name, value, time, unix, _unit) {
    value = value || 0;
    value = Number(value.toFixed(0));
    const machineObj = _unit.machines[name];
    if (!machineObj || machineObj.title === undefined) return _unit;

    const pulse_width = machineObj.pulse_width;
    const production_meters = pulse_width ? value * pulse_width : null;
    let production_meters_speed = null;
    let rotary_rpm = null;
    if (pulse_width) {
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
        product_weight = Number(machineObj.product_weight || 0);
    } else {
        if (Array.isArray(machineObj.installedMold.materials)) {
            for (const material of machineObj.installedMold.materials) {
                product_weight += Number(material.weight || 0);
            }
        }
    }

    // calculate production
    const production = value * cavities;
    const material_consumption = isMultiComponent 
        ? production * (product_weight + Number(machineObj.product_weight_2 || 0)) 
        : (pulse_width ? production_meters : production) * product_weight;

    let ontime = machineObj.machine_status ? time : 0;
    let offtime = machineObj.machine_status ? 0 : time;
    const today = getToday(uid, unix, _unit);

    const stats = {
        production: admin.database.ServerValue.increment(production),
        shots: admin.database.ServerValue.increment(value),
        production_meters: admin.database.ServerValue.increment(production_meters || 0),
        material_usage: admin.database.ServerValue.increment(material_consumption),
        electricity_usage: admin.database.ServerValue.increment(0),
        ontime: admin.database.ServerValue.increment(ontime),
        offtime: admin.database.ServerValue.increment(offtime)
    };

    const details = {};
    let mold_name = machineObj.mold_name || "NA";
    if (machineObj.installedMold === undefined) {
        details.cavities = machineObj.cavities;
        details.product = machineObj.product;
        details.isUniversal = !!machineObj.isUniversal;
        details.product_color = machineObj.product_color;
        details.materials = [{
            name: machineObj.material,
            weight: machineObj.product_weight
        }];
        details.material = machineObj.material;
        details.product_weight = machineObj.product_weight;
        if (isMultiComponent) {
            details.multi_component = true;
            details.material_2 = machineObj.material_2;
            details.product_weight_2 = machineObj.product_weight_2;
            details.materials.push({
                name: machineObj.material_2,
                weight: machineObj.product_weight_2
            });
        }
    } else {
        mold_name = machineObj.installedMold.name;
        machineObj.mold_name = mold_name;
        details.cavities = machineObj.installedMold.cavities;
        details.isUniversal = !!machineObj.installedMold.isUniversal;
        details.product = machineObj.installedMold.productName;
        details.product_color = machineObj.installedMold.productColor;
        details.materials = machineObj.installedMold.materials;
        details.material = machineObj.installedMold.materials[0]?.name || "";
        details.product_weight = machineObj.installedMold.materials[0]?.weight || 0;
    }

    const breakdown = {};
    if (Array.isArray(details.materials)) {
        for (const material of details.materials) {
            if (material && material.name) {
                breakdown[material.name] = admin.database.ServerValue.increment(
                    (material.weight || 0) * (pulse_width ? production_meters : production)
                );
            }
        }
    }

    const monitorDowntime = !!machineObj["monitor-downtime"];
    const downtimeFunc = async () => {
        try {
            if (!monitorDowntime) return;
            let downtimeTrack = _unit.downtimeTrack;
            if (downtimeTrack === undefined) {
                const snap = await database.ref(`users/${uid}/downtime/${name}`).limitToLast(1).once("value");
                const data = snap.val();
                if (data !== null) {
                    downtimeTrack = Object.keys(data)[0];
                    if (Object.values(data)[0].end) downtimeTrack = null;
                } else downtimeTrack = null;
            }
            if (downtimeTrack === null && offtime) {
                const ref = await database.ref(`users/${uid}/downtime/${name}`).push({
                    start: unix - offtime,
                    end: null,
                    status: "IDLE"
                });
                _unit.downtimeTrack = ref.key;
            } else if (ontime && downtimeTrack !== null) {
                await database.ref(`users/${uid}/downtime/${name}/${downtimeTrack}/end`).set(unix - ontime);
                _unit.downtimeTrack = null;
            }
        } catch (err) {
            console.log("ERROR IN downtimeFunc: " + err);
        }
    };

    try {
        const mold = mold_name;
        if (mold && mold !== "NA") {
            const hour = String(whatHour(uid, unix, _unit)).padStart(2, "0");
            const date = getToday(uid, unix, _unit);
            const start = secToTime(Number(_unit.info.shift_a_start || 0) + ((Number(hour) - 1) * 3600));
            const end = secToTime(Number(_unit.info.shift_a_start || 0) + (Number(hour) * 3600));
            const timeStr = `${start}-${end}`;
            let hasTarget = false;
            let hourlyTarget = 0;
            await database.ref(`users/${uid}/production-targets/active/${name}/${mold}/target`).transaction((target) => {
                if (target !== null) {
                    hasTarget = true;
                    hourlyTarget = target.hourlyTarget || 0;
                    target.current = (target.current || 0) + production;
                    const percentage = (target.current / (target.total || 1)) * 100;
                    if (percentage >= 50) target.milestone = 50;
                    if (percentage >= 75) target.milestone = 75;
                    if (percentage >= 100) target.milestone = 100;
                    if (target.current >= target.total) target.completed = true;
                    if (target.monitorDowntime !== undefined) {
                        machineObj["monitor-downtime"] = percentage < 100;
                    }
                    if (target.due) {
                        const tz = _unit?.info?.timezone || "Asia/Karachi";
                        const dueMissed = unix > moment.tz(target.due, tz).unix();
                        if (dueMissed && !target.dueMissed) target.dueMissed = dueMissed;
                    }
                    if (!target.startedAt) target.startedAt = admin.database.ServerValue.TIMESTAMP;
                    return target;
                } else return null;
            });

            let targetHourMissed = null;
            if (hasTarget) {
                const date = getToday(uid, unix, _unit);
                const month = moment(date).format("YYYY-MM");
                let previousHourDone = false;
                try {
                    await Promise.all([
                        database.ref(`users/${uid}/production-targets/active/${name}/${mold}/hours/${date}-${hour}`).transaction((data) => {
                            if (data === null) {
                                previousHourDone = true;
                                return {
                                    production,
                                    ontime,
                                    downtime: offtime,
                                    time: timeStr
                                };
                            } else {
                                previousHourDone = false;
                                return {
                                    production: (data.production || 0) + production,
                                    ontime: (data.ontime || 0) + ontime,
                                    downtime: (data.downtime || 0) + offtime,
                                    time: timeStr
                                };
                            }
                        }),
                        database.ref(`users/${uid}/production-targets/statistics/${month}/machines/${name}/${mold}`).update({
                            current: admin.database.ServerValue.increment(production),
                            ontime: admin.database.ServerValue.increment(ontime),
                            downtime: admin.database.ServerValue.increment(offtime),
                        }),
                        database.ref(`users/${uid}/production-targets/statistics/${month}/days/${date}/${name}/${mold}`).set(admin.database.ServerValue.increment(production)),
                    ]);
                } catch (err) {
                    console.error("ERROR IN production target update: " + err);
                }

                if (previousHourDone && hourlyTarget && false) {
                    const previousHourDate = Number(hour) === 1 ? moment(date).subtract(1, "days").format("YYYY-MM-DD") : date;
                    const previousHour = Number(hour) === 1 ? "24" : String(Number(hour) - 1).padStart(2, "0");
                    await database.ref(`users/${uid}/production-targets/active/${name}/${mold}/hours/${previousHourDate}-${previousHour}`).transaction((data) => {
                        if (data === null) return null;
                        if (((data.production || 0) < hourlyTarget) && data.time) {
                            targetHourMissed = `${previousHourDate} ${data.time}`;
                        }
                        return data;
                    });
                }
                if (targetHourMissed) {
                    await database.ref(`users/${uid}/errors/target-alerts/${name}/${mold}/h-target-missed/${targetHourMissed}`).set(true);
                }
            }
        }
    } catch (err) {
        console.log("ERROR IN target: " + err);
    }

    const promises = [
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total`).update(stats),
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/material_usage_breakdown`).update(breakdown),
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/molds/${mold_name}/stats`).update(stats),
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/molds/${mold_name}/details`).set(details),
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/operators/A/${machineObj.operator_a || ''}`).set(true),
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/operators/B/${machineObj.operator_b || ''}`).set(true),
        database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/operators/C/${machineObj.operator_c || ''}`).set(true),
        downtimeFunc()
    ];

    if (value) {
        promises.push(database.ref(`users/${uid}/machines/${name}/last_shot`).set(moment().unix()));
    }
    if (details.isUniversal) {
        promises.push(database.ref(`users/${uid}/reports/UNIVERSAL_MOLDS/${today}/${name}`).set(true));
    }
    await Promise.all(promises);

    // Hourly report logic
    let hourlyReportKey = _unit.hourlyReportData?.[name]?.key;
    let hourlyReportValues = _unit.hourlyReportData?.[name]?.values;

    if (hourlyReportKey === undefined) {
        const snap = await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}`).limitToLast(1).once("value");
        const hourlyData = snap.val();
        if (hourlyData !== null) {
            hourlyReportKey = Object.keys(hourlyData)[0];
            hourlyReportValues = Object.values(hourlyData)[0];
            if (!_unit.hourlyReportData) _unit.hourlyReportData = {};
            _unit.hourlyReportData[name] = { key: hourlyReportKey, values: hourlyReportValues };
        } else {
            if (!_unit.hourlyReportData) _unit.hourlyReportData = {};
            _unit.hourlyReportData[name] = null;
        }
    }

    const datetime = moment.unix(unix).utc();
    let sec = (datetime.hours() * 3600) + datetime.minutes() * 60 + datetime.seconds();
    let hoursx = sec <= (Number(_unit.info.shift_a_start || 0) + 59) ? 24 + datetime.hours() : datetime.hours();
    const seconds = (hoursx * 3600) + datetime.minutes() * 60 + datetime.seconds();

    let operator = machineObj.operator_a || '';
    const shifts = Number(_unit.info.shifts || 1);
    if (shifts === 2) {
        if (Number(_unit.info.shift_a_start || 0) <= seconds && seconds <= Number(_unit.info.shift_b_start || 0)) {
            operator = machineObj.operator_a || '';
        } else {
            operator = machineObj.operator_b || '';
        }
    } else if (shifts === 3) {
        if (Number(_unit.info.shift_a_start || 0) <= seconds && seconds <= Number(_unit.info.shift_b_start || 0)) {
            operator = machineObj.operator_a || '';
        } else if (Number(_unit.info.shift_b_start || 0) <= seconds && seconds <= Number(_unit.info.shift_c_start || 0)) {
            operator = machineObj.operator_b || '';
        } else {
            operator = machineObj.operator_c || '';
        }
    }

    const hourDetails = {
        status: machineObj.machine_status,
        operator,
        mold_name: mold_name || null,
        ...details
    };

    const hourlyStats = {
        production: admin.database.ServerValue.increment(production),
        shots: admin.database.ServerValue.increment(value),
        production_meters: admin.database.ServerValue.increment(production_meters || 0),
        material_usage: admin.database.ServerValue.increment(material_consumption),
        electricity_usage: admin.database.ServerValue.increment(0),
        ontime: admin.database.ServerValue.increment(ontime),
        offtime: admin.database.ServerValue.increment(offtime),
    };

    if (_unit.hourlyReportData[name] !== null && hourlyReportKey !== undefined) {
        const hasNotChanged = isSameObject(hourDetails, hourlyReportValues);
        if (hourlyReportValues.from <= seconds && seconds <= hourlyReportValues.time) {
            if (hasNotChanged) {
                await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${hourlyReportKey}`).update(hourlyStats);
            } else {
                await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${hourlyReportKey}`).update({ time: seconds });
                hourlyReportKey = Number(hourlyReportKey) + 1;
                _unit.hourlyReportData[name] = {
                    key: hourlyReportKey,
                    values: { from: seconds, time: hourlyReportValues.time, ...hourDetails }
                };
                await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${hourlyReportKey}`).set({
                    ...hourlyStats,
                    from: seconds,
                    time: hourlyReportValues.time,
                    ...hourDetails
                });
            }
        } else {
            hourlyReportKey = Number(hourlyReportKey) + 1;
            ontime = ontime > 3600 ? 3600 : ontime;
            offtime = offtime > 3600 ? 3600 : offtime;
            const shiftStartMinutes = (Number(_unit.info.shift_a_start || 0) % 3600) / 60;
            const shiftStartHours = Math.floor(Number(_unit.info.shift_a_start || 0) / 3600);
            let nextTime = ((((hoursx - 24 === shiftStartHours || datetime.minutes() < shiftStartMinutes) ? hoursx : hoursx + 1)) * 3600 + shiftStartMinutes * 60) + 59;
            _unit.hourlyReportData[name] = {
                key: hourlyReportKey,
                values: { from: seconds, time: nextTime, ...hourDetails }
            };
            await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${hourlyReportKey}`).set({
                ...hourlyStats,
                from: seconds,
                time: nextTime,
                ...hourDetails
            });
        }
    } else {
        let key = 0;
        const shiftStartMinutes = (Number(_unit.info.shift_a_start || 0) % 3600) / 60;
        const shiftStartHours = Math.floor(Number(_unit.info.shift_a_start || 0) / 3600);
        let nextTime = ((((hoursx - 24 === shiftStartHours || datetime.minutes() < shiftStartMinutes) ? hoursx : hoursx + 1)) * 3600 + shiftStartMinutes * 60) + 59;
        _unit.hourlyReportData[name] = {
            key,
            values: { from: seconds, time: nextTime, ...hourDetails }
        };
        await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${key}`).set({
            ...hourlyStats,
            from: seconds,
            time: nextTime,
            ...hourDetails
        });
    }

    try {
        await Promise.all([
            database.ref(`users/${uid}/machines/${name}/updated`).set(moment().tz(_unit?.info?.timezone || "Asia/Karachi").format('YYYY-MM-DD HH:mm:ss')),
            database.ref(`users/${uid}/machines/${name}/production_meters_speed`).transaction(speed => {
                if (speed === null) return { current: +(production_meters_speed || 0).toFixed(2), previous: +(production_meters_speed || 0).toFixed(2) };
                return { current: +(production_meters_speed || 0).toFixed(2), previous: +speed.current.toFixed(2) || 0 };
            }),
            database.ref(`users/${uid}/machines/${name}/rotary_rpm`).transaction(speed => {
                if (speed === null) return { current: +(rotary_rpm || 0).toFixed(2), previous: +(rotary_rpm || 0).toFixed(2) };
                return { current: +(rotary_rpm || 0).toFixed(2), previous: +speed.current.toFixed(2) || 0 };
            })
        ]);
    } catch (err) {
        console.error("ERROR IN updating machine metrics: " + err);
    }

    const hourIndex = whatHour(uid, unix, _unit);
    await database.ref(`users/${uid}/reports/factory/hourly/${today}/${hourIndex}/machines/${name}`).update({
        production: admin.database.ServerValue.increment(production),
        shots: admin.database.ServerValue.increment(value),
        production_meters: admin.database.ServerValue.increment(production_meters || 0),
        material_usage: admin.database.ServerValue.increment(material_consumption),
        electricity_usage: admin.database.ServerValue.increment(0),
    });

    const shiftsData = {
        shifts: _unit.info.shifts,
        shift_a_start: _unit.info.shift_a_start,
        shift_b_start: _unit.info.shift_b_start,
        shift_c_start: _unit.info.shift_c_start,
        supervisor_a: _unit.info.supervisor_a,
        supervisor_b: _unit.info.supervisor_b,
        supervisor_c: _unit.info.supervisor_c,
        shift_a_hours: _unit.info.shift_a_hours,
        shift_b_hours: _unit.info.shift_b_hours,
        shift_c_hours: _unit.info.shift_c_hours,
    };

    const onlyFactory = isNaN(_unit.subFactory) || _unit.subFactory === -1;
    await database.ref(`users/${uid}/reports/factory/daily/${today}`).update({
        production: admin.database.ServerValue.increment(production),
        shots: admin.database.ServerValue.increment(value),
        production_meters: admin.database.ServerValue.increment(production_meters || 0),
        material_usage: admin.database.ServerValue.increment(material_consumption),
        electricity_usage: admin.database.ServerValue.increment(0),
        ...(onlyFactory ? shiftsData : {})
    });

    if (!onlyFactory) {
        await database.ref(`users/${uid}/reports/factory/daily/${today}/factories/${_unit.subFactory}`).update(shiftsData);
    }

    return _unit;
}

/**
 * countElectricity implementation.
 */
async function countElectricity(database, uid, unit, type, name, value, time, unix, _unit, accumulatorIncrements = {}) {
    const isEQ = type === 'equipments';
    const today = getToday(uid, unix, _unit);
    const hourIndex = whatHour(uid, unix, _unit);
    const hasAccumulators = Object.keys(accumulatorIncrements).length > 0;

    if (isEQ) {
        const equipmentObj = _unit.equipments[name];
        if (!equipmentObj) return _unit;
        const division = Number(equipmentObj.division || 1);
        
        // Convert Watthour (Wh) from packet to Kilowatthour (kWh) for DB storage
        const electricity_consumption = value / 1000;
        
        const time_in_h = time > 0 ? time / 3600 : 0;
        const realtime_kw_mn = time_in_h > 0 ? electricity_consumption / time_in_h : 0;
        const realtime_kw = isNaN(realtime_kw_mn) || !isFinite(realtime_kw_mn) ? 0 : +realtime_kw_mn.toFixed(2);
        
        const status = equipmentObj.status;
        let ontime = status ? time : 0;

        const stats = {
            electricity_usage: admin.database.ServerValue.increment(electricity_consumption),
            ontime: admin.database.ServerValue.increment(ontime),
            name: equipmentObj.name || '',
            division: division,
        };

        if (hasAccumulators) {
            for (const [param, inc] of Object.entries(accumulatorIncrements)) {
                stats[`accumulators/${param}`] = admin.database.ServerValue.increment(inc);
            }
        }

        await database.ref(`users/${uid}/reports/equipments/${name}/daily/${today}/`).update(stats);

        let hourlyReportKey = _unit.hourlyReportData?.[name]?.key;
        let hourlyReportValues = _unit.hourlyReportData?.[name]?.values;

        if (hourlyReportKey === undefined) {
            const snap = await database.ref(`users/${uid}/reports/equipments/${name}/hourly/${today}`).limitToLast(1).once("value");
            const hourlyData = snap.val();
            if (hourlyData !== null) {
                hourlyReportKey = Object.keys(hourlyData)[0];
                hourlyReportValues = Object.values(hourlyData)[0];
                if (!_unit.hourlyReportData) _unit.hourlyReportData = {};
                _unit.hourlyReportData[name] = { key: hourlyReportKey, values: hourlyReportValues };
            } else {
                if (!_unit.hourlyReportData) _unit.hourlyReportData = {};
                _unit.hourlyReportData[name] = null;
            }
        }

        const datetime = moment.unix(unix).utc();
        let sec = (datetime.hours() * 3600) + datetime.minutes() * 60 + datetime.seconds();
        let hoursx = sec <= (Number(_unit.info.shift_a_start || 0) + 59) ? 24 + datetime.hours() : datetime.hours();
        const seconds = (hoursx * 3600) + datetime.minutes() * 60 + datetime.seconds();

        const hourlyStats = {
            electricity_usage: admin.database.ServerValue.increment(electricity_consumption),
            ontime: admin.database.ServerValue.increment(ontime)
        };

        const hourlyUpdate = { ...hourlyStats };
        if (hasAccumulators) {
            for (const [param, inc] of Object.entries(accumulatorIncrements)) {
                hourlyUpdate[`accumulators/${param}`] = admin.database.ServerValue.increment(inc);
            }
        }

        const hourlySet = { ...hourlyStats };
        if (hasAccumulators) {
            const accumSet = {};
            for (const [param, inc] of Object.entries(accumulatorIncrements)) {
                accumSet[param] = admin.database.ServerValue.increment(inc);
            }
            hourlySet.accumulators = accumSet;
        }

        if (_unit.hourlyReportData[name] !== null && hourlyReportKey !== undefined) {
            if (hourlyReportValues.from <= seconds && seconds <= hourlyReportValues.time) {
                await database.ref(`users/${uid}/reports/equipments/${name}/hourly/${today}/${hourlyReportKey}`).update(hourlyUpdate);
            } else {
                hourlyReportKey = Number(hourlyReportKey) + 1;
                _unit.hourlyReportData[name] = {
                    key: hourlyReportKey,
                    values: { from: seconds, time: hourlyReportValues.time, status }
                };
                await database.ref(`users/${uid}/reports/equipments/${name}/hourly/${today}/${hourlyReportKey}`).set({
                    ...hourlySet,
                    from: seconds,
                    time: hourlyReportValues.time,
                    status
                });
            }
        } else {
            let key = 0;
            const shiftStartMinutes = (Number(_unit.info.shift_a_start || 0) % 3600) / 60;
            const shiftStartHours = Math.floor(Number(_unit.info.shift_a_start || 0) / 3600);
            let nextTime = ((((hoursx - 24 === shiftStartHours || datetime.minutes() < shiftStartMinutes) ? hoursx : hoursx + 1)) * 3600 + shiftStartMinutes * 60) + 59;
            _unit.hourlyReportData[name] = {
                key,
                values: { from: seconds, time: nextTime, status }
            };
            await database.ref(`users/${uid}/reports/equipments/${name}/hourly/${today}/${key}`).set({
                ...hourlySet,
                from: seconds,
                time: nextTime,
                status
            });
        }

        const shiftsData = {
            shifts: _unit.info.shifts,
            shift_a_start: _unit.info.shift_a_start,
            shift_b_start: _unit.info.shift_b_start,
            shift_c_start: _unit.info.shift_c_start,
            supervisor_a: _unit.info.supervisor_a,
            supervisor_b: _unit.info.supervisor_b,
            supervisor_c: _unit.info.supervisor_c,
            shift_a_hours: _unit.info.shift_a_hours,
            shift_b_hours: _unit.info.shift_b_hours,
            shift_c_hours: _unit.info.shift_c_hours,
        };

        const onlyFactory = isNaN(_unit.subFactory) || _unit.subFactory === -1;
        try {
            const factoryHourlyUpdate = {
                electricity_usage: admin.database.ServerValue.increment(electricity_consumption)
            };
            if (hasAccumulators) {
                for (const [param, inc] of Object.entries(accumulatorIncrements)) {
                    factoryHourlyUpdate[`accumulators/${param}`] = admin.database.ServerValue.increment(inc);
                }
            }

            const factoryDailyUpdate = {
                electricity_usage: admin.database.ServerValue.increment(electricity_consumption),
                ...(onlyFactory ? shiftsData : {})
            };
            if (hasAccumulators) {
                for (const [param, inc] of Object.entries(accumulatorIncrements)) {
                    factoryDailyUpdate[`accumulators/${param}`] = admin.database.ServerValue.increment(inc);
                }
            }

            await Promise.all([
                database.ref(`users/${uid}/equipments/${name}/updated`).set(moment().tz(_unit?.info?.timezone || "Asia/Karachi").format("YYYY-MM-DD HH:mm:ss")),
                database.ref(`users/${uid}/reports/factory/hourly/${today}/${hourIndex}/equipments/${name}`).update(factoryHourlyUpdate),
                database.ref(`users/${uid}/reports/factory/daily/${today}`).update(factoryDailyUpdate),
                database.ref(`users/${uid}/equipments/${name}/realtime_kw`).transaction(load => {
                    if (load === null) return { current: +realtime_kw.toFixed(2), previous: +realtime_kw.toFixed(2) };
                    return { current: +realtime_kw.toFixed(2), previous: +load.current.toFixed(2) || 0 };
                })
            ]);
        } catch (err) {
            console.error("ERROR IN countElectricity (eq): " + err);
        }

        if (!onlyFactory) {
            await database.ref(`users/${uid}/reports/factory/daily/${today}/factories/${_unit.subFactory}`).update(shiftsData);
        }
    } else {
        const machineObj = _unit.machines[name];
        if (!machineObj) return _unit;

        const isMultiComponent = !!machineObj.multi_component;
        const division = Number(machineObj.division || 1);
        
        // Convert Watthour (Wh) from packet to Kilowatthour (kWh) for DB storage
        const electricity_consumption = value / 1000;
        
        const time_in_h = time > 0 ? time / 3600 : 0;
        const realtime_kw_mn = time_in_h > 0 ? electricity_consumption / time_in_h : 0;
        const realtime_kw = isNaN(realtime_kw_mn) || !isFinite(realtime_kw_mn) ? 0 : +realtime_kw_mn.toFixed(2);
        time = 0; // matching legacy time = 0 reassignment for machine path

        const status = machineObj.machine_status;
        let ontime = status ? time : 0;
        let offtime = status ? 0 : time;
        const monitorDowntime = !!machineObj["monitor-downtime"];

        const stats = {
            production: admin.database.ServerValue.increment(0),
            shots: admin.database.ServerValue.increment(0),
            material_usage: admin.database.ServerValue.increment(0),
            electricity_usage: admin.database.ServerValue.increment(electricity_consumption),
            ontime: admin.database.ServerValue.increment(ontime),
            offtime: admin.database.ServerValue.increment(offtime)
        };

        if (hasAccumulators) {
            for (const [param, inc] of Object.entries(accumulatorIncrements)) {
                stats[`accumulators/${param}`] = admin.database.ServerValue.increment(inc);
            }
        }

        const details = {};
        let mold_name = machineObj.mold_name || "NA";
        if (machineObj.installedMold === undefined) {
            details.cavities = machineObj.cavities;
            details.product = machineObj.product;
            details.isUniversal = !!machineObj.isUniversal;
            details.product_color = machineObj.product_color;
            details.materials = [{
                name: machineObj.material,
                weight: machineObj.product_weight
            }];
            details.material = machineObj.material;
            details.product_weight = machineObj.product_weight;
            if (isMultiComponent) {
                details.multi_component = true;
                details.material_2 = machineObj.material_2;
                details.product_weight_2 = machineObj.product_weight_2;
                details.materials.push({
                    name: machineObj.material_2,
                    weight: machineObj.product_weight_2
                });
            }
        } else {
            mold_name = machineObj.installedMold.name;
            machineObj.mold_name = mold_name;
            details.cavities = machineObj.installedMold.cavities;
            details.isUniversal = !!machineObj.installedMold.isUniversal;
            details.product = machineObj.installedMold.productName;
            details.product_color = machineObj.installedMold.productColor;
            details.materials = machineObj.installedMold.materials;
            details.material = machineObj.installedMold.materials[0]?.name || "";
            details.product_weight = machineObj.installedMold.materials[0]?.weight || 0;
        }

        const breakdown = {};
        if (Array.isArray(details.materials)) {
            for (const material of details.materials) {
                if (material && material.name) {
                    breakdown[material.name] = admin.database.ServerValue.increment(0);
                }
            }
        }

        const downtimeFunc = async () => {
            try {
                if (!monitorDowntime) return;
                let downtimeTrack = _unit.downtimeTrack;
                if (downtimeTrack === undefined) {
                    const snap = await database.ref(`users/${uid}/downtime/${name}`).limitToLast(1).once("value");
                    const data = snap.val();
                    if (data !== null) {
                        downtimeTrack = Object.keys(data)[0];
                        if (Object.values(data)[0].end) downtimeTrack = null;
                    } else downtimeTrack = null;
                }
                if (downtimeTrack === null && offtime) {
                    const ref = await database.ref(`users/${uid}/downtime/${name}`).push({
                        start: unix - offtime,
                        end: null,
                        status: "IDLE"
                    });
                    _unit.downtimeTrack = ref.key;
                } else if (ontime && downtimeTrack !== null) {
                    await database.ref(`users/${uid}/downtime/${name}/${downtimeTrack}/end`).set(unix - ontime);
                    _unit.downtimeTrack = null;
                }
            } catch (err) {
                console.log("ERROR IN downtimeFunc: " + err);
            }
        };

        const promises = [
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total`).update(stats),
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/material_usage_breakdown`).update(breakdown),
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/molds/${mold_name}/stats`).update(stats),
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/molds/${mold_name}/details`).set(details),
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/operators/A/${machineObj.operator_a || ''}`).set(true),
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/operators/B/${machineObj.operator_b || ''}`).set(true),
            database.ref(`users/${uid}/reports/machines/${name}/daily/${today}/total/operators/C/${machineObj.operator_c || ''}`).set(true),
            downtimeFunc()
        ];

        if (details.isUniversal) {
            promises.push(database.ref(`users/${uid}/reports/UNIVERSAL_MOLDS/${today}/${name}`).set(true));
        }
        await Promise.all(promises);

        let hourlyReportKey = _unit.hourlyReportData?.[name]?.key;
        let hourlyReportValues = _unit.hourlyReportData?.[name]?.values;

        if (hourlyReportKey === undefined) {
            const snap = await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}`).limitToLast(1).once("value");
            const hourlyData = snap.val();
            if (hourlyData !== null) {
                hourlyReportKey = Object.keys(hourlyData)[0];
                hourlyReportValues = Object.values(hourlyData)[0];
                if (!_unit.hourlyReportData) _unit.hourlyReportData = {};
                _unit.hourlyReportData[name] = { key: hourlyReportKey, values: hourlyReportValues };
            } else {
                if (!_unit.hourlyReportData) _unit.hourlyReportData = {};
                _unit.hourlyReportData[name] = null;
            }
        }

        const datetime = moment.unix(unix).utc();
        let sec = (datetime.hours() * 3600) + datetime.minutes() * 60 + datetime.seconds();
        let hoursx = sec <= (Number(_unit.info.shift_a_start || 0) + 59) ? 24 + datetime.hours() : datetime.hours();
        const seconds = (hoursx * 3600) + datetime.minutes() * 60 + datetime.seconds();

        let operator = machineObj.operator_a || '';
        const shifts = Number(_unit.info.shifts || 1);
        if (shifts === 2) {
            if (Number(_unit.info.shift_a_start || 0) <= seconds && seconds <= Number(_unit.info.shift_b_start || 0)) {
                operator = machineObj.operator_a || '';
            } else {
                operator = machineObj.operator_b || '';
            }
        } else if (shifts === 3) {
            if (Number(_unit.info.shift_a_start || 0) <= seconds && seconds <= Number(_unit.info.shift_b_start || 0)) {
                operator = machineObj.operator_a || '';
            } else if (Number(_unit.info.shift_b_start || 0) <= seconds && seconds <= Number(_unit.info.shift_c_start || 0)) {
                operator = machineObj.operator_b || '';
            } else {
                operator = machineObj.operator_c || '';
            }
        }

        const hourDetails = {
            status: machineObj.machine_status,
            operator,
            mold_name: mold_name || null,
            ...details
        };

        const hourlyStats = {
            production: admin.database.ServerValue.increment(0),
            shots: admin.database.ServerValue.increment(0),
            material_usage: admin.database.ServerValue.increment(0),
            electricity_usage: admin.database.ServerValue.increment(electricity_consumption),
            ontime: admin.database.ServerValue.increment(ontime),
            offtime: admin.database.ServerValue.increment(offtime),
        };

        const hourlyUpdate = { ...hourlyStats };
        if (hasAccumulators) {
            for (const [param, inc] of Object.entries(accumulatorIncrements)) {
                hourlyUpdate[`accumulators/${param}`] = admin.database.ServerValue.increment(inc);
            }
        }

        const hourlySet = { ...hourlyStats };
        if (hasAccumulators) {
            const accumSet = {};
            for (const [param, inc] of Object.entries(accumulatorIncrements)) {
                accumSet[param] = admin.database.ServerValue.increment(inc);
            }
            hourlySet.accumulators = accumSet;
        }

        if (_unit.hourlyReportData[name] !== null && hourlyReportKey !== undefined) {
            const hasNotChanged = isSameObject(hourDetails, hourlyReportValues);
            if (hourlyReportValues.from <= seconds && seconds <= hourlyReportValues.time) {
                if (hasNotChanged) {
                    await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${hourlyReportKey}`).update(hourlyUpdate);
                } else {
                    await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${hourlyReportKey}`).update({ time: seconds });
                    hourlyReportKey = Number(hourlyReportKey) + 1;
                    _unit.hourlyReportData[name] = {
                        key: hourlyReportKey,
                        values: { from: seconds, time: hourlyReportValues.time, ...hourDetails }
                    };
                    await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${hourlyReportKey}`).set({
                        ...hourlySet,
                        from: seconds,
                        time: hourlyReportValues.time,
                        ...hourDetails
                    });
                }
            } else {
                hourlyReportKey = Number(hourlyReportKey) + 1;
                ontime = ontime > 3600 ? 3600 : ontime;
                offtime = offtime > 3600 ? 3600 : offtime;
                const shiftStartMinutes = (Number(_unit.info.shift_a_start || 0) % 3600) / 60;
                const shiftStartHours = Math.floor(Number(_unit.info.shift_a_start || 0) / 3600);
                let nextTime = ((((hoursx - 24 === shiftStartHours || datetime.minutes() < shiftStartMinutes) ? hoursx : hoursx + 1)) * 3600 + shiftStartMinutes * 60) + 59;
                _unit.hourlyReportData[name] = {
                    key: hourlyReportKey,
                    values: { from: seconds, time: nextTime, ...hourDetails }
                };
                await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${hourlyReportKey}`).set({
                    ...hourlySet,
                    from: seconds,
                    time: nextTime,
                    ...hourDetails
                });
            }
        } else {
            let key = 0;
            const shiftStartMinutes = (Number(_unit.info.shift_a_start || 0) % 3600) / 60;
            const shiftStartHours = Math.floor(Number(_unit.info.shift_a_start || 0) / 3600);
            let nextTime = ((((hoursx - 24 === shiftStartHours || datetime.minutes() < shiftStartMinutes) ? hoursx : hoursx + 1)) * 3600 + shiftStartMinutes * 60) + 59;
            _unit.hourlyReportData[name] = {
                key,
                values: { from: seconds, time: nextTime, ...hourDetails }
            };
            await database.ref(`users/${uid}/reports/machines/${name}/hourly/${today}/${key}`).set({
                ...hourlyStats,
                from: seconds,
                time: nextTime,
                ...hourDetails
            });
        }

        const shiftsData = {
            shifts: _unit.info.shifts,
            shift_a_start: _unit.info.shift_a_start,
            shift_b_start: _unit.info.shift_b_start,
            shift_c_start: _unit.info.shift_c_start,
            supervisor_a: _unit.info.supervisor_a,
            supervisor_b: _unit.info.supervisor_b,
            supervisor_c: _unit.info.supervisor_c,
            shift_a_hours: _unit.info.shift_a_hours,
            shift_b_hours: _unit.info.shift_b_hours,
            shift_c_hours: _unit.info.shift_c_hours,
        };

        const onlyFactory = isNaN(_unit.subFactory) || _unit.subFactory === -1;
        try {
            const factoryHourlyUpdate = {
                electricity_usage: admin.database.ServerValue.increment(electricity_consumption)
            };
            if (hasAccumulators) {
                for (const [param, inc] of Object.entries(accumulatorIncrements)) {
                    factoryHourlyUpdate[`accumulators/${param}`] = admin.database.ServerValue.increment(inc);
                }
            }

            const factoryDailyUpdate = {
                production: admin.database.ServerValue.increment(0),
                shots: admin.database.ServerValue.increment(0),
                material_usage: admin.database.ServerValue.increment(0),
                electricity_usage: admin.database.ServerValue.increment(electricity_consumption),
                ...(onlyFactory ? shiftsData : {})
            };
            if (hasAccumulators) {
                for (const [param, inc] of Object.entries(accumulatorIncrements)) {
                    factoryDailyUpdate[`accumulators/${param}`] = admin.database.ServerValue.increment(inc);
                }
            }

            await Promise.all([
                database.ref(`users/${uid}/machines/${name}/updated`).set(moment().tz(_unit?.info?.timezone || "Asia/Karachi").format('YYYY-MM-DD HH:mm:ss')),
                database.ref(`users/${uid}/reports/factory/hourly/${today}/${hourIndex}/machines/${name}`).update(factoryHourlyUpdate),
                database.ref(`users/${uid}/reports/factory/daily/${today}`).update(factoryDailyUpdate),
                database.ref(`users/${uid}/machines/${name}/realtime_kw`).transaction(load => {
                    if (load === null) return { current: +realtime_kw.toFixed(2), previous: +realtime_kw.toFixed(2) };
                    return { current: +realtime_kw.toFixed(2), previous: +load.current.toFixed(2) || 0 };
                })
            ]);
        } catch (err) {
            console.error("ERROR IN countElectricity (mach): " + err);
        }

        if (!onlyFactory) {
            await database.ref(`users/${uid}/reports/factory/daily/${today}/factories/${_unit.subFactory}`).update(shiftsData);
        }
    }
    return _unit;
}

async function ensureHourlyReportKey(database, uid, type, id, today, unix, _unit) {
    if (!_unit.hourlyReportData) _unit.hourlyReportData = {};
    
    // If it's already in memory cache, return it
    if (_unit.hourlyReportData[id] !== undefined && _unit.hourlyReportData[id] !== null) {
        return _unit.hourlyReportData[id].key;
    }
    
    // Otherwise, try to fetch the last key from RTDB
    const snap = await database.ref(`users/${uid}/reports/${type}/${id}/hourly/${today}`).limitToLast(1).once("value");
    const hourlyData = snap.val();
    if (hourlyData !== null) {
        const key = Object.keys(hourlyData)[0];
        const values = Object.values(hourlyData)[0];
        _unit.hourlyReportData[id] = { key: Number(key), values };
        return Number(key);
    }
    
    // If not found in RTDB, we need to create/initialize the first segment (key: 0)
    const key = 0;
    const datetime = moment.unix(unix).utc();
    const sec = (datetime.hours() * 3600) + datetime.minutes() * 60 + datetime.seconds();
    const hoursx = sec <= (Number(_unit.info.shift_a_start || 0) + 59) ? 24 + datetime.hours() : datetime.hours();
    const seconds = (hoursx * 3600) + datetime.minutes() * 60 + datetime.seconds();
    
    const shiftStartMinutes = (Number(_unit.info.shift_a_start || 0) % 3600) / 60;
    const shiftStartHours = Math.floor(Number(_unit.info.shift_a_start || 0) / 3600);
    const nextTime = ((((hoursx - 24 === shiftStartHours || datetime.minutes() < shiftStartMinutes) ? hoursx : hoursx + 1)) * 3600 + shiftStartMinutes * 60) + 59;
    
    let status = false;
    let operator = '';
    let mold_name = 'NA';
    let details = {};

    if (type === 'machines') {
        const machineObj = _unit.machines?.[id] || {};
        status = machineObj.machine_status ?? false;
        
        let targetHoursx = hoursx;
        let targetSeconds = seconds;
        let targetShifts = Number(_unit.info.shifts || 1);
        if (targetShifts === 2) {
            if (Number(_unit.info.shift_a_start || 0) <= targetSeconds && targetSeconds <= Number(_unit.info.shift_b_start || 0)) {
                operator = machineObj.operator_a || '';
            } else {
                operator = machineObj.operator_b || '';
            }
        } else if (targetShifts === 3) {
            if (Number(_unit.info.shift_a_start || 0) <= targetSeconds && targetSeconds <= Number(_unit.info.shift_b_start || 0)) {
                operator = machineObj.operator_a || '';
            } else if (Number(_unit.info.shift_b_start || 0) <= targetSeconds && targetSeconds <= Number(_unit.info.shift_c_start || 0)) {
                operator = machineObj.operator_b || '';
            } else {
                operator = machineObj.operator_c || '';
            }
        } else {
            operator = machineObj.operator_a || '';
        }
        
        if (machineObj.installedMold === undefined) {
            details.cavities = machineObj.cavities || 1;
            details.product = machineObj.product || 'N/A';
            details.isUniversal = !!machineObj.isUniversal;
            details.product_color = machineObj.product_color || 'N/A';
            details.materials = [{
                name: machineObj.material || 'copp',
                weight: machineObj.product_weight || 100
            }];
            details.material = machineObj.material || 'copp';
            details.product_weight = machineObj.product_weight || 100;
        } else {
            mold_name = machineObj.installedMold.name;
            details.cavities = machineObj.installedMold.cavities;
            details.isUniversal = !!machineObj.installedMold.isUniversal;
            details.product = machineObj.installedMold.productName;
            details.product_color = machineObj.installedMold.productColor;
            details.materials = machineObj.installedMold.materials;
            details.material = machineObj.installedMold.materials[0]?.name || "";
            details.product_weight = machineObj.installedMold.materials[0]?.weight || 0;
        }
    } else {
        const equipmentObj = _unit.equipments?.[id] || {};
        status = equipmentObj.status ?? false;
    }

    const initialValues = {
        from: seconds,
        time: nextTime,
        status,
        operator,
        mold_name,
        ...details,
        production: 0,
        shots: 0,
        production_meters: 0,
        material_usage: 0,
        electricity_usage: 0,
        ontime: 0,
        offtime: 0
    };

    _unit.hourlyReportData[id] = {
        key,
        values: initialValues
    };

    await database.ref(`users/${uid}/reports/${type}/${id}/hourly/${today}/${key}`).set(initialValues);
    return key;
}

async function processPhaseValues(database, uid, unit, type, id, phase_values, unix, _unit) {
    const today = getToday(uid, unix, _unit);
    const hour = whatHour(uid, unix, _unit);
    const hourlyReportKey = await ensureHourlyReportKey(database, uid, type, id, today, unix, _unit);
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
                const timeDiff = _unit.previousUnix ? (unix - _unit.previousUnix) : 0;
                const safeTimeDiff = (timeDiff < 0 || timeDiff > 3600) ? 0 : timeDiff;

                const increments = {};
                const txPromises = [];

                for (const [param, rawIncomingValue] of Object.entries(accumulatorPayload)) {
                    const incomingValue = Number(rawIncomingValue);
                    if (!Number.isFinite(incomingValue)) continue;

                    txPromises.push((async () => {
                        // Fetch the legacy value once to initialize lifetime on the very first run
                        let legacyValue = null;
                        const stateRef = database.ref(`users/${uid}/reports/${type}/${id}/accumulators_state/${param}`);
                        const stateSnap = await stateRef.once('value');
                        if (!stateSnap.exists()) {
                            const legacySnap = await database.ref(`users/${uid}/reports/${type}/${id}/accumulators/${param}`).once('value');
                            legacyValue = legacySnap.val();
                        }

                        let incrementBy = 0;
                        const result = await stateRef.transaction((current) => {
                            let dbRawValue = 0;
                            let dbLifetimeValue = 0;
                            let isInitialized = false;

                            if (current !== null) {
                                const rawVal = Number(current.raw);
                                dbRawValue = Number.isFinite(rawVal) ? rawVal : 0;
                                const lifeVal = Number(current.lifetime);
                                dbLifetimeValue = Number.isFinite(lifeVal) ? lifeVal : 0;
                                isInitialized = true;
                            } else if (legacyValue !== null && Number.isFinite(Number(legacyValue))) {
                                const legVal = Number(legacyValue);
                                dbRawValue = legVal;
                                dbLifetimeValue = legVal;
                                isInitialized = true;
                            }

                            if (!isInitialized) {
                                // Truly first initialization of state with no legacy value
                                incrementBy = 0;
                                return {
                                    raw: incomingValue,
                                    lifetime: incomingValue
                                };
                            }

                            // Rule 1: If incoming value is 0, we suspect a temporary Modbus failure/initialization state.
                            // We ignore it (do not update raw or lifetime, return 0 increment).
                            if (incomingValue === 0) {
                                incrementBy = 0;
                                return current || { raw: dbRawValue, lifetime: dbLifetimeValue };
                            }

                            // Rule 2: If previous raw value was 0, it means we are recovering from a 0 state (boot-up / connection recovery).
                            // We treat this as the new raw baseline and return 0 increment.
                            if (dbRawValue === 0) {
                                incrementBy = 0;
                                return {
                                    raw: incomingValue,
                                    lifetime: dbLifetimeValue
                                };
                            }

                            // Rule 3: Normal case - incoming value matches previous raw value
                            if (dbRawValue === incomingValue) {
                                incrementBy = 0;
                                return current || { raw: dbRawValue, lifetime: dbLifetimeValue };
                            }

                            // Rule 4: Normal case - incoming value is greater than previous raw value
                            if (incomingValue > dbRawValue) {
                                incrementBy = incomingValue - dbRawValue;
                                return {
                                    raw: incomingValue,
                                    lifetime: dbLifetimeValue + incrementBy
                                };
                            }

                            // Rule 5: Rollover/Reset case - incoming value is less than previous raw value
                            // We increment lifetime by incomingValue (since it reset to 0 and grew to incomingValue)
                            incrementBy = incomingValue;
                            return {
                                raw: incomingValue,
                                lifetime: dbLifetimeValue + incrementBy
                            };
                        });

                        if (result.committed && result.snapshot && result.snapshot.val()) {
                            const newLifetime = result.snapshot.val().lifetime;
                            // Update legacy accumulators key so existing client views work
                            await database.ref(`users/${uid}/reports/${type}/${id}/accumulators/${param}`).set(newLifetime);
                            increments[param] = incrementBy;
                        }
                    })());
                }

                await Promise.all(txPromises);

                // Prioritize SUM_WH_Total, fallback to SUM_WH_Import for countElectricity to avoid double counting
                let electricityIncrement = 0;
                if (increments['SUM_WH_Total'] > 0) {
                    electricityIncrement = increments['SUM_WH_Total'];
                } else if (increments['SUM_WH_Import'] > 0) {
                    electricityIncrement = increments['SUM_WH_Import'];
                }

                const accumulatorIncrements = {};
                for (const [param, inc] of Object.entries(increments)) {
                    accumulatorIncrements[param] = inc / 1000;
                }

                if (Object.keys(accumulatorIncrements).length > 0) {
                    await countElectricity(database, uid, unit, type, id, electricityIncrement, safeTimeDiff, unix, _unit, accumulatorIncrements);
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
            const ALLOWED_HOURLY_METRICS = {
                phase: {
                    "VOLTAGE": ["min", "max", "avg"],
                    "L_L_VOLTAGE": ["min", "max", "avg"],
                    "AMPERE": ["max", "avg"],
                    "POWER": ["max", "avg"]
                },
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
                        database.ref(`users/${uid}/reports/${type}/${id}/hourly/${today}/${hourlyReportKey}/phase_values/${phase}/${param}`).transaction(txFnHouly)
                    );                }
            }
        }
    }
    await Promise.all(transactionPromises);
}

async function processDigitalValues(database, uid, unit, type, id, digital_values, unix, _unit, inputs) {
    const today = getToday(uid, unix, _unit);
    const hour = whatHour(uid, unix, _unit);
    const hourlyReportKey = await ensureHourlyReportKey(database, uid, type, id, today, unix, _unit);
    const ioTransactionPromises = [];
    
    // Find the signal mapped to 'PRODUCTION' (e.g. { "X1": "production" } or { "production": "X1" })
    let productionSignal = null;
    if (inputs && typeof inputs === 'object') {
        if (typeof inputs.production === 'string') {
            productionSignal = inputs.production;
        } else {
            // Fallback to old format
            const normalizedInputs = {};
            for (const [k, v] of Object.entries(inputs)) {
                if (typeof v === 'string') {
                    normalizedInputs[k.toUpperCase()] = v.toUpperCase();
                }
            }
            productionSignal = Object.keys(normalizedInputs).find(key => normalizedInputs[key] === 'PRODUCTION');
        }
    }
    let productionCountIncrement = 0;

    for (const [signal, logs] of Object.entries(digital_values || {})) {
        if (!Array.isArray(logs)) continue;
        const validLogs = logs.filter((entry) => toRange(entry) !== null);

        let countToIncrement = validLogs.length;
        const upperSignal = signal.toUpperCase();
        if (productionSignal && upperSignal === productionSignal.toUpperCase()) {
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
            database.ref(`users/${uid}/reports/${type}/${id}/hourly/${today}/${hourlyReportKey}/digital_values/${signal}`).transaction(txFn)
        );
    }

    ioTransactionPromises.push(
        database.ref(`users/${uid}/reports/${type}/${id}/daily/${today}/digital_values/total`).set(admin.database.ServerValue.increment(productionCountIncrement)),
        database.ref(`users/${uid}/reports/${type}/${id}/hourly/${today}/${hourlyReportKey}/digital_values/total`).set(admin.database.ServerValue.increment(productionCountIncrement))
    );

    await Promise.all(ioTransactionPromises);

    // Call production counting and target checking if type is machines
    if (type === 'machines') {
        const timeDiff = _unit.previousUnix ? (unix - _unit.previousUnix) : 0;
        const safeTimeDiff = (timeDiff < 0 || timeDiff > 3600) ? 0 : timeDiff;

        if (!_unit.targets) _unit.targets = {};
        const targetKey = `${id}&production`;
        if (!_unit.targets[targetKey]) {
            _unit.targets[targetKey] = {
                status: _unit.machines?.[id]?.machine_status ?? false,
                timer: 0,
                pulses: 0,
                previousUnix: unix,
                second_timer: 0
            };
        }
        const target = _unit.targets[targetKey];

        let value = productionCountIncrement;
        if (_unit.machines?.[id]?.min_cycletime && safeTimeDiff && value) {
            const cycletimeTemp = safeTimeDiff / value;
            if (cycletimeTemp <= Number(_unit.machines[id].min_cycletime)) {
                value = 0;
                console.log(`cycletime is less than min_cycletime in ${uid} ${id}: ${cycletimeTemp} <= ${_unit.machines[id].min_cycletime}`);
            }
        }

        if (value === 0) {
            if (_unit.machines?.[id]?.machine_status) {
                target.timer = (target.timer || 0) + safeTimeDiff;
                const idleTimeSet = Number(_unit.machines[id].idle_time_set || 0);
                if (target.timer >= idleTimeSet * 60) {
                    _unit.machines[id].machine_status = false;
                    target.timer = 0;
                    await turnOff(database, id, uid, unit, false, moment.unix(unix).utc().format('YYYY-MM-DD HH:mm:ss'), unix, _unit);
                }
            }
        } else {
            target.timer = 0;
            if (!_unit.machines?.[id]?.machine_status) {
                _unit.machines[id].machine_status = true;
                await turnOn(database, id, uid, unit, false, moment.unix(unix).utc().format('YYYY-MM-DD HH:mm:ss'), unix, _unit);
            }
        }

        target.previousUnix = unix;

        // Run production increment updates
        await countProduction(database, uid, unit, id, value, safeTimeDiff, unix, _unit);
    }
}

module.exports = {
    checkDuplicate,
    verifySequence,
    trackTemperature,
    processPhaseValues,
    processDigitalValues
};
