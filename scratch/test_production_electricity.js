const assert = require('assert');
const { processPhaseValues, processDigitalValues } = require('../services/telemetryProcessor');

// Setup mock database
const dbMockData = {};
const transactionCallbacks = [];

const mockDbRef = (path) => {
    return {
        path,
        set: async (val) => {
            dbMockData[path] = val;
            return { key: path.split('/').pop() };
        },
        update: async (val) => {
            dbMockData[path] = dbMockData[path] || {};
            if (typeof val === 'object' && val !== null) {
                Object.assign(dbMockData[path], val);
            } else {
                dbMockData[path] = val;
            }
            return { key: path.split('/').pop() };
        },
        push: (val) => {
            const key = 'mock_key_' + Math.random().toString(36).substr(2, 9);
            const childPath = `${path}/${key}`;
            if (val !== undefined) {
                dbMockData[childPath] = val;
            }
            return {
                key,
                set: async (v) => { dbMockData[childPath] = v; }
            };
        },
        once: async (event) => {
            return {
                val: () => dbMockData[path] !== undefined ? dbMockData[path] : null,
                exists: () => dbMockData[path] !== undefined
            };
        },
        limitToLast: function(num) {
            return this;
        },
        transaction: async function(callback) {
            transactionCallbacks.push({ path, callback });
            const current = dbMockData[path] !== undefined ? dbMockData[path] : null;
            const next = callback(current);
            dbMockData[path] = next;
            return { committed: true, snapshot: { val: () => next } };
        }
    };
};

const mockDb = {
    ref: (path) => mockDbRef(path)
};

// Start tests
async function runTests() {
    console.log('--- STARTING PRODUCTION & ELECTRICITY TESTS ---');

    const uid = 'user123';
    const unit = 10;
    const unixTime = 1780916400; // June 8, 2026 11:00:00 AM UTC

    const mockUnit = {
        info: {
            shift_a_start: 28800, // 08:00
            shift_b_start: 57600, // 16:00
            shift_c_start: 0,     // 00:00
            shifts: 3,
            supervisor_a: 'Alice',
            supervisor_b: 'Bob',
            supervisor_c: 'Charlie',
            shift_a_hours: '8',
            shift_b_hours: '8',
            shift_c_hours: '8'
        },
        machines: {
            mach001: {
                title: 'Machine 001',
                machine_model: 'Model-X',
                machine_status: true,
                idle_time_set: 5, // 5 minutes
                cavities: 4,
                product: 'Widget A',
                product_color: 'Red',
                material: 'PP',
                product_weight: 10,
                operator_a: 'Op A',
                operator_b: 'Op B',
                operator_c: 'Op C'
            }
        },
        equipments: {
            eq001: {
                name: 'Compressor 1',
                division: 1,
                status: true
            }
        },
        connection: {},
        targets: {},
        hourlyReportData: {}
    };

    // Test 1: countProduction via processDigitalValues
    try {
        console.log('Running test 1: processDigitalValues production counting...');

        // Simulate 2 production pulses on signal X1
        const digitalValues = {
            X1: [
                { high: unixTime + 2, low: unixTime + 5 },
                { high: unixTime + 10, low: unixTime + 13 }
            ]
        };

        // Initialize targetpreviousUnix
        mockUnit.targets['mach001&production'] = {
            status: true,
            timer: 0,
            pulses: 0,
            previousUnix: unixTime - 30, // 30 seconds ago
            second_timer: 0
        };
        mockUnit.previousUnix = unixTime - 30;

        const mockInputs = { 'x1': 'production' };
        await processDigitalValues(mockDb, uid, unit, 'machines', 'mach001', digitalValues, unixTime, mockUnit, mockInputs);

        // Verification:
        // Shots = 2, Cavities = 4 -> Production = 8
        // Material Usage = 8 * 10 = 80g
        const dailyTotalPath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/total`;
        const stats = dbMockData[dailyTotalPath];

        assert.ok(stats, 'Daily machine stats should exist');
        assert.deepStrictEqual(stats.production, { '.sv': { increment: 8 } });
        assert.deepStrictEqual(stats.shots, { '.sv': { increment: 2 } });
        assert.deepStrictEqual(stats.material_usage, { '.sv': { increment: 80 } });
        
        console.log('✓ Test 1 passed.');
    } catch (err) {
        console.error('✗ Test 1 failed:', err);
        process.exit(1);
    }

    // Test 2: countElectricity via processPhaseValues
    try {
        console.log('Running test 2: processPhaseValues electricity counting...');

        // Set previous accumulator values in mock DB
        const accumPath = `users/${uid}/reports/machines/mach001/accumulators/SUM_WH_Total`;
        dbMockData[accumPath] = 1000; // Wh

        const vahAccumPath = `users/${uid}/reports/machines/mach001/accumulators/SUM_VAH`;
        dbMockData[vahAccumPath] = 2000; // VAh

        const phaseValues = {
            SUM: {
                SUM_WH_Total: { now: 1250 }, // delta = 250 Wh (0.25 kWh)
                SUM_VAH: { now: 2500 },       // delta = 500 VAh (0.5 kVAh)
                POWER_FACTOR: { max: 0.95, avg: 0.90, now: 0.92 }
            },
            R: {
                POWER_FACTOR: { max: 0.96, avg: 0.91, now: 0.93 }
            }
        };

        mockUnit.previousUnix = unixTime - 30; // 30 seconds ago

        await processPhaseValues(mockDb, uid, unit, 'machines', 'mach001', phaseValues, unixTime, mockUnit);

        // Verification:
        // Accumulators should be updated in DB
        assert.strictEqual(dbMockData[accumPath], 1250, 'Accumulator SUM_WH_Total should be updated to 1250');
        assert.strictEqual(dbMockData[vahAccumPath], 2500, 'Accumulator SUM_VAH should be updated to 2500');

        // Verify POWER_FACTOR daily report lag_min/lead_min/avg for SUM and R phase
        const sumPfDailyPath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/phase_values/SUM/POWER_FACTOR`;
        const rPfDailyPath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/phase_values/R/POWER_FACTOR`;

        assert.ok(dbMockData[sumPfDailyPath], 'Daily SUM POWER_FACTOR should exist');
        assert.strictEqual(dbMockData[sumPfDailyPath].lag_min, 0.90, 'Daily SUM POWER_FACTOR lag_min should be 0.90');
        assert.strictEqual(dbMockData[sumPfDailyPath].lead_min, 1, 'Daily SUM POWER_FACTOR lead_min should default to 1');
        assert.strictEqual(dbMockData[sumPfDailyPath].avg, 0.90, 'Daily SUM POWER_FACTOR avg should be 0.90');

        assert.ok(dbMockData[rPfDailyPath], 'Daily R POWER_FACTOR should exist');
        assert.strictEqual(dbMockData[rPfDailyPath].lag_min, 0.91, 'Daily R POWER_FACTOR lag_min should be 0.91');
        assert.strictEqual(dbMockData[rPfDailyPath].lead_min, 1, 'Daily R POWER_FACTOR lead_min should default to 1');
        assert.strictEqual(dbMockData[rPfDailyPath].avg, 0.91, 'Daily R POWER_FACTOR avg should be 0.91');

        // Electricity consumption = delta = 250 Wh
        // Daily machine total should reflect electricity_usage increment and accumulators increments
        const dailyTotalPath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/total`;
        console.log('Updated machine daily stats with electricity:', dbMockData[dailyTotalPath]);

        const dailyStats = dbMockData[dailyTotalPath];
        assert.deepStrictEqual(dailyStats.electricity_usage, { '.sv': { increment: 0.25 } });
        assert.deepStrictEqual(dailyStats['accumulators/SUM_WH_Total'], { '.sv': { increment: 0.25 } });
        assert.deepStrictEqual(dailyStats['accumulators/SUM_VAH'], { '.sv': { increment: 0.5 } });

        // Factory daily report should have electricity_usage and accumulators increments
        const factoryDailyPath = `users/${uid}/reports/factory/daily/2026-06-08`;
        console.log('Factory daily report:', dbMockData[factoryDailyPath]);

        const factoryDaily = dbMockData[factoryDailyPath];
        assert.deepStrictEqual(factoryDaily.electricity_usage, { '.sv': { increment: 0.25 } });
        assert.deepStrictEqual(factoryDaily['accumulators/SUM_WH_Total'], { '.sv': { increment: 0.25 } });
        assert.deepStrictEqual(factoryDaily['accumulators/SUM_VAH'], { '.sv': { increment: 0.5 } });

        console.log('✓ Test 2 passed.');
    } catch (err) {
        console.error('✗ Test 2 failed:', err);
        process.exit(1);
    }

    // Test 2.5: processPhaseValues with identical accumulator values (zero increment)
    try {
        console.log('Running test 2.5: processPhaseValues with identical accumulator values (zero increment)...');

        const phaseValues = {
            SUM: {
                SUM_WH_Total: { now: 1250 }, // delta should be 0 Wh
                SUM_VAH: { now: 2500 }        // delta should be 0 VAh
            }
        };

        mockUnit.previousUnix = unixTime;
        const nextUnixTime = unixTime + 30; // 30 seconds later

        // Clear mock DB data for updates to see fresh increments
        const dailyTotalPath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/total`;
        delete dbMockData[dailyTotalPath];

        await processPhaseValues(mockDb, uid, unit, 'machines', 'mach001', phaseValues, nextUnixTime, mockUnit);

        const accumPath = `users/${uid}/reports/machines/mach001/accumulators/SUM_WH_Total`;
        const vahAccumPath = `users/${uid}/reports/machines/mach001/accumulators/SUM_VAH`;

        // Accumulators in DB should NOT change
        assert.strictEqual(dbMockData[accumPath], 1250, 'Accumulator SUM_WH_Total should remain 1250');
        assert.strictEqual(dbMockData[vahAccumPath], 2500, 'Accumulator SUM_VAH should remain 2500');

        // Daily machine total should reflect 0 electricity_usage and 0 accumulators increments
        console.log('Updated machine daily stats with zero electricity:', dbMockData[dailyTotalPath]);

        const dailyStats = dbMockData[dailyTotalPath];
        assert.deepStrictEqual(dailyStats.electricity_usage, { '.sv': { increment: 0 } });
        assert.deepStrictEqual(dailyStats['accumulators/SUM_WH_Total'], { '.sv': { increment: 0 } });
        assert.deepStrictEqual(dailyStats['accumulators/SUM_VAH'], { '.sv': { increment: 0 } });

        console.log('✓ Test 2.5 passed.');
    } catch (err) {
        console.error('✗ Test 2.5 failed:', err);
        process.exit(1);
    }

    // Test 2.6: Temporary 0 packet (Modbus failure) and recovery
    try {
        console.log('Running test 2.6: Temporary 0 value (Modbus failure) and recovery...');
        
        // Accumulator starts at 1250 from Test 2.5
        // Send a 0 packet (Modbus failure)
        const phaseValuesZero = {
            SUM: {
                SUM_WH_Total: { now: 0 },
                SUM_VAH: { now: 0 }
            }
        };
        
        // Reset daily stats increments for validation
        const dailyTotalPath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/total`;
        dbMockData[dailyTotalPath] = {
            electricity_usage: { '.sv': { increment: 0 } },
            'accumulators/SUM_WH_Total': { '.sv': { increment: 0 } }
        };

        await processPhaseValues(mockDb, uid, unit, 'machines', 'mach001', phaseValuesZero, unixTime, mockUnit);

        // Verification for zero packet:
        // No delta should be recorded, legacy accum path remains 1250
        const accumPath = `users/${uid}/reports/machines/mach001/accumulators/SUM_WH_Total`;
        assert.strictEqual(dbMockData[accumPath], 1250, 'Accumulator should remain 1250 on zero packet');
        assert.strictEqual(dbMockData[dailyTotalPath].electricity_usage['.sv'].increment, 0, 'No electricity usage should be incremented');

        // Now send packet recovering to the actual reading 1260 (10 Wh delta since 1250)
        const phaseValuesRecover = {
            SUM: {
                SUM_WH_Total: { now: 1260 },
                SUM_VAH: { now: 2520 }
            }
        };

        await processPhaseValues(mockDb, uid, unit, 'machines', 'mach001', phaseValuesRecover, unixTime, mockUnit);

        // Verification for recovery packet:
        // Delta should be 10 Wh (0.01 kWh), legacy accum path becomes 1260
        assert.strictEqual(dbMockData[accumPath], 1260, 'Accumulator should become 1260');
        assert.strictEqual(dbMockData[dailyTotalPath].electricity_usage['.sv'].increment, 0.01, 'Electricity usage should increment by 0.01 kWh');

        console.log('✓ Test 2.6 passed.');
    } catch (err) {
        console.error('✗ Test 2.6 failed:', err);
        process.exit(1);
    }

    // Test 2.7: Genuine reset (from 1260 -> 0 -> 20 -> 80)
    try {
        console.log('Running test 2.7: Genuine energy meter reset...');

        // Step 1: Send 0 packet (this initializes the reset state)
        const phaseValuesZero = {
            SUM: {
                SUM_WH_Total: { now: 0 },
                SUM_VAH: { now: 0 }
            }
        };
        const dailyTotalPath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/total`;
        dbMockData[dailyTotalPath] = {
            electricity_usage: { '.sv': { increment: 0 } },
            'accumulators/SUM_WH_Total': { '.sv': { increment: 0 } }
        };

        await processPhaseValues(mockDb, uid, unit, 'machines', 'mach001', phaseValuesZero, unixTime, mockUnit);

        // Raw/legacy is still at 1260, delta is 0
        const accumPath = `users/${uid}/reports/machines/mach001/accumulators/SUM_WH_Total`;
        assert.strictEqual(dbMockData[accumPath], 1260, 'Accumulator should remain 1260 on reset 0 packet');

        // Step 2: Send 20 packet (meter starting up from 0 to 20)
        const phaseValues20 = {
            SUM: {
                SUM_WH_Total: { now: 20 },
                SUM_VAH: { now: 40 }
            }
        };
        await processPhaseValues(mockDb, uid, unit, 'machines', 'mach001', phaseValues20, unixTime, mockUnit);

        // Delta should be 20 Wh (0.02 kWh), lifetime becomes 1260 + 20 = 1280
        assert.strictEqual(dbMockData[accumPath], 1280, 'Accumulator should update to 1280 (1260 legacy + 20 reset)');
        assert.strictEqual(dbMockData[dailyTotalPath].electricity_usage['.sv'].increment, 0.02, 'Electricity usage should increment by 0.02 kWh');

        // Step 3: Send 80 packet (meter incrementing from 20 to 80)
        // Reset daily stats to isolate the increment from 20 to 80 (delta = 60 Wh = 0.06 kWh)
        dbMockData[dailyTotalPath] = {
            electricity_usage: { '.sv': { increment: 0 } },
            'accumulators/SUM_WH_Total': { '.sv': { increment: 0 } }
        };

        const phaseValues80 = {
            SUM: {
                SUM_WH_Total: { now: 80 },
                SUM_VAH: { now: 160 }
            }
        };
        await processPhaseValues(mockDb, uid, unit, 'machines', 'mach001', phaseValues80, unixTime, mockUnit);

        // Delta should be 60 Wh (0.06 kWh), lifetime becomes 1280 + 60 = 1340
        assert.strictEqual(dbMockData[accumPath], 1340, 'Accumulator should update to 1340 (1280 + 60)');
        assert.strictEqual(dbMockData[dailyTotalPath].electricity_usage['.sv'].increment, 0.06, 'Electricity usage should increment by 0.06 kWh');

        console.log('✓ Test 2.7 passed.');
    } catch (err) {
        console.error('✗ Test 2.7 failed:', err);
        process.exit(1);
    }

    // Test 2.8: Daily/hourly reports preserve existing properties when incoming values are null/missing
    try {
        console.log('Running test 2.8: daily/hourly reports preserve properties when min is missing...');

        const dailyVoltagePath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/phase_values/SUM/VOLTAGE`;
        
        // 1. Setup pre-existing values in database daily report
        dbMockData[dailyVoltagePath] = {
            min: 215,
            max: 225,
            avg: 220,
            avg_sum: 220,
            avg_count: 1
        };

        // 2. Process a packet with only max and avg, but min and now are missing/null
        const phaseValues = {
            SUM: {
                VOLTAGE: { max: 230, avg: 222 }
            }
        };

        await processPhaseValues(mockDb, uid, unit, 'machines', 'mach001', phaseValues, unixTime, mockUnit);

        // Verification:
        // The existing min of 215 should be preserved and not deleted!
        assert.ok(dbMockData[dailyVoltagePath], 'Daily report VOLTAGE entry should still exist');
        assert.strictEqual(dbMockData[dailyVoltagePath].min, 215, 'Pre-existing min value should be preserved');
        assert.strictEqual(dbMockData[dailyVoltagePath].max, 230, 'Max value should be updated to 230');

        console.log('✓ Test 2.8 passed.');
    } catch (err) {
        console.error('✗ Test 2.8 failed:', err);
        process.exit(1);
    }

    // Test 2.9: Explicit null values do not fall back to now
    try {
        console.log('Running test 2.9: explicit null values do not fall back to now...');

        const dailyVoltagePath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/phase_values/R/VOLTAGE`;
        
        // 1. Setup pre-existing values in database daily report
        dbMockData[dailyVoltagePath] = {
            min: 215,
            max: 225,
            avg: 220,
            avg_sum: 220,
            avg_count: 1
        };

        // 2. Process a packet where min is explicitly null (e.g. voltage below threshold), and now is 0
        const phaseValues = {
            R: {
                VOLTAGE: { min: null, max: null, now: 0 }
            }
        };

        await processPhaseValues(mockDb, uid, unit, 'machines', 'mach001', phaseValues, unixTime, mockUnit);

        // Verification:
        // Since min is explicitly null, the server should NOT fall back to now (0) and the pre-existing min (215) should be preserved!
        assert.ok(dbMockData[dailyVoltagePath], 'Daily report VOLTAGE entry should exist');
        assert.strictEqual(dbMockData[dailyVoltagePath].min, 215, 'Pre-existing min value (215) should be preserved and not replaced by fallback 0');

        console.log('✓ Test 2.9 passed.');
    } catch (err) {
        console.error('✗ Test 2.9 failed:', err);
        process.exit(1);
    }

    // Test 2.10: Phase values are skipped when voltage is below 80V threshold, but accumulators still work
    try {
        console.log('Running test 2.10: skipping daily/hourly report updates below 80V...');

        const dailyVoltagePath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/phase_values/R/VOLTAGE`;
        const accumPath = `users/${uid}/reports/machines/mach001/accumulators/SUM_WH_Total`;
        const dailyTotalPath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/total`;

        // 1. Setup pre-existing values in database report
        dbMockData[dailyVoltagePath] = {
            min: 215,
            max: 225,
            avg: 220,
            avg_sum: 220,
            avg_count: 1
        };
        dbMockData[accumPath] = 1340;
        dbMockData[`users/${uid}/reports/machines/mach001/accumulators_state/SUM_WH_Total`] = {
            raw: 1340,
            lifetime: 1340
        };
        dbMockData[dailyTotalPath] = {
            electricity_usage: { '.sv': { increment: 0 } },
            'accumulators/SUM_WH_Total': { '.sv': { increment: 0 } }
        };

        // 2. Process a packet where voltage is below 80V (e.g. now = 50V), but there is energy accumulator increment (delta 10 Wh)
        const phaseValues = {
            R: {
                VOLTAGE: { min: 50, max: 50, now: 50 }
            },
            SUM: {
                SUM_WH_Total: { now: 1350 }
            }
        };

        mockUnit.previousUnix = unixTime - 30; // 30 seconds ago

        await processPhaseValues(mockDb, uid, unit, 'machines', 'mach001', phaseValues, unixTime, mockUnit);

        // Verification:
        // A. Accumulator logic SHOULD run (since it's not daily/hourly min/max report stats)
        assert.strictEqual(dbMockData[accumPath], 1350, 'Accumulator SUM_WH_Total should be updated to 1350');
        assert.strictEqual(dbMockData[dailyTotalPath].electricity_usage['.sv'].increment, 0.01, 'Electricity usage should still increment');

        // B. Daily voltage stats should NOT be updated because R.VOLTAGE was 50V (which is below 80V threshold)
        // If it had been processed, it would have updated min to 50, but since skipped, min remains 215!
        assert.strictEqual(dbMockData[dailyVoltagePath].min, 215, 'Voltage daily stats should NOT update since voltage is below threshold');

        console.log('✓ Test 2.10 passed.');
    } catch (err) {
        console.error('✗ Test 2.10 failed:', err);
        process.exit(1);
    }

    // Test 2.11: POWER_FACTOR lag_min / lead_min comparisons...
    try {
        console.log('Running test 2.11: POWER_FACTOR lag_min / lead_min comparisons...');

        const dailyPfPath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/phase_values/SUM/POWER_FACTOR`;

        // 1. Setup pre-existing values
        dbMockData[dailyPfPath] = {
            lag_min: 0.90,
            lead_min: -0.95,
            avg: -0.92,
            avg_sum: -0.92,
            avg_count: 1
        };

        // 2. Process a packet with:
        // - min: -0.10 (should update lead_min to -0.10 since Math.abs(-0.10) < Math.abs(-0.95))
        // - max: -0.98 (should not update lead_min because Math.abs(-0.98) > Math.abs(-0.10))
        // - now: 0.85 (should update lag_min to 0.85 since Math.abs(0.85) < Math.abs(0.90))
        const phaseValues = {
            SUM: {
                POWER_FACTOR: { min: -0.10, max: -0.98, now: 0.85 }
            }
        };

        // Bypassing voltage threshold checks by sending R phase voltage at 220V
        phaseValues.R = {
            VOLTAGE: { now: 220 }
        };

        await processPhaseValues(mockDb, uid, unit, 'machines', 'mach001', phaseValues, unixTime, mockUnit);

        // Verification:
        // The daily report should update lag_min to 0.85 and lead_min to -0.10!
        assert.ok(dbMockData[dailyPfPath], 'Daily report POWER_FACTOR entry should exist');
        assert.strictEqual(dbMockData[dailyPfPath].lag_min, 0.85, 'POWER_FACTOR lag_min should update to the worse absolute value (0.85)');
        assert.strictEqual(dbMockData[dailyPfPath].lead_min, -0.10, 'POWER_FACTOR lead_min should update to the worse absolute value (-0.10)');

        console.log('✓ Test 2.11 passed.');
    } catch (err) {
        console.error('✗ Test 2.11 failed:', err);
        process.exit(1);
    }

    // Test 3: Machine status transition to OFF on idle
    try {
        console.log('Running test 3: Machine idle timeout status transition...');

        // Mock machine state: ON, targets timer at 4 minutes (240s)
        mockUnit.machines.mach001.machine_status = true;
        mockUnit.targets['mach001&production'] = {
            status: true,
            timer: 240, // 4 mins
            previousUnix: unixTime - 60 // 1 min ago
        };
        mockUnit.previousUnix = unixTime - 60;

        // Run processDigitalValues with 0 pulses (empty signal array)
        const digitalValues = {
            X1: []
        };

        const mockInputs = { 'x1': 'production' };
        await processDigitalValues(mockDb, uid, unit, 'machines', 'mach001', digitalValues, unixTime, mockUnit, mockInputs);

        // Target timer should become 240 + 60 = 300s (5 mins)
        // Since mach001 idle_time_set is 5 mins, it should transition to OFF
        assert.strictEqual(mockUnit.machines.mach001.machine_status, false, 'Machine status should transition to false (OFF)');

        // TurnOff should set machine_status to false in RTDB
        const machineStatusPath = `users/${uid}/machines/mach001/machine_status`;
        assert.strictEqual(dbMockData[machineStatusPath], false, 'Machine status in RTDB should be false');

        console.log('✓ Test 3 passed.');
    } catch (err) {
        console.error('✗ Test 3 failed:', err);
        process.exit(1);
    }

    // Test 4: processDigitalValues with new inputs structure (no series overlap)
    try {
        console.log('Running test 4: processDigitalValues with direct pulse counting...');

        // Mock inputs configuration
        const mockInputs = {
            X1: {
                label: "Injection"
            },
            X2: {
                label: "Unit Forward"
            },
            production: "X1"
        };

        // Reset daily total for clean tracking
        const dailyTotalPath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/total`;
        dbMockData[dailyTotalPath] = {
            production: { '.sv': { increment: 0 } },
            shots: { '.sv': { increment: 0 } },
            material_usage: { '.sv': { increment: 0 } }
        };

        // Setup mock digital values
        const digitalValues = {
            X1: [
                { high: unixTime + 10, low: unixTime + 10 },
                { high: unixTime + 40, low: unixTime + 40 }
            ],
            X2: [
                { high: unixTime + 10, low: unixTime + 10 },
                { high: unixTime + 50, low: unixTime + 50 }
            ]
        };

        // Ensure cycletime filter is bypassed by setting a large time difference or nulling min_cycletime
        mockUnit.machines.mach001.min_cycletime = 0; 
        mockUnit.targets['mach001&production'] = {
            status: true,
            timer: 0,
            pulses: 0,
            previousUnix: unixTime - 100,
            second_timer: 0
        };

        await processDigitalValues(mockDb, uid, unit, 'machines', 'mach001', digitalValues, unixTime, mockUnit, mockInputs);

        // Verification:
        // No overlap logic is run. Both pulses on X1 should be counted directly (yielding 2 increments).
        const stats = dbMockData[dailyTotalPath];
        assert.ok(stats, 'Daily machine stats should exist');
        assert.deepStrictEqual(stats.shots, { '.sv': { increment: 2 } }, 'Shots should increment by 2');

        console.log('✓ Test 4 passed.');
    } catch (err) {
        console.error('✗ Test 4 failed:', err);
        process.exit(1);
    }

    // Test 6: Precise cycletime daily/hourly averages and last 10 log
    try {
        console.log('Running test 6: exact cycle time calculations and tracking...');

        // Clear mock data
        for (const key of Object.keys(dbMockData)) {
            delete dbMockData[key];
        }

        // Setup mock digital values with cycle times: 16.256, 0 (first shot skipped), and 16.384
        const digitalValues = {
            X1: [
                { high: 16.256, low: 16.256 },
                { high: 0, low: 0 },
                { high: 16.384, low: 16.384 }
            ]
        };

        const mockInputs = { production: 'X1' };

        mockUnit.machines.mach001.min_cycletime = 0;
        mockUnit.targets['mach001&production'] = {
            status: true,
            timer: 0,
            pulses: 0,
            previousUnix: unixTime - 100,
            second_timer: 0
        };

        // Clear hourly report cache to force initialization
        delete mockUnit.hourlyReportData;

        await processDigitalValues(mockDb, uid, unit, 'machines', 'mach001', digitalValues, unixTime, mockUnit, mockInputs);

        // Verification:
        // A. Daily report mold cycletime path: users/uid_123/reports/machines/mach001/daily/2026-06-08/molds/NA/stats/cycletime
        const dailyCycletimePath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/molds/NA/stats/cycletime`;
        assert.ok(dbMockData[dailyCycletimePath], 'Daily cycletime entry should exist');
        assert.deepStrictEqual(dbMockData[dailyCycletimePath].total, { '.sv': { increment: 32.64 } }, 'Total cycletime should increment by 32.64');
        assert.deepStrictEqual(dbMockData[dailyCycletimePath].count, { '.sv': { increment: 2 } }, 'Non-zero count should increment by 2');

        // Verify last_10 array
        const last10Path = `${dailyCycletimePath}/last_10`;
        assert.ok(dbMockData[last10Path], 'Last 10 entry should exist');
        assert.deepStrictEqual(dbMockData[last10Path], [16.256, 16.384], 'last_10 should contain the two non-zero cycle times');

        // B. Hourly report cycletime path: users/uid_123/reports/machines/mach001/hourly/2026-06-08/0/cycletime
        const hourlyCycletimePath = `users/${uid}/reports/machines/mach001/hourly/2026-06-08/0/cycletime`;
        assert.ok(dbMockData[hourlyCycletimePath], 'Hourly cycletime entry should exist');
        assert.deepStrictEqual(dbMockData[hourlyCycletimePath].total, { '.sv': { increment: 32.64 } }, 'Hourly cycletime total should increment by 32.64');
        assert.deepStrictEqual(dbMockData[hourlyCycletimePath].count, { '.sv': { increment: 2 } }, 'Hourly cycletime count should increment by 2');

        console.log('✓ Test 6 passed.');
    } catch (err) {
        console.error('✗ Test 6 failed:', err);
        process.exit(1);
    }

    console.log('--- ALL TESTS PASSED SUCCESSFULLY! ---');
}

runTests().catch(err => {
    console.error('Unhandled test failure:', err);
    process.exit(1);
});
