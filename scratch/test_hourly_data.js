const assert = require('assert');
const { processPhaseValues } = require('c:/Users/shuja/OneDrive/Desktop/projects/ipmr-telemetry-worker/services/telemetryProcessor');

console.log('--- STARTING HOURLY & DAILY DATA AGGREGATION TESTS ---');

// Mock Firebase RTDB
const mockDb = {
    records: {},
    ref(path) {
        if (!this.records[path]) {
            this.records[path] = {
                val: null,
                transaction(txFn) {
                    const result = txFn(this.val);
                    if (result !== undefined) {
                        this.val = result;
                    }
                }
            };
        }
        return this.records[path];
    }
};

// Mock _unit and unix timestamps
const mockUnit = {
    info: {
        shift_a_start: 28800 // 08:00:00
    }
};
const unixTime = 1780894740; // timestamp matching mock date/hour helpers

// 1. Define Test Payloads
const payload1 = {
    R: {
        VOLTAGE: { min: 218, max: 222, avg: 220, now: 221 },
        FREQUENCY: { min: 49.8, max: 50.2, avg: 50.0, now: 50.1 }, // excluded from hourly, kept in daily
        AMPERE: { max: 10, avg: 8, now: 9 } // max, avg only
    },
    SUM: {
        VOLTAGE: { min: 219, max: 223, avg: 221, now: 222 },
        FREQUENCY: { min: 49.9, max: 50.1, avg: 50.0, now: 50.0 }, // kept in both
        AMPERE: { max: 30, avg: 24, now: 27 },
        NEUTRAL_AMPERE: { max: 2, avg: 1.5, now: 1.8 } // custom suggestion
    }
};

const payload2 = {
    R: {
        VOLTAGE: { min: 215, max: 225, avg: 219, now: 218 },
        FREQUENCY: { min: 49.5, max: 50.5, avg: 50.1, now: 50.2 },
        AMPERE: { max: 12, avg: 9, now: 10 }
    },
    SUM: {
        VOLTAGE: { min: 216, max: 226, avg: 220, now: 221 },
        FREQUENCY: { min: 49.6, max: 50.4, avg: 50.0, now: 50.1 },
        AMPERE: { max: 32, avg: 26, now: 28 },
        NEUTRAL_AMPERE: { max: 3, avg: 2.0, now: 2.2 }
    }
};

async function runTests() {
    try {
        console.log('Running processPhaseValues for payload 1...');
        await processPhaseValues(mockDb, 'user123', 'unit456', 'machines', 'mach789', payload1, unixTime, mockUnit);

        console.log('Running processPhaseValues for payload 2...');
        await processPhaseValues(mockDb, 'user123', 'unit456', 'machines', 'mach789', payload2, unixTime, mockUnit);

        const { getToday, whatHour } = require('c:/Users/shuja/OneDrive/Desktop/projects/ipmr-telemetry-worker/utils/timeHelpers');
        const today = getToday('user123', unixTime, mockUnit);
        const hour = whatHour('user123', unixTime, mockUnit);

        const hourlyBase = `users/user123/reports/machines/mach789/new_hourly/${today}/${hour}/phase_values`;
        const dailyBase = `users/user123/reports/machines/mach789/daily/${today}/phase_values`;

        console.log('\n--- VERIFYING HOURLY METRICS (Restricted & Aggregated) ---');

        // Check VOLTAGE (min, max, avg)
        const hourlyRVoltage = mockDb.records[`${hourlyBase}/R/VOLTAGE`]?.val;
        console.log('Hourly R VOLTAGE:', hourlyRVoltage);
        assert.ok(hourlyRVoltage, 'Hourly R VOLTAGE should exist');
        assert.strictEqual(hourlyRVoltage.min, 215, 'Min should be 215 (min of 218 and 215)');
        assert.strictEqual(hourlyRVoltage.max, 225, 'Max should be 225 (max of 222 and 225)');
        assert.strictEqual(hourlyRVoltage.avg, 219.5, 'Avg should be 219.5 (average of 220 and 219)');

        // Check FREQUENCY (should be completely omitted from R hourly, but kept in SUM hourly)
        const hourlyRFrequency = mockDb.records[`${hourlyBase}/R/FREQUENCY`]?.val;
        console.log('Hourly R FREQUENCY:', hourlyRFrequency);
        assert.strictEqual(hourlyRFrequency, undefined, 'Hourly R FREQUENCY should not exist');

        const hourlySUMFrequency = mockDb.records[`${hourlyBase}/SUM/FREQUENCY`]?.val;
        console.log('Hourly SUM FREQUENCY:', hourlySUMFrequency);
        assert.ok(hourlySUMFrequency, 'Hourly SUM FREQUENCY should exist');
        assert.strictEqual(hourlySUMFrequency.min, 49.6);
        assert.strictEqual(hourlySUMFrequency.max, 50.4);
        assert.strictEqual(hourlySUMFrequency.avg, 50.0);

        // Check AMPERE (max, avg only - no min)
        const hourlyRAmpere = mockDb.records[`${hourlyBase}/R/AMPERE`]?.val;
        console.log('Hourly R AMPERE:', hourlyRAmpere);
        assert.ok(hourlyRAmpere, 'Hourly R AMPERE should exist');
        assert.strictEqual(hourlyRAmpere.min, undefined, 'Hourly R AMPERE should not have min');
        assert.strictEqual(hourlyRAmpere.max, 12, 'Max should be 12 (max of 10 and 12)');
        assert.strictEqual(hourlyRAmpere.avg, 8.5, 'Avg should be 8.5 (average of 8 and 9)');

        // Check Neutral Ampere (max, avg only)
        const hourlySUMNeutral = mockDb.records[`${hourlyBase}/SUM/NEUTRAL_AMPERE`]?.val;
        console.log('Hourly SUM NEUTRAL_AMPERE:', hourlySUMNeutral);
        assert.ok(hourlySUMNeutral, 'Hourly SUM NEUTRAL_AMPERE should exist');
        assert.strictEqual(hourlySUMNeutral.min, undefined);
        assert.strictEqual(hourlySUMNeutral.max, 3);
        assert.strictEqual(hourlySUMNeutral.avg, 1.75);

        console.log('\n--- VERIFYING DAILY METRICS (Retained All) ---');

        // Daily R FREQUENCY (should be retained)
        const dailyRFrequency = mockDb.records[`${dailyBase}/R/FREQUENCY`]?.val;
        console.log('Daily R FREQUENCY:', dailyRFrequency);
        assert.ok(dailyRFrequency, 'Daily R FREQUENCY should exist in daily reports');
        assert.strictEqual(dailyRFrequency.min, 49.5);
        assert.strictEqual(dailyRFrequency.max, 50.5);
        assert.strictEqual(dailyRFrequency.avg, 50.05);

        // Daily R AMPERE (max, avg only - no min)
        const dailyRAmpere = mockDb.records[`${dailyBase}/R/AMPERE`]?.val;
        console.log('Daily R AMPERE:', dailyRAmpere);
        assert.ok(dailyRAmpere, 'Daily R AMPERE should exist in daily reports');
        assert.strictEqual(dailyRAmpere.min, undefined);
        assert.strictEqual(dailyRAmpere.max, 12);

        console.log('\n✓ All data aggregation unit tests passed successfully!');
    } catch (err) {
        console.error('\n✗ Tests failed:', err);
        process.exit(1);
    }
}

runTests();
