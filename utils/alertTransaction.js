const admin = require('firebase-admin');
const { update, set, get, withTimeout } = require('./api');
const database = require('../config/database');
const moment = require('moment');

const PARAM_MAPPING = {
    'voltage_ln_SUM': { param: 'Voltage L-N', phase: 'SUM' },
    'voltage_ll_SUM': { param: 'Voltage L-L', phase: 'SUM' },
    'current_R': { param: 'Current', phase: 'R' },
    'current_S': { param: 'Current', phase: 'S' },
    'current_T': { param: 'Current', phase: 'T' },
    'pf_SUM': { param: 'Power Factor', phase: 'SUM' },
    'thd_v_SUM': { param: 'Voltage THD', phase: 'SUM' },
    'thd_a_SUM': { param: 'Current THD', phase: 'SUM' }
};

/**
 * Process all alert evaluations for a unit in a single batched Firebase update.
 */
const processAlertBatch = async (uid, machineId, unix, evaluationResults, configs, activeSessions) => {
    const updates = {};
    const statsUpdates = [];
    const newActiveSessions = { ...activeSessions };
    const dateKey = moment.unix(unix).format('YYYY-MM-DD');

    for (const [param, actionInfo] of Object.entries(evaluationResults)) {
        const { action, type, value } = actionInfo;
        const config = configs[param];
        const sessionKey = `${param}_${type || activeSessions[`${param}_max`]?.thresholdType || activeSessions[`${param}_min`]?.thresholdType}`;
        const activeSession = activeSessions[sessionKey] || activeSessions[`${param}_max`] || activeSessions[`${param}_min`];

        if (action === 'OPEN') {
            if (!activeSession) {
                const incidentId = database.ref().push().key;

                // 1. Create Active Session
                const newSession = {
                    incidentId,
                    parameterId: param,
                    thresholdType: type,
                    startTime: unix,
                    peakValue: value,
                    severity: config.severity
                };
                updates[`users/${uid}/alertSessionsActive/${machineId}/${param}_${type}`] = newSession;
                newActiveSessions[`${param}_${type}`] = newSession;

                // 2. Create Incident
                const { param: paramName, phase } = PARAM_MAPPING[param] || { param: param, phase: '' };
                const incident = {
                    machineId: machineId,
                    parameter: paramName,
                    parameterId: param,
                    phase,
                    thresholdType: type,
                    thresholdValue: type === 'max' ? config.max : config.min,
                    actualValue: value,
                    peakValue: value,
                    severity: config.severity,
                    startTime: unix,
                    endTime: null,
                    duration: 0,
                    status: 'active',
                    occurrenceCount: 1,
                    snoozedBy: null, snoozedAt: null, snoozedUntil: null, snoozeReason: null,
                    acknowledgedBy: null, acknowledgedAt: null, notes: null,
                    correlationType: null
                };
                updates[`users/${uid}/alertIncidents/${machineId}/${incidentId}`] = incident;
            }
        }
        else if (action === 'UPDATE_PEAK') {
            if (activeSession) {
                let newPeak = activeSession.peakValue;
                if (type === 'min') newPeak = Math.min(newPeak, value);
                else newPeak = Math.max(newPeak, value);

                if (newPeak !== activeSession.peakValue) {
                    const sessionPath = `users/${uid}/alertSessionsActive/${machineId}/${activeSession.parameterId}_${activeSession.thresholdType}`;
                    updates[`${sessionPath}/peakValue`] = newPeak;
                    newActiveSessions[`${activeSession.parameterId}_${activeSession.thresholdType}`].peakValue = newPeak;

                    const incidentPath = `users/${uid}/alertIncidents/${machineId}/${activeSession.incidentId}`;
                    updates[`${incidentPath}/peakValue`] = newPeak;
                }

                // Need to update the incident actualValue too
                updates[`users/${uid}/alertIncidents/${machineId}/${activeSession.incidentId}/actualValue`] = value;
            }
        }
        else if (action === 'RESOLVE') {
            if (activeSession) {
                const duration = unix - activeSession.startTime;
                const incidentPath = `users/${uid}/alertIncidents/${machineId}/${activeSession.incidentId}`;

                // 1. Delete Active Session
                updates[`users/${uid}/alertSessionsActive/${machineId}/${activeSession.parameterId}_${activeSession.thresholdType}`] = null;
                delete newActiveSessions[`${activeSession.parameterId}_${activeSession.thresholdType}`];

                // 2. Resolve Incident
                updates[`${incidentPath}/endTime`] = unix;
                updates[`${incidentPath}/duration`] = duration;
                updates[`${incidentPath}/status`] = 'resolved';
                updates[`${incidentPath}/actualValue`] = value;

                // 3. Queue Stats Update
                statsUpdates.push({
                    param, duration, dateKey
                });
            }
        }
    }

    if (Object.keys(updates).length > 0) {
        await withTimeout(database.ref().update(updates), 'update(alertIncidents)');
    }

    // Process stats separately using transactions since max/avg require atomic reads
    const statPromises = statsUpdates.map(async (stat) => {
        const statPath = `users/${uid}/alertStats/${machineId}/${stat.dateKey}_${stat.param}`;
        await withTimeout(database.ref(statPath).transaction((currentData) => {
            if (currentData === null) {
                const { param: paramName, phase } = PARAM_MAPPING[stat.param] || { param: stat.param, phase: '' };
                return {
                    machineId: machineId,
                    parameter: paramName,
                    parameterId: stat.param,
                    phase,
                    date: stat.dateKey,
                    occurrences: 1,
                    totalDuration: stat.duration,
                    avgDuration: stat.duration,
                    maxDuration: stat.duration
                };
            } else {
                currentData.occurrences += 1;
                currentData.totalDuration += stat.duration;
                currentData.avgDuration = Math.round(currentData.totalDuration / currentData.occurrences);
                currentData.maxDuration = Math.max(currentData.maxDuration, stat.duration);
                return currentData;
            }
        }), `transaction(alertStats/${stat.param})`);
    });

    if (statPromises.length > 0) {
        await Promise.all(statPromises);
    }

    return newActiveSessions;
};

module.exports = {
    processAlertBatch
};
