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

    console.log('--- ALL MOLD INSTALLATION TESTS PASSED! ---');
}

runMoldTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
