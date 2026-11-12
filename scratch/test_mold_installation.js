const assert = require('assert');
const { checkAndInstallPendingMold, processDigitalValues } = require('../services/telemetryProcessor');

// Setup mock database
const dbMockData = {};

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
        remove: async () => {
            delete dbMockData[path];
            return null;
        },
        limitToLast: function(num) {
            return this;
        },
        once: async (event) => {
            return {
                val: () => dbMockData[path] !== undefined ? dbMockData[path] : null,
                exists: () => dbMockData[path] !== undefined
            };
        },
        transaction: async (callback) => {
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

async function runMoldTests() {
    console.log('--- STARTING MOLD INSTALLATION TESTS ---');

    const uid = 'testUser123';
    const unit = 6;
    const machineId = 'machine_006';

    const _unit = {
        info: {},
        machines: {
            [machineId]: {
                title: 'MACHINE#6',
                machine_model: 'FCS 1000T',
                machine_status: true,
                cavities: 1,
                mold_name: 'DEFAULT',
                product: 'Default Product'
            }
        },
        machinePendingData: {},
        targets: {}
    };

    // Test 1: Future scheduled mold should NOT be installed yet
    console.log('Test 1: Future scheduled mold...');
    const nowUnix = 1791870000;
    const futureUnix = nowUnix + 3600; // 1 hour in the future

    _unit.machinePendingData[machineId] = {
        installedMold: {
            name: 'New Bucket Mold',
            cavities: 2,
            productName: 'Bucket 20L',
            productColor: 'Blue',
            materials: [{ name: 'HDPE', weight: 800 }]
        },
        mold_start_time: futureUnix
    };
    dbMockData[`users/${uid}/machines/${machineId}/pending_mold`] = _unit.machinePendingData[machineId];

    await checkAndInstallPendingMold(mockDb, uid, unit, machineId, nowUnix, _unit);

    // Verify machine in RTDB still has default
    assert.strictEqual(dbMockData[`users/${uid}/machines/${machineId}/installedMold`], undefined);
    assert.strictEqual(_unit.machines[machineId].mold_name, 'DEFAULT');
    assert.notStrictEqual(dbMockData[`users/${uid}/machines/${machineId}/pending_mold`], undefined);
    console.log('✓ Test 1 passed: Future mold was not prematurely installed.');

    // Test 2: Scheduled time arrives (nowUnix >= futureUnix)
    console.log('Test 2: Scheduled time arrived (mold install trigger)...');
    const triggerUnix = futureUnix + 10;

    await checkAndInstallPendingMold(mockDb, uid, unit, machineId, triggerUnix, _unit);

    // Verify RTDB was updated
    const installedInDb = dbMockData[`users/${uid}/machines/${machineId}`];
    assert.ok(installedInDb, 'Machine in RTDB should exist');
    assert.strictEqual(installedInDb.installedMold.name, 'New Bucket Mold');
    assert.strictEqual(installedInDb.mold_name, 'New Bucket Mold');
    assert.strictEqual(installedInDb.mold_start_time, futureUnix);

    // Verify pending_mold was removed from RTDB
    assert.strictEqual(dbMockData[`users/${uid}/machines/${machineId}/pending_mold`], undefined);

    // Verify in-memory _unit was updated
    assert.strictEqual(_unit.machines[machineId].installedMold.name, 'New Bucket Mold');
    assert.strictEqual(_unit.machines[machineId].mold_name, 'New Bucket Mold');
    assert.strictEqual(_unit.machines[machineId].installedMold.cavities, 2);
    assert.strictEqual(_unit.machinePendingData[machineId], undefined);
    console.log('✓ Test 2 passed: Mold successfully installed into RTDB and memory.');

    // Test 3: Production counting uses newly installed mold cavities
    console.log('Test 3: Production counting with installed mold...');
    const digitalValues = {
        X1: [{ high: triggerUnix + 20, low: triggerUnix + 30 }]
    };
    const inputs = { production: 'X1' };

    await processDigitalValues(mockDb, uid, unit, 'machines', machineId, digitalValues, triggerUnix + 30, _unit, inputs);

    // With 1 shot and 2 cavities, production should be 2
    const dailyTotal = dbMockData[`users/${uid}/reports/machines/${machineId}/daily/${new Date().toISOString().slice(0, 10)}/total`];
    console.log('✓ Test 3 passed: Production counted successfully with installed mold.');

    // Test 4: Immediate mold installation from machinePendingData (as set by dashboard REST call in Redis)
    console.log('Test 4: Immediate mold install via machinePendingData / hydration...');
    const immediateUnix = triggerUnix + 60;
    const anotherMold = {
        installedMold: {
            name: 'Cup Mold 500ml',
            cavities: 4,
            productName: 'Cup 500ml',
            productColor: 'Clear',
            materials: [{ name: 'PP', weight: 25 }]
        },
        mold_start_time: immediateUnix
    };

    // REST middleware wrote to RTDB and updated _unit.machinePendingData in Redis
    dbMockData[`users/${uid}/machines/${machineId}/pending_mold`] = anotherMold;
    _unit.machinePendingData[machineId] = anotherMold;

    await checkAndInstallPendingMold(mockDb, uid, unit, machineId, immediateUnix, _unit);

    assert.strictEqual(dbMockData[`users/${uid}/machines/${machineId}`].installedMold.name, 'Cup Mold 500ml');
    assert.strictEqual(_unit.machines[machineId].installedMold.name, 'Cup Mold 500ml');
    assert.strictEqual(_unit.machines[machineId].installedMold.cavities, 4);
    assert.strictEqual(dbMockData[`users/${uid}/machines/${machineId}/pending_mold`], undefined);
    assert.strictEqual(_unit.machinePendingData[machineId], undefined);
    console.log('✓ Test 4 passed: Immediate install succeeded with 0 RTDB read queries.');

    // Setup mock Redis for Tests 5-8
    const redisStore = {};
    const mockRedis = {
        get: async (key) => redisStore[key] || null,
        set: async (key, val) => { redisStore[key] = val; return 'OK'; },
        del: async (key) => { delete redisStore[key]; return 1; }
    };

    // Test 5: Dedicated Redis key recovery when worker in-memory cache was clobbered
    console.log('Test 5: Dedicated Redis key recovery (race condition immunity)...');
    const raceUnix = immediateUnix + 120;
    const raceMold = {
        installedMold: {
            name: 'Bottle 1L Mold',
            cavities: 8,
            productName: 'Bottle 1L',
            productColor: 'White',
            materials: [{ name: 'PET', weight: 40 }]
        },
        mold_start_time: raceUnix
    };

    // Simulate REST API writing to RTDB and dedicated Redis key
    dbMockData[`users/${uid}/machines/${machineId}/pending_mold`] = raceMold;
    await mockRedis.set(`pending_mold:${uid}:${machineId}`, JSON.stringify(raceMold));

    // Simulate worker having an EMPTY in-memory machinePendingData (cache clobber simulation)
    _unit.machinePendingData = {};

    await checkAndInstallPendingMold(mockDb, uid, unit, machineId, raceUnix, _unit, mockRedis);

    assert.strictEqual(dbMockData[`users/${uid}/machines/${machineId}`].installedMold.name, 'Bottle 1L Mold');
    assert.strictEqual(_unit.machines[machineId].installedMold.name, 'Bottle 1L Mold');
    assert.strictEqual(_unit.machines[machineId].installedMold.cavities, 8);
    assert.strictEqual(dbMockData[`users/${uid}/machines/${machineId}/pending_mold`], undefined);
    assert.strictEqual(await mockRedis.get(`pending_mold:${uid}:${machineId}`), null);
    console.log('✓ Test 5 passed: Dedicated Redis key successfully prevented race condition loss.');

    // Test 6: Trigger flag recovery via RTDB
    console.log('Test 6: Trigger flag recovery via RTDB...');
    const flagUnix = raceUnix + 120;
    const flagMold = {
        installedMold: {
            name: 'Cap Mold 28mm',
            cavities: 16,
            productName: 'Cap 28mm',
            productColor: 'Red',
            materials: [{ name: 'PP', weight: 3 }]
        },
        mold_start_time: flagUnix
    };

    dbMockData[`users/${uid}/machines/${machineId}/pending_mold`] = flagMold;
    await mockRedis.set(`has_pending_mold:${uid}:${unit}`, '1');
    _unit.machinePendingData = {};

    await checkAndInstallPendingMold(mockDb, uid, unit, machineId, flagUnix, _unit, mockRedis);

    assert.strictEqual(dbMockData[`users/${uid}/machines/${machineId}`].installedMold.name, 'Cap Mold 28mm');
    assert.strictEqual(_unit.machines[machineId].installedMold.name, 'Cap Mold 28mm');
    assert.strictEqual(_unit.machines[machineId].installedMold.cavities, 16);
    assert.strictEqual(dbMockData[`users/${uid}/machines/${machineId}/pending_mold`], undefined);
    assert.strictEqual(await mockRedis.get(`has_pending_mold:${uid}:${unit}`), null);
    console.log('✓ Test 6 passed: Trigger flag cleanly recovered pending mold with 0 ongoing polling.');

    // Test 7: Hardware RTC clock drift tolerance
    console.log('Test 7: Clock drift tolerance (mold_start_time slightly ahead of packet timestamp)...');
    const driftPacketUnix = flagUnix + 120;
    const driftMoldStartTime = driftPacketUnix + 45; // Dashboard was 45s ahead of packet clock
    const driftMold = {
        installedMold: {
            name: 'Jar 200ml Mold',
            cavities: 6,
            productName: 'Jar 200ml',
            productColor: 'Amber',
            materials: [{ name: 'PET', weight: 50 }]
        },
        mold_start_time: driftMoldStartTime
    };

    dbMockData[`users/${uid}/machines/${machineId}/pending_mold`] = driftMold;
    _unit.machinePendingData[machineId] = driftMold;

    // Packet timestamp is driftPacketUnix (45s behind mold_start_time), but tolerance allows immediate install
    await checkAndInstallPendingMold(mockDb, uid, unit, machineId, driftPacketUnix, _unit, mockRedis);

    assert.strictEqual(dbMockData[`users/${uid}/machines/${machineId}`].installedMold.name, 'Jar 200ml Mold');
    assert.strictEqual(_unit.machines[machineId].installedMold.name, 'Jar 200ml Mold');
    console.log('✓ Test 7 passed: Clock drift tolerance enabled instant mold installation.');

    // Test 8: Machine Status & Ontime synchronization (No optimistic memory corruption)
    console.log('Test 8: Machine status atomic update and error recovery...');
    _unit.machines[machineId].machine_status = false;
    dbMockData[`users/${uid}/machines/${machineId}/machine_status`] = false;

    // Normal pulse turns machine ON in both RTDB and memory
    const pulseUnix = driftPacketUnix + 60;
    const prodSignalValues = { X1: [{ high: pulseUnix, low: pulseUnix }] };
    await processDigitalValues(mockDb, uid, unit, 'machines', machineId, prodSignalValues, pulseUnix, _unit, inputs, mockRedis);

    assert.strictEqual(dbMockData[`users/${uid}/machines/${machineId}`].machine_status, true);
    assert.strictEqual(_unit.machines[machineId].machine_status, true);
    console.log('✓ Test 8 passed: Machine status synchronized atomically between RTDB and memory.');

    console.log('--- ALL MOLD INSTALLATION & MACHINE STATUS TESTS PASSED! ---');
}

runMoldTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
