const assert = require('assert');
const { normalizePayload } = require('../utils/payloadNormalizer');

console.log('--- STARTING PAYLOAD NORMALIZATION TESTS ---');

// 1. Minified Payload (with Option 1 minified keys and Option 2 missing mins where applicable)
const minifiedPayload = {
    pid: 54,
    rtc: true,
    pv: {
        R: {
            v: { n: 215, x: 225, g: 220, w: 221 }, // min, max, avg, now
            a: { x: 12, g: 8.5, w: 9 } // max, avg, now only (no min, option 2)
        },
        SUM: {
            v: { n: 216, x: 226, g: 221, w: 222 },
            llv: { n: 375, x: 390, g: 382, w: 384 },
            f: { n: 49.8, x: 50.2, g: 50.0, w: 50.1 },
            pf: { x: 1.0, g: 0.95, w: 0.97 },
            cthd: { x: 3.5, g: 2.1, w: 2.8 },
            vthd: { x: 1.8, g: 1.2, w: 1.5 },
            llvthd: { x: 1.0, g: 0.8, w: 0.9 },
            a: { x: 32, g: 25.5, w: 28.2 },
            na: { x: 2.5, g: 1.8, w: 2.0 },
            wh_t: 12345.67,
            wh_i: 12300.12,
            wh_e: 45.55
        }
    },
    av: {
        temp: { n: 28.1, x: 28.9, g: 28.3, w: 28.3 },
        temp_status: 'normal',
        sv: { n: 12.5, x: 17.7, g: 16.1, w: 17.3 },
        bv: { n: 2166, x: 2800, g: 2693, w: 2800 },
        bat_state: 'no_battery'
    },
    dv: {
        X1: { mode: 1, values: [] }
    }
};

// 2. Standard Payload (un-minified, for backward compatibility verification)
const standardPayload = {
    packet_id: 101,
    using_external_rtc: false,
    phase_values: {
        R: {
            VOLTAGE: { min: 218, max: 222, avg: 220, now: 221 }
        }
    }
};

function runTests() {
    try {
        console.log('Normalizing minified payload...');
        const normalized = normalizePayload(minifiedPayload);

        console.log('Verifying root keys...');
        assert.strictEqual(normalized.packet_id, 54);
        assert.strictEqual(normalized.using_external_rtc, true);
        assert.ok(normalized.phase_values, 'phase_values should exist');
        assert.ok(normalized.analog_values, 'analog_values should exist');
        assert.ok(normalized.digital_values, 'digital_values should exist');

        console.log('Verifying phase_values expansion...');
        const rVoltage = normalized.phase_values.R.VOLTAGE;
        assert.ok(rVoltage, 'R.VOLTAGE should exist');
        assert.strictEqual(rVoltage.min, 215);
        assert.strictEqual(rVoltage.max, 225);
        assert.strictEqual(rVoltage.avg, 220);
        assert.strictEqual(rVoltage.now, 221);

        const rAmpere = normalized.phase_values.R.AMPERE;
        assert.ok(rAmpere, 'R.AMPERE should exist');
        assert.strictEqual(rAmpere.min, undefined, 'R.AMPERE should not have min');
        assert.strictEqual(rAmpere.max, 12);
        assert.strictEqual(rAmpere.avg, 8.5);
        assert.strictEqual(rAmpere.now, 9);

        console.log('Verifying SUM parameters...');
        assert.ok(normalized.phase_values.SUM.L_L_VOLTAGE, 'L_L_VOLTAGE should exist');
        assert.ok(normalized.phase_values.SUM.FREQUENCY, 'FREQUENCY should exist');
        assert.strictEqual(normalized.phase_values.SUM.CURRENT_THD.max, 3.5);
        assert.strictEqual(normalized.phase_values.SUM.VOLTAGE_THD.max, 1.8);
        assert.strictEqual(normalized.phase_values.SUM.L_L_VOLTAGE_THD.max, 1.0);
        assert.ok(normalized.phase_values.SUM.NEUTRAL_AMPERE, 'NEUTRAL_AMPERE should exist');
        
        console.log('Verifying SUM accumulator parameters...');
        assert.strictEqual(normalized.phase_values.SUM.SUM_WH_Total, 12345.67);
        assert.strictEqual(normalized.phase_values.SUM.SUM_WH_Import, 12300.12);
        assert.strictEqual(normalized.phase_values.SUM.SUM_WH_Export, 45.55);

        console.log('Verifying analog_values expansion...');
        const temp = normalized.analog_values.temperature;
        assert.ok(temp, 'temperature should exist');
        assert.strictEqual(temp.min, 28.1);
        assert.strictEqual(temp.max, 28.9);
        assert.strictEqual(temp.now, 28.3);
        assert.strictEqual(normalized.analog_values.temperature_status, 'normal');
        assert.strictEqual(normalized.analog_values.supply_voltage.max, 17.7);

        console.log('Verifying digital_values...');
        assert.deepStrictEqual(normalized.digital_values.X1, { mode: 1, values: [] });

        console.log('\nVerifying standard payload backward compatibility...');
        const unchanged = normalizePayload(standardPayload);
        assert.strictEqual(unchanged.packet_id, 101);
        assert.strictEqual(unchanged.using_external_rtc, false);
        assert.strictEqual(unchanged.phase_values.R.VOLTAGE.min, 218);

        console.log('\n✓ All payload normalization unit tests passed successfully!');
    } catch (err) {
        console.error('\n✗ Tests failed:', err);
        process.exit(1);
    }
}

runTests();
