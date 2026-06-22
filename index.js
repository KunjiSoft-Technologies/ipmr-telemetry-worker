require('dotenv').config();
const { PubSub } = require('@google-cloud/pubsub');
const database = require('./config/database');
const redis = require('./config/redis');
const { writeInfluxRecord } = require('./config/Influx');
const { lookupMacAndUnit, saveUnitToCache } = require('./services/macLookup');
const {
    checkDuplicate,
    verifySequence,
    trackTemperature,
    processPhaseValues,
    processDigitalValues
} = require('./services/telemetryProcessor');
const { processAlerts } = require('./services/alertManager');
const { normalizePayload } = require('./utils/payloadNormalizer');

// Initialize Pub/Sub Client
const pubsub = new PubSub();
const subscriptionName = process.env.PUBSUB_SUBSCRIPTION_NAME || 'ipmr-v2-records-pipeline-sub';

console.log(`Starting ipmr-telemetry-worker...`);
console.log(`Listening to Pub/Sub Subscription: ${subscriptionName}`);

const subscription = pubsub.subscription(subscriptionName, {
    enableMessageOrdering: true
});

/**
 * Message handler for incoming Pub/Sub telemetry packets.
 */
async function handleMessage(message) {
    const attributes = message.attributes || {};
    const mac = attributes.machine_id;
    const unixStr = attributes.timestamp;

    if (!mac) {
        console.warn('Received message without machine_id attribute. Acknowledging and skipping.');
        message.ack();
        return;
    }

    const unix = unixStr ? Number(unixStr) : Math.floor(Date.now() / 1000);

    let payload = {};
    try {
        payload = JSON.parse(message.data.toString());
        payload = normalizePayload(payload);
    } catch (err) {
        console.error('Failed to parse message payload JSON. Acknowledging and skipping.', err);
        message.ack();
        return;
    }

    let success = true;
    let uid = null;
    let unit = null;
    let connection = null;
    let _unit = null;

    try {
        // 3. Check and load/initialize the _unit object
        const lookupResult = await lookupMacAndUnit(mac);
        if (!lookupResult) {
            console.warn(`Unmapped MAC address: ${mac}. Acknowledging and skipping.`);
            message.ack();
            return;
        }

        uid = lookupResult.uid;
        unit = lookupResult.unit;
        connection = lookupResult.connection;
        _unit = lookupResult._unit;

        // 4. Perform duplicate packet checking
        const isDuplicate = await checkDuplicate(database, uid, unit, unix, _unit, redis, saveUnitToCache);
        if (isDuplicate) {
            console.log(`Duplicate/late packet received for MAC ${mac} (unix: ${unix}). Acknowledging and skipping.`);
            message.ack();
            return;
        }

        // 5. Perform packet ID sequencing check
        await verifySequence(database, uid, unit, payload, _unit);

        // 6. Process temperature tracking
        const temperature = await trackTemperature(database, uid, unit, payload);

        // 7 & 8. Process daily/hourly statistics if connection details are present
        if (connection && connection.type && connection.id) {
            if (payload.phase_values) {
                await processPhaseValues(database, uid, unit, connection.type, connection.id, payload.phase_values, unix, _unit);
            }
            if (connection.type === 'machines' || payload.digital_values) {
                await processDigitalValues(database, uid, unit, connection.type, connection.id, payload.digital_values || {}, unix, _unit);
            }
            // Save targets back to RTDB
            if (_unit.targets) {
                await database.ref(`/users/${uid}/targets/${unit}`).set(_unit.targets);
            }
        }

        // 9. Evaluate alerts
        if (connection && connection.type && connection.id) {
            await processAlerts(uid, unit, connection.type, connection.id, unix, payload, redis, database, _unit);
        }

        // 10. Write telemetry record to InfluxDB
        const realtime = !_unit.uploadingPrev?.status;
        const values = payload.values || { "60_a": 0 };
        const now_values = payload.now_values || {};
        const active_alerts = _unit.active_alerts_count || 0;

        await writeInfluxRecord(uid, unit, {
            success,
            realtime,
            values,
            now_values,
            unix,
            temperature,
            active_alerts
        });

        // 11. Save the updated _unit back in Redis cache
        await saveUnitToCache(uid, unit, _unit);

        // 12. Acknowledge message
        message.ack();
        console.log(`Successfully processed packet for MAC ${mac} (uid: ${uid}, unit: ${unit}) at unix ${unix}`);
    } catch (error) {
        console.error(`Error processing packet for MAC ${mac}:`, error);
        success = false;

        // Attempt to write failure record to InfluxDB if uid and unit were resolved
        if (uid && unit) {
            try {
                const realtime = _unit ? !_unit.uploadingPrev?.status : true;
                const values = payload.values || { "60_a": 0 };
                const now_values = payload.now_values || {};
                const active_alerts = _unit ? (_unit.active_alerts_count || 0) : 0;
                const temperature = payload.analog_values?.temperature?.now !== undefined
                    ? payload.analog_values.temperature.now
                    : payload.temp;

                await writeInfluxRecord(uid, unit, {
                    success,
                    realtime,
                    values,
                    now_values,
                    unix,
                    temperature,
                    active_alerts
                });
            } catch (influxErr) {
                console.error('Failed to write failure log to InfluxDB:', influxErr);
            }
        }

        // Nack to schedule redelivery
        message.nack();
    }
}

// Subscribe to messages
subscription.on('message', handleMessage);

// Handle errors
subscription.on('error', (error) => {
    console.error(`Pub/Sub Subscription Error:`, error);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM signal received. Closing subscription listener...');
    subscription.close().then(() => {
        console.log('Pub/Sub subscriber closed.');
        process.exit(0);
    });
});
