/**
 * Script: repair_16nov_outage.js
 * 
 * Purpose:
 * Safely backfills missing morning carryover shutdown chunks and fixes daily shutdown_time
 * for factory Q15Ie2n4GkY5uqbW1UJ9375vRF43 for date 2026-11-16.
 * 
 * Safety:
 * - Defaults to DRY RUN (read-only) unless --apply is passed.
 * - Preserves ALL existing production, ontime, offtime, electricity, shots, accumulators, and molds.
 * 
 * Usage:
 *   node scripts/repair_16nov_outage.js            # Dry run (displays exact diff)
 *   node scripts/repair_16nov_outage.js --apply    # Applies the changes to RTDB
 */

const admin = require('firebase-admin');
const moment = require('moment-timezone');
const serviceAccount = require('../service-account.json');

const isApply = process.argv.includes('--apply');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: 'https://industrialpmr-default-rtdb.firebaseio.com'
    });
}

const db = admin.database();
const UID = 'Q15Ie2n4GkY5uqbW1UJ9375vRF43';
const DATE = '2026-11-16';
const SHIFT_START_SEC = 25200; // 07:00 AM (07:00:00)
const SHIFT_START_UNIX = 1794812400; // 2026-11-16 07:00:00 UTC

async function main() {
    console.log(`========================================================================`);
    console.log(` 16-NOV-2026 OUTAGE DATA REPAIR (${isApply ? '*** APPLY MODE ***' : 'DRY RUN - READ ONLY'})`);
    console.log(` Factory UID: ${UID}`);
    console.log(` Date:        ${DATE}`);
    console.log(`========================================================================\n`);

    // 1. Fetch factory daily report
    const factoryDailySnap = await db.ref(`users/${UID}/reports/factory/daily/${DATE}`).once('value');
    const factoryDaily = factoryDailySnap.val();
    if (!factoryDaily) {
        console.error(`Factory daily report for ${DATE} not found!`);
        process.exit(1);
    }

    const unitPower = factoryDaily.unit_power || {};

    // 2. Fetch machines
    const machinesSnap = await db.ref(`users/${UID}/machines`).once('value');
    const machines = machinesSnap.val() || {};

    const allUpdates = {};
    let totalMachinesRepaired = 0;
    let totalShutdownChunksAdded = 0;

    for (const machineId of Object.keys(machines).sort()) {
        const mConfig = machines[machineId];
        const unitId = mConfig.unit;
        const uPower = unitPower[unitId];

        if (!uPower || !uPower.sessions) {
            continue;
        }

        // Find if this unit had a carryover outage starting at SHIFT_START_UNIX (1794812400)
        let carryoverSession = null;
        for (const sId of Object.keys(uPower.sessions)) {
            const s = uPower.sessions[sId];
            if (s.off === SHIFT_START_UNIX) {
                carryoverSession = s;
                break;
            }
        }

        if (!carryoverSession) {
            // No carryover morning outage
            continue;
        }

        const hourlySnap = await db.ref(`users/${UID}/reports/machines/${machineId}/hourly/${DATE}`).once('value');
        const dailySnap = await db.ref(`users/${UID}/reports/machines/${machineId}/daily/${DATE}`).once('value');

        const existingHourly = hourlySnap.val() || {};
        const existingDaily = dailySnap.val() || null;

        // Collect existing chunks sorted by from
        const existingChunks = Object.values(existingHourly)
            .filter(c => c && typeof c.from === 'number')
            .sort((a, b) => a.from - b.from);

        // Check if carryover shutdown chunk already exists at SHIFT_START_SEC
        const hasCarryoverShutdownChunk = existingChunks.some(c => c.from === SHIFT_START_SEC && c.shutdown_time > 0);
        if (hasCarryoverShutdownChunk) {
            // Already repaired or already present
            continue;
        }

        // Outage window:
        // Starts at SHIFT_START_SEC (25200)
        // Ends when the machine began transmitting or unit came on
        const sessionOnSec = carryoverSession.on - SHIFT_START_UNIX + SHIFT_START_SEC;
        const earliestChunkFrom = existingChunks.length > 0 ? existingChunks[0].from : sessionOnSec;
        const outageStartSec = SHIFT_START_SEC;
        const outageEndSec = Math.max(outageStartSec, Math.min(sessionOnSec, earliestChunkFrom));
        const outageDuration = Math.max(0, outageEndSec - outageStartSec);

        if (outageDuration <= 0) {
            continue;
        }

        totalMachinesRepaired++;

        // Build new hourly chunks
        const newChunks = [];

        // 1. Synthesize shutdown chunks for the carryover period
        let cur = outageStartSec;
        while (cur < outageEndSec) {
            const curHour = Math.floor(cur / 3600);
            const nextHourBoundary = (curHour + 1) * 3600;
            const chunkEnd = Math.min(outageEndSec, nextHourBoundary);
            const duration = Math.max(0, chunkEnd - cur);
            if (duration > 0) {
                newChunks.push({
                    from: cur,
                    time: chunkEnd,
                    shutdown_time: duration,
                    ontime: 0,
                    offtime: 0,
                    status: false,
                    isShutdown: true,
                    shots: 0,
                    production: 0,
                    production_meters: 0,
                    electricity_usage: 0,
                    material_usage: 0,
                    cavities: 0,
                    mold_name: "N/A",
                    product: "N/A",
                    operator: "N/A"
                });
                totalShutdownChunksAdded++;
            }
            cur = chunkEnd;
        }

        // 2. Append existing chunks, preserving 100% of telemetry data
        for (const exChunk of existingChunks) {
            newChunks.push(exChunk);
        }

        // Sort all chunks strictly by from
        newChunks.sort((a, b) => a.from - b.from);

        // Calculate total shutdown time across all chunks (including any existing same-day shutdown chunks)
        const totalShutdownTime = newChunks.reduce((acc, c) => acc + (c.shutdown_time || 0), 0);

        console.log(`Machine: ${machineId.padEnd(12)} (Unit ${String(unitId).padStart(2)})`);
        console.log(`  -> Existing Chunks: ${existingChunks.length} | New Total Chunks: ${newChunks.length}`);
        console.log(`  -> Added Shutdown Window: ${outageStartSec} (07:00:00) to ${outageEndSec} (${moment.utc(outageEndSec * 1000).format('HH:mm:ss')}) | Total Shutdown: ${totalShutdownTime}s (${(totalShutdownTime/3600).toFixed(2)}h)`);

        // Convert array to numbered object { "0": ..., "1": ..., ... }
        const newHourlyObj = {};
        newChunks.forEach((c, idx) => {
            newHourlyObj[String(idx)] = c;
        });

        allUpdates[`users/${UID}/reports/machines/${machineId}/hourly/${DATE}`] = newHourlyObj;

        // Daily total update
        if (existingDaily) {
            allUpdates[`users/${UID}/reports/machines/${machineId}/daily/${DATE}/total/shutdown_time`] = totalShutdownTime;
        } else {
            allUpdates[`users/${UID}/reports/machines/${machineId}/daily/${DATE}`] = {
                completed: false,
                total: {
                    electricity_usage: 0,
                    material_usage: 0,
                    offtime: 0,
                    ontime: 0,
                    production: 0,
                    production_meters: 0,
                    shots: 0,
                    shutdown_time: totalShutdownTime,
                    operators: {}
                },
                molds: {}
            };
        }
    }

    console.log(`\n========================================================================`);
    console.log(`SUMMARY OF REPAIR`);
    console.log(`Total machines to repair: ${totalMachinesRepaired}`);
    console.log(`Total hourly shutdown chunks added: ${totalShutdownChunksAdded}`);
    console.log(`Total RTDB paths to update: ${Object.keys(allUpdates).length}`);
    console.log(`========================================================================\n`);

    if (!isApply) {
        console.log(`[DRY RUN COMPLETE] No changes were written to RTDB.`);
        console.log(`To apply these changes, re-run with: node scripts/repair_16nov_outage.js --apply\n`);
        process.exit(0);
    }

    console.log(`APPLYING UPDATES TO RTDB...`);
    await db.ref().update(allUpdates);
    console.log(`[SUCCESS] All ${Object.keys(allUpdates).length} updates successfully written to Firebase RTDB!`);
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error during repair:', err);
    process.exit(1);
});
