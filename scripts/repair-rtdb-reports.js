/**
 * Script: repair-rtdb-reports.js
 * 
 * Purpose:
 * Recalculates and repairs the corrupted 1:00 PM electricity usage records for machine_010
 * on factory Q15Ie2n4GkY5uqbW1UJ9375vRF43 for date 2026-11-14, matching the actual physical
 * telemetry readings from InfluxDB.
 * 
 * Usage:
 *   node scripts/repair-rtdb-reports.js            # Dry run (read-only, displays exact diff)
 *   node scripts/repair-rtdb-reports.js --apply    # Applies the changes to RTDB
 */

const fs = require('fs');
const path = require('path');
const serviceAccount = require('c:/Users/shuja/OneDrive/Desktop/projects/ipmr-telemetry-worker/service-account.json');
const admin = require('c:/Users/shuja/OneDrive/Desktop/projects/ipmr-telemetry-worker/node_modules/firebase-admin');

const isApply = process.argv.includes('--apply');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: 'https://industrialpmr-default-rtdb.firebaseio.com'
    });
}
const db = admin.database();

const UID = 'Q15Ie2n4GkY5uqbW1UJ9375vRF43';
const MACHINE_ID = 'machine_010';
const DATE = '2026-11-14';
const MOLD_NAME = 'Panel Inst panel finish od290';

// Precise real kWh calculated from InfluxDB raw Modbus packets for keys 214-225
const REAL_HOURLY_KWH = {
    "214": 0.1,
    "215": 0.1,
    "216": 2.6,
    "217": 0.0,
    "218": 0.8,
    "219": 0.2,
    "220": 7.6,
    "221": 0.5,
    "222": 6.3,
    "223": 1.1,
    "224": 4.4,
    "225": 4.4
};

async function main() {
    console.log(`=======================================================`);
    console.log(` RTDB Energy Anomaly Repair Tool (${isApply ? 'APPLY MODE' : 'DRY RUN'})`);
    console.log(` Factory: ${UID}`);
    console.log(` Machine: ${MACHINE_ID}`);
    console.log(` Date:    ${DATE}`);
    console.log(`=======================================================\n`);

    // 1. Fetch current machine hourly data
    const hourlyRef = db.ref(`users/${UID}/reports/machines/${MACHINE_ID}/hourly/${DATE}`);
    const hourlySnap = await hourlyRef.once('value');
    const hourlyData = hourlySnap.val() || {};

    let totalRecordedHourly = 0;
    let totalTargetHourly = 0;
    const hourlyUpdates = {};

    console.log(`--- Machine Hourly Keys (214 - 225) ---`);
    for (const [keyStr, targetKwh] of Object.entries(REAL_HOURLY_KWH)) {
        const chunk = hourlyData[keyStr];
        if (!chunk) {
            console.warn(`Hourly key ${keyStr} not found in RTDB, skipping.`);
            continue;
        }
        const currentKwh = Number(chunk.electricity_usage || 0);
        totalRecordedHourly += currentKwh;
        totalTargetHourly += targetKwh;

        hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/hourly/${DATE}/${keyStr}/electricity_usage`] = targetKwh;
        if (chunk.accumulators && chunk.accumulators.SUM_WH_Total !== undefined) {
            hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/hourly/${DATE}/${keyStr}/accumulators/SUM_WH_Total`] = targetKwh;
            hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/hourly/${DATE}/${keyStr}/accumulators/SUM_WH_Import`] = targetKwh;
            // Scale VAH and VarH by physical power factor ratio (~1.72)
            hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/hourly/${DATE}/${keyStr}/accumulators/SUM_VAH`] = +(targetKwh * 1.72).toFixed(2);
            hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/hourly/${DATE}/${keyStr}/accumulators/SUM_VarH_Total`] = +(targetKwh * 1.40).toFixed(2);
            hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/hourly/${DATE}/${keyStr}/accumulators/SUM_VarH_Ind`] = +(targetKwh * 1.40).toFixed(2);
        }

        console.log(`Key ${keyStr.padStart(3)}: ${currentKwh.toFixed(1).padStart(7)} kWh -> ${targetKwh.toFixed(1).padStart(5)} kWh (diff: -${(currentKwh - targetKwh).toFixed(1)} kWh)`);
    }

    const deltaToRemove = totalRecordedHourly - totalTargetHourly;
    console.log(`\nTotal Recorded in keys 214-225: ${totalRecordedHourly.toFixed(1)} kWh`);
    console.log(`Total Corrected from InfluxDB:  ${totalTargetHourly.toFixed(1)} kWh`);
    console.log(`Total Phantom Delta to Remove:  -${deltaToRemove.toFixed(1)} kWh\n`);

    // 2. Fetch machine daily total
    const machineDailyRef = db.ref(`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/total`);
    const machineDailySnap = await machineDailyRef.once('value');
    const machineDailyTotal = machineDailySnap.val() || {};
    const currMachineDailyKwh = Number(machineDailyTotal.electricity_usage || 0);
    const newMachineDailyKwh = +(currMachineDailyKwh - deltaToRemove).toFixed(2);

    console.log(`--- Machine Daily Total ---`);
    console.log(`Current Daily Electricity: ${currMachineDailyKwh.toFixed(1)} kWh`);
    console.log(`Corrected Daily Electricity: ${newMachineDailyKwh.toFixed(1)} kWh`);

    hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/total/electricity_usage`] = newMachineDailyKwh;
    if (machineDailyTotal.accumulators?.SUM_WH_Total !== undefined) {
        hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/total/accumulators/SUM_WH_Total`] = newMachineDailyKwh;
        hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/total/accumulators/SUM_WH_Import`] = newMachineDailyKwh;
        const currVah = Number(machineDailyTotal.accumulators.SUM_VAH || 0);
        const currVarh = Number(machineDailyTotal.accumulators.SUM_VarH_Ind || 0);
        hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/total/accumulators/SUM_VAH`] = Math.max(0, +(currVah - (deltaToRemove * 1.72)).toFixed(2));
        hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/total/accumulators/SUM_VarH_Total`] = Math.max(0, +(currVarh - (deltaToRemove * 1.40)).toFixed(2));
        hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/total/accumulators/SUM_VarH_Ind`] = Math.max(0, +(currVarh - (deltaToRemove * 1.40)).toFixed(2));
    }

    // 3. Fetch mold daily stats
    const moldDailyRef = db.ref(`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/molds/${MOLD_NAME}/stats`);
    const moldDailySnap = await moldDailyRef.once('value');
    const moldDailyStats = moldDailySnap.val() || {};
    const currMoldKwh = Number(moldDailyStats.electricity_usage || 0);
    const newMoldKwh = +(currMoldKwh - deltaToRemove).toFixed(2);

    console.log(`\n--- Mold Stats (${MOLD_NAME}) ---`);
    console.log(`Current Mold Electricity: ${currMoldKwh.toFixed(1)} kWh`);
    console.log(`Corrected Mold Electricity: ${newMoldKwh.toFixed(1)} kWh`);

    hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/molds/${MOLD_NAME}/stats/electricity_usage`] = newMoldKwh;
    if (moldDailyStats.accumulators?.SUM_WH_Total !== undefined) {
        hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/molds/${MOLD_NAME}/stats/accumulators/SUM_WH_Total`] = newMoldKwh;
        hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/molds/${MOLD_NAME}/stats/accumulators/SUM_WH_Import`] = newMoldKwh;
        const currVah = Number(moldDailyStats.accumulators.SUM_VAH || 0);
        const currVarh = Number(moldDailyStats.accumulators.SUM_VarH_Ind || 0);
        hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/molds/${MOLD_NAME}/stats/accumulators/SUM_VAH`] = Math.max(0, +(currVah - (deltaToRemove * 1.72)).toFixed(2));
        hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/molds/${MOLD_NAME}/stats/accumulators/SUM_VarH_Total`] = Math.max(0, +(currVarh - (deltaToRemove * 1.40)).toFixed(2));
        hourlyUpdates[`users/${UID}/reports/machines/${MACHINE_ID}/daily/${DATE}/molds/${MOLD_NAME}/stats/accumulators/SUM_VarH_Ind`] = Math.max(0, +(currVarh - (deltaToRemove * 1.40)).toFixed(2));
    }

    // 4. Fetch factory hourly report for Hour 7
    const factoryHour7Ref = db.ref(`users/${UID}/reports/factory/hourly/${DATE}/7/machines/${MACHINE_ID}`);
    const factoryHour7Snap = await factoryHour7Ref.once('value');
    const currFactoryHour7Kwh = Number(factoryHour7Snap.val()?.electricity_usage || 0);
    const newFactoryHour7Kwh = +(currFactoryHour7Kwh - deltaToRemove).toFixed(2);

    console.log(`\n--- Factory Hourly Report (Hour 7) ---`);
    console.log(`Current Hour 7 Machine Electricity: ${currFactoryHour7Kwh.toFixed(1)} kWh`);
    console.log(`Corrected Hour 7 Machine Electricity: ${newFactoryHour7Kwh.toFixed(1)} kWh`);

    hourlyUpdates[`users/${UID}/reports/factory/hourly/${DATE}/7/machines/${MACHINE_ID}/electricity_usage`] = newFactoryHour7Kwh;

    // 5. Fetch factory daily total
    const factoryDailyRef = db.ref(`users/${UID}/reports/factory/daily/${DATE}`);
    const factoryDailySnap = await factoryDailyRef.once('value');
    const factoryDaily = factoryDailySnap.val() || {};
    const currFactoryDailyKwh = Number(factoryDaily.electricity_usage || 0);
    const newFactoryDailyKwh = +(currFactoryDailyKwh - deltaToRemove).toFixed(2);

    console.log(`\n--- Factory Daily Total ---`);
    console.log(`Current Factory Daily Electricity: ${currFactoryDailyKwh.toFixed(1)} kWh`);
    console.log(`Corrected Factory Daily Electricity: ${newFactoryDailyKwh.toFixed(1)} kWh`);

    hourlyUpdates[`users/${UID}/reports/factory/daily/${DATE}/electricity_usage`] = newFactoryDailyKwh;
    if (factoryDaily.accumulators?.SUM_WH_Total !== undefined) {
        hourlyUpdates[`users/${UID}/reports/factory/daily/${DATE}/accumulators/SUM_WH_Total`] = newFactoryDailyKwh;
        hourlyUpdates[`users/${UID}/reports/factory/daily/${DATE}/accumulators/SUM_WH_Import`] = newFactoryDailyKwh;
        const currVah = Number(factoryDaily.accumulators.SUM_VAH || 0);
        const currVarh = Number(factoryDaily.accumulators.SUM_VarH_Ind || 0);
        hourlyUpdates[`users/${UID}/reports/factory/daily/${DATE}/accumulators/SUM_VAH`] = Math.max(0, +(currVah - (deltaToRemove * 1.72)).toFixed(2));
        hourlyUpdates[`users/${UID}/reports/factory/daily/${DATE}/accumulators/SUM_VarH_Total`] = Math.max(0, +(currVarh - (deltaToRemove * 1.40)).toFixed(2));
        hourlyUpdates[`users/${UID}/reports/factory/daily/${DATE}/accumulators/SUM_VarH_Ind`] = Math.max(0, +(currVarh - (deltaToRemove * 1.40)).toFixed(2));
    }

    console.log(`\n=======================================================`);
    console.log(`Total Database Paths to Update: ${Object.keys(hourlyUpdates).length}`);
    if (isApply) {
        console.log(`Applying updates atomically to Firebase RTDB...`);
        await db.ref().update(hourlyUpdates);
        console.log(`✓ ALL UPDATES APPLIED SUCCESSFULLY!`);
    } else {
        console.log(`DRY RUN COMPLETE — Zero changes written to database.`);
        console.log(`To apply these changes, run with: node scripts/repair-rtdb-reports.js --apply`);
    }
    console.log(`=======================================================`);

    process.exit(0);
}

main().catch(err => {
    console.error(`FATAL ERROR:`, err);
    process.exit(1);
});

