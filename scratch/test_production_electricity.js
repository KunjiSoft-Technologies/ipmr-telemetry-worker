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
    const unixTime = 1780896000; // June 8, 2026 08:00:00 AM

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
                { high: 1780896002, low: 1780896005 },
                { high: 1780896010, low: 1780896013 }
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

        // Set previous accumulator value in mock DB
        const accumPath = `users/${uid}/reports/machines/mach001/accumulators/SUM_WH_Total`;
        dbMockData[accumPath] = 1000; // Wh

        const phaseValues = {
            SUM: {
                SUM_WH_Total: { now: 1250 } // delta = 250 Wh
            }
        };

        mockUnit.previousUnix = unixTime - 30; // 30 seconds ago

        await processPhaseValues(mockDb, uid, unit, 'machines', 'mach001', phaseValues, unixTime, mockUnit);

        // Verification:
        // Accumulator should be 1250 Wh
        assert.strictEqual(dbMockData[accumPath], 1250, 'Accumulator should be updated to 1250');

        // Electricity consumption = delta = 250 Wh
        // Daily machine total should reflect electricity_usage increment
        const dailyTotalPath = `users/${uid}/reports/machines/mach001/daily/2026-06-08/total`;
        console.log('Updated machine daily stats with electricity:', dbMockData[dailyTotalPath]);

        // Factory daily report should have electricity_usage increment
        const factoryDailyPath = `users/${uid}/reports/factory/daily/2026-06-08`;
        console.log('Factory daily report:', dbMockData[factoryDailyPath]);

        console.log('✓ Test 2 passed.');
    } catch (err) {
        console.error('✗ Test 2 failed:', err);
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

    console.log('--- ALL TESTS PASSED SUCCESSFULLY! ---');
}

runTests().catch(err => {
    console.error('Unhandled test failure:', err);
    process.exit(1);
});
