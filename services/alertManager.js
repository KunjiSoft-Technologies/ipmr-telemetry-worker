const { normalizeThresholds, extractMetrics, evaluateAll } = require('../utils/alertEvaluator');
const { processAlertBatch } = require('../utils/alertTransaction');

async function processAlerts(uid, unit, type, machineId, unix, payload, redis, database, _unit) {
    if (type !== 'machines' || (!payload.timestamp && !payload.phase_values)) return;

    try {
        const pktTimestamp = payload.timestamp || unix;
        const dedupeKey = `alerts:${uid}:dedupe:${machineId}:${pktTimestamp}`;
        const isDuplicate = await redis.set(dedupeKey, "1", "NX", "EX", 300);
        
        // redis.set with NX returns "OK" on success or null on failure (already exists)
        // Let's handle both "OK" (string) or standard truthy checks depending on redis client behavior
        if (isDuplicate !== null && isDuplicate !== undefined && (isDuplicate === "OK" || isDuplicate === true || isDuplicate === 1)) {
            const thresholdKey = `alerts:${uid}:thresholds:${machineId}`;
            let thresholdsRaw = await redis.get(thresholdKey);
            if (thresholdsRaw === null) {
                const snap = await database.ref(`users/${uid}/machineAlertThresholds/${machineId}`).once('value');
                thresholdsRaw = snap.val() || {};
                await redis.set(thresholdKey, JSON.stringify(thresholdsRaw), 'EX', 30);
            } else {
                thresholdsRaw = JSON.parse(thresholdsRaw);
            }

            const actualThresholdConfigs = thresholdsRaw.thresholds || thresholdsRaw;

            const sessionKey = `alerts:${uid}:sessions:${machineId}`;
            let activeSessionsRaw = await redis.get(sessionKey);
            if (activeSessionsRaw === null) {
                const snap = await database.ref(`users/${uid}/alertSessionsActive/${machineId}`).once('value');
                activeSessionsRaw = snap.val() || {};
                await redis.set(sessionKey, JSON.stringify(activeSessionsRaw), 'EX', 60);
            } else {
                activeSessionsRaw = typeof activeSessionsRaw === 'string' ? JSON.parse(activeSessionsRaw) : activeSessionsRaw;
            }

            const hasThresholds = Object.keys(actualThresholdConfigs).length > 0;
            const hasActiveSessions = Object.keys(activeSessionsRaw).length > 0;

            if (hasThresholds || hasActiveSessions) {
                const normalizedThresholds = normalizeThresholds(actualThresholdConfigs);
                const extractedMetrics = extractMetrics(payload);

                const gateVoltage = Number(
                    extractedMetrics.voltage_ln_SUM?.now ??
                    extractedMetrics.voltage_ll_SUM?.now ??
                    0
                );

                const gateVoltageValid = gateVoltage >= 50;

                const evaluationResults = evaluateAll(normalizedThresholds, extractedMetrics, activeSessionsRaw, gateVoltageValid);

                if (Object.keys(evaluationResults).length > 0) {
                    const newActiveSessions = await processAlertBatch(uid, machineId, unix, evaluationResults, normalizedThresholds, activeSessionsRaw);
                    _unit.active_alerts_count = Object.keys(newActiveSessions).length;
                    await redis.set(sessionKey, JSON.stringify(newActiveSessions), 'EX', 60);
                }
            }
        }
    } catch (alertErr) {
        console.error(`Alert processing error for ${machineId}:`, alertErr);
    }
}

module.exports = { processAlerts };
