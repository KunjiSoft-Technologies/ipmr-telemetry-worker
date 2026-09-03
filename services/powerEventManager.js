const admin = require('firebase-admin');
const moment = require('moment-timezone');
const { getLocalMoment, getToday, whatHour, secToTime } = require('../utils/timeHelpers');

/**
 * Calculates and persists power-off sessions, machine downtime, and production target downtime.
 * Matches legacy calculateUnitOff logic from industrialpmr-rest-middleware.
 * 
 * @param {Object} database - Firebase RTDB admin database instance
 * @param {string} uid - User ID
 * @param {string|number} unit - Unit identifier
 * @param {number} unit_off - Unix timestamp when power turned OFF
 * @param {number} unix - Unix timestamp when power turned back ON (boot time)
 * @param {Object} _unit - In-memory unit context object
 */
async function calculateUnitOff(database, uid, unit, unit_off, unix, _unit) {
    try {
        const today = getToday(uid, unix, _unit);
        const startDay = getToday(uid, unit_off, _unit);
        const startHour = whatHour(uid, unit_off, _unit);
        const endHour = whatHour(uid, unix, _unit);
        const sameDay = today === startDay;

        if (sameDay) {
            const offDuration = unix - unit_off;
            const promises = [
                database.ref(`users/${uid}/reports/factory/daily/${today}/unit_power/${unit}/sessions`).push({
                    off: unit_off,
                    on: unix
                }),
                database.ref(`users/${uid}/reports/factory/daily/${today}/unit_power/${unit}/total`).set(
                    admin.database.ServerValue.increment(offDuration)
                )
            ];
            await Promise.all(promises);

            const machinePromises = [];
            for (const machineKey in _unit?.machines || {}) {
                const machineObj = _unit.machines[machineKey];
                const mold = machineObj.installedMold ? machineObj.installedMold.name : machineObj.mold_name;
                const monitorDowntime = !!machineObj?.["monitor-downtime"];

                if (monitorDowntime) {
                    machinePromises.push(
                        database.ref(`users/${uid}/downtime/${machineKey}`).push({
                            start: unit_off,
                            end: unix,
                            status: "OFF"
                        }).catch(err => console.error("ERROR IN downtimeFunc: " + err))
                    );
                }

                if (mold && mold !== "NA") {
                    machinePromises.push(
                        database.ref(`users/${uid}/production-targets/active/${machineKey}/${mold}/hours`).transaction((hours) => {
                            if (hours === null) return null;
                            for (let i = startHour; i <= endHour; i++) {
                                if (i === startHour && i === endHour) {
                                    // same hour
                                    const downtime = unix - unit_off;
                                    if (hours[`${today}-${i}`]) {
                                        hours[`${today}-${i}`].downtime = (hours[`${today}-${i}`].downtime || 0) + downtime;
                                    } else {
                                        hours[`${today}-${i}`] = {
                                            production: 0,
                                            ontime: 0,
                                            downtime
                                        };
                                    }
                                } else if (i === startHour) {
                                    // first hour
                                    const end = secToTime(Number(_unit.info?.shift_a_start || 0) + (Number(startHour) * 3600));
                                    const endUnix = moment.utc(`${startDay} ${end}:00`, "YYYY-MM-DD HH:mm:ss").unix();
                                    const downtime = endUnix - unit_off;
                                    if (hours[`${startDay}-${i}`]) {
                                        hours[`${startDay}-${i}`].downtime = (hours[`${startDay}-${i}`].downtime || 0) + downtime;
                                    } else {
                                        hours[`${startDay}-${i}`] = {
                                            production: 0,
                                            ontime: 0,
                                            downtime
                                        };
                                    }
                                } else if (i === endHour) {
                                    // last hour
                                    const start = secToTime(Number(_unit.info?.shift_a_start || 0) + ((Number(endHour) - 1) * 3600));
                                    const startUnix = moment.utc(`${today} ${start}:00`, "YYYY-MM-DD HH:mm:ss").unix();
                                    const downtime = unix - startUnix;
                                    if (hours[`${today}-${i}`]) {
                                        hours[`${today}-${i}`].downtime = (hours[`${today}-${i}`].downtime || 0) + downtime;
                                    } else {
                                        hours[`${today}-${i}`] = {
                                            production: 0,
                                            ontime: 0,
                                            downtime
                                        };
                                    }
                                } else {
                                    // in between
                                    hours[`${today}-${i}`] = {
                                        production: hours[`${today}-${i}`]?.production || 0,
                                        ontime: hours[`${today}-${i}`]?.ontime || 0,
                                        downtime: (hours[`${today}-${i}`]?.downtime || 0) + 3600
                                    };
                                }
                            }
                            return hours;
                        }).catch(err => console.error("ERROR IN calculateUnitOff in target set: " + err))
                    );

                    const month = moment(today).format("YYYY-MM");
                    machinePromises.push(
                        database.ref(`users/${uid}/production-targets/statistics/${month}/machines/${machineKey}/${mold}`).update({
                            downtime: admin.database.ServerValue.increment(offDuration)
                        }).catch(err => console.error("ERROR IN calculateUnitOff target statistics update: " + err))
                    );
                }
            }
            try {
                await Promise.all(machinePromises);
            } catch (err) {
                console.error("ERROR IN calculateUnitOff machine processing: " + err);
            }
        } else {
            const promises = [];
            const shiftStartSec = Number(_unit.info?.shift_a_start || 0);

            // from unit_off to day end
            const firstDayoffTill = moment.utc(`${moment(startDay).add(1, "day").format("YYYY-MM-DD")} ${secToTime(shiftStartSec)}:00`, "YYYY-MM-DD HH:mm:ss").unix();
            const firstDayOffDuration = firstDayoffTill - unit_off;
            promises.push(
                database.ref(`users/${uid}/reports/factory/daily/${startDay}/unit_power/${unit}/sessions`).push({
                    off: unit_off,
                    on: firstDayoffTill
                })
            );
            promises.push(
                database.ref(`users/${uid}/reports/factory/daily/${startDay}/unit_power/${unit}/total`).set(
                    admin.database.ServerValue.increment(firstDayOffDuration)
                )
            );

            // in between days if outage spanned multiple days
            const daysDiff = moment(today).diff(moment(startDay), 'days');
            for (let d = 1; d < daysDiff; d++) {
                const midDay = moment(startDay).add(d, 'days').format('YYYY-MM-DD');
                const midDayStart = moment.utc(`${midDay} ${secToTime(shiftStartSec)}:00`, "YYYY-MM-DD HH:mm:ss").unix();
                const midDayEnd = midDayStart + 86400;
                promises.push(
                    database.ref(`users/${uid}/reports/factory/daily/${midDay}/unit_power/${unit}/sessions`).push({
                        off: midDayStart,
                        on: midDayEnd
                    })
                );
                promises.push(
                    database.ref(`users/${uid}/reports/factory/daily/${midDay}/unit_power/${unit}/total`).set(
                        admin.database.ServerValue.increment(86400)
                    )
                );
            }

            // second day
            const secondDayStartFrom = moment.utc(`${today} ${secToTime(shiftStartSec)}:00`, "YYYY-MM-DD HH:mm:ss").unix();
            const secondDayOffDuration = unix - secondDayStartFrom;
            promises.push(
                database.ref(`users/${uid}/reports/factory/daily/${today}/unit_power/${unit}/sessions`).push({
                    off: secondDayStartFrom,
                    on: unix
                })
            );
            promises.push(
                database.ref(`users/${uid}/reports/factory/daily/${today}/unit_power/${unit}/total`).set(
                    admin.database.ServerValue.increment(secondDayOffDuration)
                )
            );
            await Promise.all(promises);

            const machinePromises = [];
            for (const machineKey in _unit?.machines || {}) {
                const machineObj = _unit.machines[machineKey];
                const mold = machineObj.installedMold ? machineObj.installedMold.name : machineObj.mold_name;
                const monitorDowntime = !!machineObj?.["monitor-downtime"];

                if (monitorDowntime) {
                    machinePromises.push(
                        database.ref(`users/${uid}/downtime/${machineKey}`).push({
                            start: unit_off,
                            end: unix,
                            status: "OFF"
                        }).catch(err => console.error("ERROR IN downtimeFunc: " + err))
                    );
                }

                if (mold && mold !== "NA") {
                    machinePromises.push(
                        database.ref(`users/${uid}/production-targets/active/${machineKey}/${mold}/hours`).transaction((hours) => {
                            if (hours === null) return null;
                            for (let i = 0; i <= daysDiff; i++) {
                                const day = moment(startDay).add(i, "days").format("YYYY-MM-DD");
                                for (let j = 1; j <= 24; j++) {
                                    if (i === 0 && j === startHour) {
                                        // first day first hour
                                        const end = secToTime(shiftStartSec + (Number(startHour) * 3600));
                                        const endUnix = moment.utc(`${startDay} ${end}:00`, "YYYY-MM-DD HH:mm:ss").unix();
                                        const downtime = endUnix - unit_off;
                                        if (hours[`${startDay}-${j}`]) {
                                            hours[`${startDay}-${j}`].downtime = (hours[`${startDay}-${j}`].downtime || 0) + downtime;
                                        } else {
                                            hours[`${startDay}-${j}`] = {
                                                production: 0,
                                                ontime: 0,
                                                downtime
                                            };
                                        }
                                    } else if (i === daysDiff && j === endHour) {
                                        // last day last hour
                                        const start = secToTime(shiftStartSec + ((Number(endHour) - 1) * 3600));
                                        const startUnix = moment.utc(`${today} ${start}:00`, "YYYY-MM-DD HH:mm:ss").unix();
                                        const downtime = unix - startUnix;
                                        if (hours[`${today}-${j}`]) {
                                            hours[`${today}-${j}`].downtime = (hours[`${today}-${j}`].downtime || 0) + downtime;
                                        } else {
                                            hours[`${today}-${j}`] = {
                                                production: 0,
                                                ontime: 0,
                                                downtime
                                            };
                                        }
                                    } else if ((i === 0 && j > startHour) || (i === daysDiff && j < endHour) || (i > 0 && i < daysDiff)) {
                                        // in between
                                        hours[`${day}-${j}`] = {
                                            production: hours[`${day}-${j}`]?.production || 0,
                                            ontime: hours[`${day}-${j}`]?.ontime || 0,
                                            downtime: (hours[`${day}-${j}`]?.downtime || 0) + 3600
                                        };
                                    }
                                }
                            }
                            return hours;
                        }).catch(err => console.error("ERROR IN calculateUnitOff in target set: " + err))
                    );

                    const endMonth = moment(today).format("YYYY-MM");
                    const startMonth = moment(startDay).format("YYYY-MM");
                    if (startMonth === endMonth) {
                        const totalOffDuration = unix - unit_off;
                        machinePromises.push(
                            database.ref(`users/${uid}/production-targets/statistics/${startMonth}/machines/${machineKey}/${mold}`).update({
                                downtime: admin.database.ServerValue.increment(totalOffDuration)
                            }).catch(err => console.error("ERROR IN calculateUnitOff target statistics update: " + err))
                        );
                    } else {
                        const months = moment(today).diff(moment(startDay), "month");
                        for (let m = 0; m <= months; m++) {
                            const month = moment(startDay).add(m, "month").format("YYYY-MM");
                            let duration = 0;
                            if (month === startMonth) {
                                const start = unit_off;
                                const end = moment.utc(startDay).add(1, "month").startOf("month").unix() + shiftStartSec;
                                duration = end - start;
                            } else if (month === endMonth) {
                                const start = moment.utc(today).startOf("month").unix() + shiftStartSec;
                                const end = unix;
                                duration = end - start;
                            } else {
                                const curMonthStart = moment.utc(startDay).add(m, "month").startOf("month").unix();
                                const curMonthEnd = moment.utc(startDay).add(m, "month").endOf("month").unix();
                                duration = curMonthEnd - curMonthStart;
                            }
                            if (duration > 0) {
                                machinePromises.push(
                                    database.ref(`users/${uid}/production-targets/statistics/${month}/machines/${machineKey}/${mold}`).update({
                                        downtime: admin.database.ServerValue.increment(duration)
                                    }).catch(err => console.error("ERROR IN calculateUnitOff target statistics update: " + err))
                                );
                            }
                        }
                    }
                }
            }
            try {
                await Promise.all(machinePromises);
            } catch (err) {
                console.error("ERROR IN calculateUnitOff machine processing: " + err);
            }
        }
    } catch (err) {
        console.error("ERROR IN calculateUnitOff: " + err);
    }
}

/**
 * Handles incoming Power Event ("pe") object from telemetry packet.
 * Writes records to electricity_report_new, users/info, offlineElectricityTrack,
 * and triggers calculateUnitOff for daily unit_power and machine downtime.
 * 
 * @param {Object} database - Firebase RTDB admin database instance
 * @param {string} uid - User ID
 * @param {string|number} unit - Unit identifier
 * @param {Object} pe - Power Event object, e.g. { OFF: 1785247800, ON: 1785247860 }
 * @param {Object} _unit - In-memory unit context object
 */
async function processPowerEvent(database, uid, unit, pe, _unit) {
    try {
        if (!pe || typeof pe !== 'object') return;
        const unit_off = Number(pe.OFF !== undefined ? pe.OFF : pe.off);
        const unit_on = Number(pe.ON !== undefined ? pe.ON : pe.on);

        if (!unit_off || !unit_on || isNaN(unit_off) || isNaN(unit_on) || unit_off <= 0 || unit_on <= 0) {
            console.warn(`[PowerEvent] Invalid timestamps for unit ${unit}: OFF=${pe.OFF || pe.off}, ON=${pe.ON || pe.on}`);
            return;
        }

        if (unit_off >= unit_on) {
            console.warn(`[PowerEvent] OFF (${unit_off}) is not strictly before ON (${unit_on}) for unit ${unit}`);
            return;
        }

        // Idempotency check: avoid duplicate writes if packet is retried or re-delivered
        if (_unit?._lastProcessedPowerEvent &&
            _unit._lastProcessedPowerEvent.off === unit_off &&
            _unit._lastProcessedPowerEvent.on === unit_on) {
            console.log(`[PowerEvent] Power event (OFF: ${unit_off}, ON: ${unit_on}) already processed for unit ${unit}. Skipping.`);
            return;
        }

        const offMoment = getLocalMoment(unit_off, _unit);
        const onMoment = getLocalMoment(unit_on, _unit);

        const offDate = offMoment.format('YYYY-MM-DD');
        const offTime = offMoment.format('HH:mm:ss');
        const onDate = onMoment.format('YYYY-MM-DD');
        const onTime = onMoment.format('HH:mm:ss');

        const offDuration = unit_on - unit_off;

        console.log(`[PowerEvent] Processing power event for unit ${unit}: OFF at ${offDate} ${offTime} (${unit_off}), ON at ${onDate} ${onTime} (${unit_on}), duration: ${offDuration}s`);

        // 1. Push both OFF and ON records to electricity_report_new
        const reportPromises = [
            database.ref(`users/${uid}/electricity_report_new/${unit}/${offDate}/${offTime}`).set({
                activity: 'off',
                offtime: 0
            }),
            database.ref(`users/${uid}/electricity_report_new/${unit}/${onDate}/${onTime}`).set({
                activity: 'on',
                offtime: offDuration
            }),
            // 2. Set info/off_at and info/on_at in RTDB
            database.ref(`users/${uid}/info`).update({
                off_at: unit_off,
                on_at: unit_on
            }),
            // 3. Remove legacy users/${uid}/units/${unit}/unit_off
            database.ref(`users/${uid}/units/${unit}/unit_off`).remove()
        ];
        await Promise.all(reportPromises);

        // 4. Update offlineElectricityTrack and sync in-memory tracking
        if (!_unit.offlineElectricityTrack || !Array.isArray(_unit.offlineElectricityTrack)) {
            _unit.offlineElectricityTrack = [];
        }
        _unit.offlineElectricityTrack.push({
            off: unit_off,
            on: unit_on
        });
        await database.ref(`users/${uid}/offlineElectricityTrack/${unit}`).set(_unit.offlineElectricityTrack);

        // 5. Run calculateUnitOff for daily unit_power reports, machine downtime and targets
        await calculateUnitOff(database, uid, unit, unit_off, unit_on, _unit);

        // 6. Align in-memory previousUnix to unit_on to prevent large artificial deltas
        _unit.previousUnix = unit_on;
        if (_unit.targets && typeof _unit.targets === 'object') {
            for (const targetKey of Object.keys(_unit.targets)) {
                if (_unit.targets[targetKey]) {
                    _unit.targets[targetKey].previousUnix = unit_on;
                }
            }
        }

        // Record last processed event for idempotency
        _unit._lastProcessedPowerEvent = {
            off: unit_off,
            on: unit_on
        };
    } catch (err) {
        console.error(`[PowerEvent] Error processing power event for unit ${unit}:`, err);
    }
}

module.exports = {
    processPowerEvent,
    calculateUnitOff
};
