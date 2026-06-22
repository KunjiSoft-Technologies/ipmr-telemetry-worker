const path = require('path');
const assert = require('assert');

// Set NODE_ENV to test to avoid starting live subscription listener
process.env.NODE_ENV = 'test';

// 1. Setup require cache mocks before loading index.js
const dbMockData = {};
const databaseMock = {
    ref: (p) => ({
        update: async (val) => {
            dbMockData[p] = dbMockData[p] || {};
            // Emulate Firebase RTDB null value deletion
            for (const [k, v] of Object.entries(val)) {
                if (v === null) {
                    delete dbMockData[p][k];
                } else {
                    dbMockData[p][k] = v;
                }
            }
            return { key: p.split('/').pop() };
        },
        remove: async () => {
            delete dbMockData[p];
        },
        once: async (event) => {
            return {
                val: () => dbMockData[p] !== undefined ? dbMockData[p] : null,
                exists: () => dbMockData[p] !== undefined,
                child: (childKey) => {
                    const childVal = dbMockData[p] ? dbMockData[p][childKey] : undefined;
                    return {
                        exists: () => childVal !== undefined
                    };
                }
            };
        },
        set: async (val) => {
            dbMockData[p] = val;
        }
    })
};

const redisMock = {};

const influxMock = {
    writeInfluxRecord: async () => {}
};

let mockUnit = {
    info: {
        shift_a_start: 28800, // 08:00
        shifts: 3
    },
    machines: {
        mach1: { title: 'Machine 1' }
    },
    uploadingPrev: { status: true, time: null }
};

const macLookupMock = {
    lookupMacAndUnit: async (mac) => {
        return {
            uid: 'l9hMeiJiJxT94ePlLvdeVMEZhCc2',
            unit: 8,
            connection: { type: 'machines', id: 'plastisol_imm04' },
            inputs: { X1: 'production' },
            _unit: mockUnit
        };
    },
    saveUnitToCache: async (uid, unit, unitObj) => {
        mockUnit = unitObj;
    }
};

const telemetryProcessorMock = {
    checkDuplicate: async () => false,
    verifySequence: async () => {},
    trackTemperature: async () => 25,
    processPhaseValues: async () => {},
    processDigitalValues: async () => {}
};

const alertManagerMock = {
    processAlerts: async () => {}
};

const pubSubMock = {
    PubSub: function() {
        return {
            subscription: () => ({
                on: () => {}
            })
        };
    }
};

// Helper to inject mock into require cache
function injectMock(modulePath, mockExports) {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: mockExports
    };
}

// Inject all mocks
injectMock('../config/database', databaseMock);
injectMock('../config/redis', redisMock);
injectMock('../config/Influx', influxMock);
injectMock('../services/macLookup', macLookupMock);
injectMock('../services/telemetryProcessor', telemetryProcessorMock);
injectMock('../services/alertManager', alertManagerMock);
injectMock('@google-cloud/pubsub', pubSubMock);

// Load index.js to get handleMessage
const { handleMessage } = require('../index');

async function runTests() {
    console.log('--- STARTING UPLOAD REMAINING TESTS ---');

    const mockMessage = (dataObj) => {
        return {
            attributes: {
                machine_id: '14:2b:2f:f9:95:98',
                timestamp: '1782145451'
            },
            data: Buffer.from(JSON.stringify(dataObj)),
            ack: () => { console.log('Message ACKed'); },
            nack: () => { console.log('Message NACKed'); }
        };
    };

    // Test 1: Upload in progress (remaining > 0)
    try {
        console.log('\nRunning Test 1: Upload in progress...');
        
        const payload = {
            action: 'RECORDS',
            remaining: 45,
            data: {
                timestamp: 1782145451,
                pv: {
                    R: {
                        v: { n: 0, x: 0, g: 0, w: 0 }
                    }
                }
            }
        };

        await handleMessage(mockMessage(payload));

        const unitPath = '/users/l9hMeiJiJxT94ePlLvdeVMEZhCc2/units/8';
        console.log('RTDB unit data:', dbMockData[unitPath]);
        
        assert.strictEqual(dbMockData[unitPath].realtime, false, 'realtime should be false during upload');
        assert.strictEqual(dbMockData[unitPath].uploadRemaining, 45, 'uploadRemaining should be 45');
        const moment = require('moment');
        assert.strictEqual(dbMockData[unitPath].uploadedTil, moment.unix(1782145451).format("YYYY-MM-DD HH:mm:ss"), 'uploadedTil should match packet timestamp');
        assert.strictEqual(mockUnit.uploadingPrev.status, true, 'uploadingPrev status should be true');

        console.log('✓ Test 1 passed.');
    } catch (err) {
        console.error('✗ Test 1 failed:', err);
        process.exit(1);
    }

    // Test 2: Upload complete (remaining === 0)
    try {
        console.log('\nRunning Test 2: Upload complete...');

        // Setup mock previous day factory report to not completed to trigger logic
        const moment = require('moment');
        const { getToday } = require('../utils/timeHelpers');
        const today = getToday('l9hMeiJiJxT94ePlLvdeVMEZhCc2', 1782145451, mockUnit);
        const prevDay = moment(today).subtract(1, 'days').format('YYYY-MM-DD');
        const prevDayCompletedPath = `users/l9hMeiJiJxT94ePlLvdeVMEZhCc2/reports/factory/daily/${prevDay}/completed/8`;
        dbMockData[prevDayCompletedPath] = null; // not completed yet
        
        const payload = {
            action: 'RECORDS',
            remaining: 0,
            data: {
                timestamp: 1782145451,
                pv: {
                    R: {
                        v: { n: 0, x: 0, g: 0, w: 0 }
                    }
                }
            }
        };

        await handleMessage(mockMessage(payload));

        const unitPath = '/users/l9hMeiJiJxT94ePlLvdeVMEZhCc2/units/8';
        console.log('RTDB unit data:', dbMockData[unitPath]);
        
        assert.strictEqual(dbMockData[unitPath].realtime, true, 'realtime should be true after upload completes');
        assert.strictEqual(dbMockData[unitPath].uploadRemaining, undefined, 'uploadRemaining should be removed');
        assert.strictEqual(dbMockData[unitPath].uploadedTil, undefined, 'uploadedTil should be removed');
        assert.strictEqual(mockUnit.uploadingPrev.status, false, 'uploadingPrev status should be false');

        // Check that daily report completed keys were set
        assert.strictEqual(dbMockData[prevDayCompletedPath], true, 'previous day factory completed should be set to true');
        assert.strictEqual(dbMockData[`users/l9hMeiJiJxT94ePlLvdeVMEZhCc2/reports/machines/mach1/daily/${prevDay}/completed`], true, 'previous day machine completed should be set to true');

        console.log('✓ Test 2 passed.');
    } catch (err) {
        console.error('✗ Test 2 failed:', err);
        process.exit(1);
    }

    console.log('\n--- ALL TESTS PASSED SUCCESSFULLY! ---');
}

runTests().catch(err => {
    console.error('Unhandled test failure:', err);
    process.exit(1);
});
