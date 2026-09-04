const assert = require('assert');
const { normalizePayload } = require('../utils/payloadNormalizer');
const { writeInfluxRecord } = require('../config/Influx');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

console.log('--- STARTING LAST 10 PACKETS AUDIT TESTS ---');

const userSamplePayload = {
  "action": "RECORDS",
  "unix": 1788532900,
  "remaining": 0,
  "data": {
    "timestamp": 1788532900,
    "pv": {
      "R": {
        "v": { "n": 233, "x": 237, "g": 235, "w": 237 },
        "llv": { "n": 406, "x": 411, "g": 409, "w": 411 },
        "a": { "n": 2, "x": 14, "g": 7, "w": 2 },
        "pf": { "n": -0.964, "x": -0.732, "g": -0.884, "w": -0.924 },
        "f": { "n": 50, "x": 50, "g": 50, "w": 50 },
        "p": { "n": 453, "x": 2631, "g": 1581, "w": 453 },
        "ap": { "n": 490, "x": 3368, "g": 1794, "w": 490 },
        "rp": { "n": -1162, "x": -167, "g": -539, "w": -196 },
        "cthd": { "n": 0, "x": 114, "g": 26, "w": 0 },
        "vthd": { "n": 1, "x": 2, "g": 1, "w": 2 },
        "llvthd": { "n": 1, "x": 7, "g": 3, "w": 6 }
      },
      "S": {
        "v": { "n": 234, "x": 238, "g": 235, "w": 236 },
        "llv": { "n": 406, "x": 411, "g": 409, "w": 410 },
        "a": { "n": 0, "x": 11, "g": 2, "w": 0 },
        "pf": { "n": -0.839, "x": -0.207, "g": -0.614, "w": -0.656 },
        "f": { "n": 50, "x": 50, "g": 50, "w": 50 },
        "p": { "n": 43, "x": 2116, "g": 543, "w": 56 },
        "ap": { "n": 85, "x": 2631, "g": 771, "w": 85 },
        "rp": { "n": -749, "x": -25, "g": -179, "w": -49 },
        "cthd": { "n": 0, "x": 108, "g": 20, "w": 0 },
        "vthd": { "n": 1, "x": 2, "g": 1, "w": 2 },
        "llvthd": { "n": 1, "x": 6, "g": 3, "w": 5 }
      },
      "T": {
        "v": { "n": 233, "x": 239, "g": 237, "w": 237 },
        "llv": { "n": 406, "x": 411, "g": 408, "w": 410 },
        "a": { "n": 0, "x": 5, "g": 1, "w": 0 },
        "pf": { "n": -0.675, "x": -0.275, "g": -0.464, "w": -0.295 },
        "f": { "n": 50, "x": 50, "g": 50, "w": 50 },
        "p": { "n": 14, "x": 736, "g": 184, "w": 17 },
        "ap": { "n": 47, "x": 1316, "g": 357, "w": 59 },
        "rp": { "n": -775, "x": -10, "g": -119, "w": -17 },
        "cthd": { "n": 0, "x": 144, "g": 39, "w": 0 },
        "vthd": { "n": 1, "x": 3, "g": 1, "w": 2 },
        "llvthd": { "n": 0, "x": 6, "g": 3, "w": 4 }
      },
      "SUM": {
        "v": { "n": 234, "x": 237, "g": 235, "w": 237 },
        "llv": { "n": 405, "x": 411, "g": 409, "w": 410 },
        "a": { "n": 0, "x": 11, "g": 4, "w": 0 },
        "pf": { "n": -0.882, "x": -0.485, "g": -0.732, "w": -0.719 },
        "f": { "n": 50, "x": 50, "g": 50, "w": 50 },
        "p": { "n": 374, "x": 5484, "g": 2369, "w": 374 },
        "ap": { "n": 520, "x": 7814, "g": 3218, "w": 520 },
        "rp": { "n": -2032, "x": -231, "g": -861, "w": -231 },
        "cthd": { "n": 0, "x": 103, "g": 31, "w": 0 },
        "vthd": { "n": 1, "x": 3, "g": 1, "w": 2 },
        "na": { "n": 1, "x": 11, "g": 6, "w": 1 },
        "vah": 810,
        "wh_i": 640,
        "wh_e": 0,
        "wh_t": 640,
        "varh_i": 0,
        "varh_c": 270,
        "varh_t": 270
      }
    },
    "rtc": true,
    "av": {
      "t": { "n": 27.5, "x": 27.8, "g": 27.5, "w": 27.5 },
      "ts": "normal",
      "sv": { "n": 25.2, "x": 25.4, "g": 25.2, "w": 25.2 },
      "bv": { "n": 2576, "x": 2925, "g": 2722, "w": 2576 },
      "bs": "charged"
    },
    "dv": {
      "x1": { "m": 4, "p": 2, "v": [ 27.2 ] },
      "x2": { "m": 0, "p": 0, "v": [] },
      "x3": { "m": 2, "p": 2, "v": [] }
    },
    "packet_id": 72,
    "pid": 72,
    "version": "3.14.35",
    "missing_in_last_10": 1,
    "last_10_packets": [
      { "id": 62, "ts": 1788532563, "st": "ok" },
      { "id": 63, "ts": 1788532615, "st": "ok" },
      { "id": 64, "ts": 1788532645, "st": "ok" },
      { "id": 65, "ts": 1788532675, "st": "ok" },
      { "id": 66, "ts": 1788532713, "st": "save_fail:write_err" },
      { "id": 67, "ts": 1788532743, "st": "ok" },
      { "id": 68, "ts": 1788532773, "st": "ok" },
      { "id": 69, "ts": 1788532803, "st": "ok" },
      { "id": 70, "ts": 1788532833, "st": "ok" },
      { "id": 71, "ts": 1788532863, "st": "ok" }
    ]
  }
};

async function runTests() {
    console.log('1. Testing payload normalization with nested data & last 10 packets...');
    const normalized = normalizePayload(userSamplePayload);

    // Verify root unwrapping
    assert.strictEqual(normalized.action, 'RECORDS');
    assert.strictEqual(normalized.packet_id, 72);
    assert.strictEqual(normalized.using_external_rtc, true);
    assert.strictEqual(normalized.version, '3.14.35');
    assert.strictEqual(normalized.missing_in_last_10, 1);
    assert.ok(Array.isArray(normalized.last_10_packets));
    assert.strictEqual(normalized.last_10_packets.length, 10);
    assert.strictEqual(normalized.last_10_packets[4].st, 'save_fail:write_err');

    // Verify phase_values were normalized
    assert.ok(normalized.phase_values, 'phase_values must be defined');
    assert.ok(normalized.phase_values.R.VOLTAGE, 'R.VOLTAGE must be defined');
    assert.strictEqual(normalized.phase_values.R.VOLTAGE.min, 233);
    assert.strictEqual(normalized.phase_values.R.VOLTAGE.max, 237);
    assert.strictEqual(normalized.phase_values.R.VOLTAGE.avg, 235);
    assert.strictEqual(normalized.phase_values.R.VOLTAGE.now, 237);
    assert.strictEqual(normalized.phase_values.SUM.SUM_WH_Total, 640);

    // Verify analog_values
    assert.ok(normalized.analog_values, 'analog_values must be defined');
    assert.strictEqual(normalized.analog_values.temperature.min, 27.5);
    assert.strictEqual(normalized.analog_values.temperature_status, 'normal');

    // Verify digital_values
    assert.ok(normalized.digital_values, 'digital_values must be defined');
    assert.deepStrictEqual(normalized.digital_values.X1, [27.2]);

    console.log('✓ Normalization checks passed.');

    console.log('2. Testing writeInfluxRecord with packet audit data...');
    const testMac = 'test_audit_validation_mac';
    const writeResult = await writeInfluxRecord('test_uid_audit', 1, testMac, {
        ...normalized,
        success: true,
        realtime: true,
        values: { "60_a": 0 },
        now_values: {},
        unix: 1788532900,
        temperature: 27.5,
        active_alerts: 0
    });

    assert.ok(writeResult, 'writeInfluxRecord should return a result');
    assert.strictEqual(writeResult.success, true, `Write to InfluxDB failed: ${JSON.stringify(writeResult)}`);
    console.log('✓ writeInfluxRecord returned HTTP success (204).');

    console.log('\n✓ ALL TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
