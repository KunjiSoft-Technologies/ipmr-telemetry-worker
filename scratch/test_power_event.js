const assert = require('assert');
const path = require('path');

// Set NODE_ENV to test to avoid starting live subscription listener
process.env.NODE_ENV = 'test';

// 1. Verify Payload Normalizer with pe
const { normalizePayload } = require('../utils/payloadNormalizer');

console.log('Testing payloadNormalizer with pe...');
const sampleRawPayloadUpper = {
    timestamp: 1785247890,
    pid: 1,
    pv: {},
    pe: {
        OFF: 1785247800,
        ON: 1785247860
    }
};

const normalizedUpper = normalizePayload(sampleRawPayloadUpper);
assert(normalizedUpper.pe, 'pe object should exist in normalized payload');
assert.strictEqual(normalizedUpper.pe.OFF, 1785247800);
assert.strictEqual(normalizedUpper.pe.ON, 1785247860);
assert.strictEqual(normalizedUpper.pe.off, 1785247800);
assert.strictEqual(normalizedUpper.pe.on, 1785247860);
console.log('✔ payloadNormalizer uppercase pe passed');

const sampleRawPayloadLower = {
    timestamp: 1785247890,
    pe: {
        off: '1785247800',
        on: '1785247860'
    }
};

const normalizedLower = normalizePayload(sampleRawPayloadLower);
assert.strictEqual(normalizedLower.pe.OFF, 1785247800, 'String timestamps should be converted to numbers');
assert.strictEqual(normalizedLower.pe.ON, 1785247860, 'String timestamps should be converted to numbers');
console.log('✔ payloadNormalizer lowercase string pe passed');

// 2. Mock RTDB and test processPowerEvent
const dbMockData = {};
const pushedData = {};

const createMockDatabase = () => ({
    ref: (p) => ({
        update: async (val) => {
            dbMockData[p] = dbMockData[p] || {};
            for (const [k, v] of Object.entries(val)) {
                dbMockData[p][k] = v;
            }
            return dbMockData[p];
        },
        set: async (val) => {
            // Emulate increment if val has ServerValue
            if (val && typeof val === 'object' && val['.sv']) {
                const inc = val['.sv'].increment || 0;
                dbMockData[p] = (dbMockData[p] || 0) + inc;
            } else {
                dbMockData[p] = val;
            }
            return val;
        },
        remove: async () => {
            delete dbMockData[p];
        },
        push: async (val) => {
            pushedData[p] = pushedData[p] || [];
            pushedData[p].push(val);
            const key = `push_key_${pushedData[p].length}`;
            dbMockData[`${p}/${key}`] = val;
            return { key };
        },
        transaction: async (fn) => {
            const current = dbMockData[p] !== undefined ? dbMockData[p] : null;
            const res = fn(current);
            dbMockData[p] = res;
            return { committed: true, snapshot: { val: () => res } };
        },
        once: async () => ({
            val: () => dbMockData[p] !== undefined ? dbMockData[p] : null,
            exists: () => dbMockData[p] !== undefined
        })
    })
});

const databaseMock = createMockDatabase();
const { processPowerEvent, calculateUnitOff } = require('../services/powerEventManager');
const { getLocalMoment, getToday } = require('../utils/timeHelpers');

async function testSingleDayPowerEvent() {
    console.log('\nTesting processPowerEvent for same-day outage...');
    const uid = 'test_uid_1';
    const unit = 5;
    const unit_off = 1788335906; // 2026-09-02 12:58:26 UTC/local
    const unit_on = 1788337070;  // 2026-09-02 13:17:50 UTC/local (diff: 1164s)

    const mockUnit = {
        info: {
            shift_a_start: 30600,
            timezone: 'Asia/Karachi'
        },
        machines: {
            M1: {
                title: 'Machine 1',
                'monitor-downtime': true,
                mold_name: 'MoldA'
            }
        },
        targets: {
            M1: {
                previousUnix: unit_off - 100
            }
        }
    };

    // Pre-populate legacy unit_off to test cleanup
    dbMockData[`users/${uid}/units/${unit}/unit_off`] = unit_off;

    await processPowerEvent(databaseMock, uid, unit, { OFF: unit_off, ON: unit_on }, mockUnit);

    const offMoment = getLocalMoment(unit_off, mockUnit);
    const onMoment = getLocalMoment(unit_on, mockUnit);
    const offDate = offMoment.format('YYYY-MM-DD');
    const offTime = offMoment.format('HH:mm:ss');
    const onDate = onMoment.format('YYYY-MM-DD');
    const onTime = onMoment.format('HH:mm:ss');

    // Check electricity_report_new
    const offReport = dbMockData[`users/${uid}/electricity_report_new/${unit}/${offDate}/${offTime}`];
    assert(offReport, 'OFF report entry must exist');
    assert.strictEqual(offReport.activity, 'off');
    assert.strictEqual(offReport.offtime, 0);

    const onReport = dbMockData[`users/${uid}/electricity_report_new/${unit}/${onDate}/${onTime}`];
    assert(onReport, 'ON report entry must exist');
    assert.strictEqual(onReport.activity, 'on');
    assert.strictEqual(onReport.offtime, 1164);
    console.log('✔ electricity_report_new entries created correctly');

    // Check users/info
    assert.strictEqual(dbMockData[`users/${uid}/info`].off_at, unit_off);
    assert.strictEqual(dbMockData[`users/${uid}/info`].on_at, unit_on);
    console.log('✔ users/info off_at and on_at updated');

    // Check cleanup of legacy unit_off
    assert.strictEqual(dbMockData[`users/${uid}/units/${unit}/unit_off`], undefined, 'legacy unit_off should be removed');
    console.log('✔ legacy unit_off removed');

    // Check offlineElectricityTrack
    const track = dbMockData[`users/${uid}/offlineElectricityTrack/${unit}`];
    assert(Array.isArray(track) && track.length === 1);
    assert.strictEqual(track[0].off, unit_off);
    assert.strictEqual(track[0].on, unit_on);
    console.log('✔ offlineElectricityTrack populated');

    // Check unit_power session and total
    const today = getToday(uid, unit_on, mockUnit);
    const sessions = pushedData[`users/${uid}/reports/factory/daily/${today}/unit_power/${unit}/sessions`];
    assert(sessions && sessions.length === 1);
    assert.strictEqual(sessions[0].off, unit_off);
    assert.strictEqual(sessions[0].on, unit_on);
    console.log('✔ factory daily unit_power sessions pushed');

    // Check machine downtime
    const downtime = pushedData[`users/${uid}/downtime/M1`];
    assert(downtime && downtime.length === 1);
    assert.strictEqual(downtime[0].start, unit_off);
    assert.strictEqual(downtime[0].end, unit_on);
    assert.strictEqual(downtime[0].status, 'OFF');
    console.log('✔ machine downtime logged for monitor-downtime');

    // Check state alignment
    assert.strictEqual(mockUnit.previousUnix, unit_on, 'previousUnix must be set to unit_on');
    assert.strictEqual(mockUnit.targets.M1.previousUnix, unit_on, 'target previousUnix must be aligned');
    console.log('✔ previousUnix and target previousUnix aligned');

    // Test Idempotency
    const initialSessionCount = sessions.length;
    await processPowerEvent(databaseMock, uid, unit, { OFF: unit_off, ON: unit_on }, mockUnit);
    assert.strictEqual(sessions.length, initialSessionCount, 'Subsequent call with identical pe must not re-push session');
    console.log('✔ Idempotency check passed');
}

async function testCrossDayPowerEvent() {
    console.log('\nTesting processPowerEvent across midnight / multiple days...');
    const uid = 'test_uid_cross';
    const unit = 2;
    // Day 1: 2026-09-02 20:00:00 UTC (1788379200)
    // Day 2: 2026-09-03 10:00:00 UTC (1788429600)
    const unit_off = 1788379200;
    const unit_on = 1788429600;

    const mockUnit = {
        info: {
            shift_a_start: 30600, // 08:30:00 (30600)
            timezone: 'Asia/Karachi'
        },
        machines: {
            M2: {
                title: 'Machine 2',
                'monitor-downtime': true
            }
        }
    };

    await processPowerEvent(databaseMock, uid, unit, { OFF: unit_off, ON: unit_on }, mockUnit);

    const startDay = getToday(uid, unit_off, mockUnit);
    const today = getToday(uid, unit_on, mockUnit);
    assert.notStrictEqual(startDay, today, 'Days must be different');

    const day1Sessions = pushedData[`users/${uid}/reports/factory/daily/${startDay}/unit_power/${unit}/sessions`];
    const day2Sessions = pushedData[`users/${uid}/reports/factory/daily/${today}/unit_power/${unit}/sessions`];

    assert(day1Sessions && day1Sessions.length >= 1, 'Day 1 must receive session partition');
    assert(day2Sessions && day2Sessions.length >= 1, 'Day 2 must receive session partition');

    assert.strictEqual(day1Sessions[0].off, unit_off);
    assert.strictEqual(day2Sessions[0].on, unit_on);
    assert.strictEqual(day1Sessions[0].on, day2Sessions[0].off, 'Day 1 on must match Day 2 off boundary');
    console.log(`✔ Cross-day outage successfully partitioned across ${startDay} and ${today}`);
}

async function runAll() {
    await testSingleDayPowerEvent();
    await testCrossDayPowerEvent();
    console.log('\n🎉 ALL POWER EVENT TESTS PASSED SUCCESSFULLY!');
}

runAll().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
