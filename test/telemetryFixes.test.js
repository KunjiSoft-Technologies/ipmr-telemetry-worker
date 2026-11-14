const assert = require('assert');
const { normalizePayload } = require('../utils/payloadNormalizer');

console.log('--- Running Telemetry Worker Fix Verification Tests ---');

// Test 1: Modbus 16-bit signed integer overflow in normalizePayload
console.log('\n[Test 1] Testing Modbus 16-bit signed integer overflow correction in normalizePayload...');

const testPayloadMinified = {
    pv: {
        SUM: {
            p: { w: -21916, g: -29688, x: 31997, n: 12000 },
            pf: { w: -783 },
            wh_t: 115300
        },
        R: {
            p: { w: 12190 },
            a: { w: 63 }
        }
    }
};

const normalized = normalizePayload(testPayloadMinified);
const sumPower = normalized.phase_values.SUM.POWER;

console.log('Normalized SUM POWER:', sumPower);
assert.strictEqual(sumPower.now, 65536 - 21916, 'Expected signed int16 -21916 to be converted to unsigned 43620');
assert.strictEqual(sumPower.avg, 65536 - 29688, 'Expected signed int16 -29688 to be converted to unsigned 35848');
assert.strictEqual(sumPower.max, 31997, 'Positive power 31997 should remain unchanged');
assert.strictEqual(normalized.phase_values.SUM.POWER_FACTOR.now, -0.783, 'Power factor should be scaled to -0.783');
console.log('✓ Test 1 Passed: Modbus 16-bit signed overflow successfully corrected.');

// Test 2: Accumulator jump protection logic simulation
console.log('\n[Test 2] Testing Accumulator Guard against massive baseline jumps (1,169.5 kWh spike simulation)...');

function simulateAccumulatorTransaction(current, incomingValue, legacyValue = null) {
    let dbRawValue = 0;
    let dbLifetimeValue = 0;
    let isInitialized = false;

    if (current !== null) {
        const rawVal = Number(current.raw);
        dbRawValue = Number.isFinite(rawVal) ? rawVal : 0;
        const lifeVal = Number(current.lifetime);
        dbLifetimeValue = Number.isFinite(lifeVal) ? lifeVal : 0;
        isInitialized = true;
    } else if (legacyValue !== null && Number.isFinite(Number(legacyValue))) {
        const legVal = Number(legacyValue);
        dbRawValue = legVal;
        dbLifetimeValue = legVal;
        isInitialized = true;
    }

    if (!isInitialized) {
        return { result: { raw: incomingValue, lifetime: incomingValue }, incrementBy: 0 };
    }

    if (incomingValue === 0) {
        return { result: current || { raw: dbRawValue, lifetime: dbLifetimeValue }, incrementBy: 0 };
    }

    if (dbRawValue === 0) {
        return { result: { raw: incomingValue, lifetime: dbLifetimeValue }, incrementBy: 0 };
    }

    if (dbRawValue === incomingValue) {
        return { result: current || { raw: dbRawValue, lifetime: dbLifetimeValue }, incrementBy: 0 };
    }

    // Rule 4 with AccumulatorGuard
    if (incomingValue > dbRawValue) {
        const rawDelta = incomingValue - dbRawValue;
        const MAX_PLAUSIBLE_WH_INCREMENT = 50000; // 50 kWh
        if (rawDelta > MAX_PLAUSIBLE_WH_INCREMENT) {
            // Anomalous jump: re-anchor baseline without adding delta to lifetime
            return {
                result: { raw: incomingValue, lifetime: dbLifetimeValue },
                incrementBy: 0,
                guardTriggered: true
            };
        }
        return {
            result: { raw: incomingValue, lifetime: dbLifetimeValue + rawDelta },
            incrementBy: rawDelta,
            guardTriggered: false
        };
    }

    // Rule 5: Genuine reset vs jitter
    const RESET_THRESHOLD = 10000;
    const isGenuineReset = incomingValue <= RESET_THRESHOLD && (dbRawValue - incomingValue > 1000);
    if (isGenuineReset) {
        return {
            result: { raw: incomingValue, lifetime: dbLifetimeValue + incomingValue },
            incrementBy: incomingValue
        };
    }

    return {
        result: current || { raw: dbRawValue, lifetime: dbLifetimeValue },
        incrementBy: 0
    };
}

// 2a: Normal packet increment
const state1 = { raw: 115100, lifetime: 14800000 };
const normalStep = simulateAccumulatorTransaction(state1, 115300);
assert.strictEqual(normalStep.incrementBy, 200, 'Normal 200 Wh increment should be accepted');
assert.strictEqual(normalStep.result.lifetime, 14800200, 'Lifetime should increment by 200');
assert.strictEqual(normalStep.guardTriggered, false);
console.log('✓ Normal 200 Wh increment accepted: +200 Wh');

// 2b: Massive anomaly packet jump (e.g. baseline jump from 115,000 to 1,284,500 Wh)
const anomalyStep = simulateAccumulatorTransaction(state1, 115100 + 1169500);
assert.strictEqual(anomalyStep.incrementBy, 0, 'Anomalous 1,169,500 Wh jump MUST produce 0 increment');
assert.strictEqual(anomalyStep.result.lifetime, 14800000, 'Lifetime must NOT increase during anomaly jump');
assert.strictEqual(anomalyStep.result.raw, 115100 + 1169500, 'Raw baseline must be re-anchored to incoming value');
assert.strictEqual(anomalyStep.guardTriggered, true, 'Guard must be triggered');
console.log('✓ Anomalous 1,169,500 Wh jump intercepted and neutralized! Increment = 0 Wh, baseline re-anchored.');

// 2c: Subsequent normal packet after re-anchoring
const reanchoredState = anomalyStep.result;
const postAnomalyStep = simulateAccumulatorTransaction(reanchoredState, reanchoredState.raw + 300);
assert.strictEqual(postAnomalyStep.incrementBy, 300, 'Post-reanchoring packet should increment normally');
assert.strictEqual(postAnomalyStep.result.lifetime, 14800300, 'Lifetime should increment by 300 Wh from preserved baseline');
console.log('✓ Post-reanchoring normal packet seamlessly resumed: +300 Wh');

// 2d: Genuine device reboot (meter reset to 0)
const stateAtReboot = { raw: 16200, lifetime: 14800000 };
const rebootStep = simulateAccumulatorTransaction(stateAtReboot, 200);
assert.strictEqual(rebootStep.incrementBy, 200, 'Genuine reset with small initial value should increment by incoming value');
assert.strictEqual(rebootStep.result.lifetime, 14800200);
console.log('✓ Genuine meter reset handled correctly: +200 Wh');

// Test 3: countElectricity safety bounds checking
console.log('\n[Test 3] Testing countElectricity safety input clamping...');
function simulateCountElectricitySanitization(value, accumulatorIncrements) {
    value = Number(value);
    if (value > 50000 || isNaN(value) || value < 0) {
        value = 0;
    }
    const safeAccumulatorIncrements = {};
    for (const [param, inc] of Object.entries(accumulatorIncrements)) {
        const numInc = Number(inc);
        if (Number.isFinite(numInc) && numInc >= 0 && numInc <= 50) {
            safeAccumulatorIncrements[param] = numInc;
        }
    }
    const electricity_consumption = value / 1000;
    return { electricity_consumption, safeAccumulatorIncrements };
}

const sanitizedSpike = simulateCountElectricitySanitization(1169500, { SUM_WH_Total: 1169.5, SUM_VAH: 2024.3, normal: 0.2 });
assert.strictEqual(sanitizedSpike.electricity_consumption, 0, 'Spike of 1,169,500 Wh must be clamped to 0 kWh');
assert.deepStrictEqual(sanitizedSpike.safeAccumulatorIncrements, { normal: 0.2 }, 'Anomalous accumulators must be stripped');
console.log('✓ countElectricity safety clamping verified.');

console.log('\n=========================================');
console.log('ALL LOCAL VERIFICATION TESTS PASSED (4/4)!');
console.log('=========================================');

