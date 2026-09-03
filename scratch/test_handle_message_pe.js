const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const dbMockData = {};
const pushedData = {};

const databaseMock = {
    ref: (p) => ({
        update: async (val) => {
            dbMockData[p] = dbMockData[p] || {};
            for (const [k, v] of Object.entries(val)) {
                if (v === null) delete dbMockData[p][k];
                else dbMockData[p][k] = v;
            }
            return { key: p.split('/').pop() };
        },
        set: async (val) => {
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
            const key = `push_${pushedData[p].length}`;
            dbMockData[`${p}/${key}`] = val;
            return { key };
        },
        transaction: async (fn) => {
            const current = dbMockData[p] !== undefined ? dbMockData[p] : null;
            const res = fn(current);
            dbMockData[p] = res;
            return { committed: true, snapshot: { val: () => res } };
        },
        limitToLast: () => ({
            once: async () => ({
                val: () => dbMockData[p] !== undefined ? dbMockData[p] : null,
                exists: () => dbMockData[p] !== undefined
            })
        }),
        once: async () => ({
            val: () => dbMockData[p] !== undefined ? dbMockData[p] : null,
            exists: () => dbMockData[p] !== undefined,
            child: () => ({ exists: () => false })
        })
    })
};

const redisMock = {
    set: async () => 'OK',
    del: async () => 1
};

let influxWritten = false;
const influxMock = {
    writeInfluxRecord: async () => {
        influxWritten = true;
    }
};

let mockUnit = {
    info: {
        shift_a_start: 30600,
        shifts: 2
    },
    machines: {
        plastisol_imm04: {
            title: 'Plastisol IMM04',
            'monitor-downtime': true
        }
    }
};

const macLookupMock = {
    lookupMacAndUnit: async (mac) => ({
        uid: 'test_user_e2e',
        unit: 1,
        connection: { type: 'machines', id: 'plastisol_imm04' },
        inputs: {},
        _unit: mockUnit
    }),
    saveUnitToCache: async (uid, unit, unitObj) => {
        mockUnit = unitObj;
    }
};

// Override requires in cache
require.cache[path.resolve(__dirname, '../config/database.js')] = { exports: databaseMock };
require.cache[path.resolve(__dirname, '../config/redis.js')] = { exports: redisMock };
require.cache[path.resolve(__dirname, '../config/Influx.js')] = { exports: influxMock };
require.cache[path.resolve(__dirname, '../services/macLookup.js')] = { exports: macLookupMock };

const { handleMessage } = require('../index.js');

async function testE2E() {
    console.log('Running End-to-End handleMessage test with pe...');
    const messagePayload = {
        timestamp: 1785247890,
        packet_id: 1,
        mac: 'AA:BB:CC:DD:EE:FF',
        pv: {},
        pe: {
            OFF: 1785247800,
            ON: 1785247860
        }
    };

    let acked = false;
    let nacked = false;

    const fakeMessage = {
        attributes: { mac: 'AA:BB:CC:DD:EE:FF' },
        data: Buffer.from(JSON.stringify(messagePayload)),
        ack: () => { acked = true; },
        nack: () => { nacked = true; }
    };

    await handleMessage(fakeMessage);

    assert(acked, 'Message should be acknowledged');
    assert(!nacked, 'Message should not be nacked');
    assert(influxWritten, 'Influx record should be written');

    // Check electricity_report_new
    const offReport = dbMockData['users/test_user_e2e/electricity_report_new/1/2026-07-28/14:10:00'];
    const onReport = dbMockData['users/test_user_e2e/electricity_report_new/1/2026-07-28/14:11:00'];
    assert(offReport, 'OFF report should be written');
    assert.strictEqual(offReport.activity, 'off');
    assert(onReport, 'ON report should be written');
    assert.strictEqual(onReport.activity, 'on');
    assert.strictEqual(onReport.offtime, 60);

    // Check info
    assert.strictEqual(dbMockData['users/test_user_e2e/info'].off_at, 1785247800);
    assert.strictEqual(dbMockData['users/test_user_e2e/info'].on_at, 1785247860);

    // Check factory daily unit_power sessions
    const sessions = pushedData['users/test_user_e2e/reports/factory/daily/2026-07-28/unit_power/1/sessions'];
    assert(sessions && sessions.length === 1);
    assert.strictEqual(sessions[0].off, 1785247800);
    assert.strictEqual(sessions[0].on, 1785247860);

    console.log('✔ E2E handleMessage with pe verified successfully!');
    process.exit(0);
}

testE2E().catch(err => {
    console.error('❌ E2E test failed:', err);
    process.exit(1);
});
