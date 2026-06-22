const database = require('../config/database');
const redis = require('../config/redis');

/**
 * Resolves MAC address to uid and unit, and retrieves or initializes the _unit cache.
 * @param {string} mac - The MAC address (machine_id attribute).
 * @returns {Promise<{ uid: string, unit: number, connection: any, _unit: Object }|null>}
 */
async function lookupMacAndUnit(mac) {
    if (!mac) return null;

    // 1. MAC Lookup: Query Redis for key mac_mapping:${mac}
    const redisKey = `mac_mapping:${mac}`;
    let mappingRaw = await redis.get(redisKey);
    let mapping = null;

    if (mappingRaw) {
        try {
            mapping = JSON.parse(mappingRaw);
        } catch (e) {
            console.error(`Error parsing MAC mapping for ${mac}:`, e);
        }
    }

    if (!mapping) {
        // Fetch /mac_lookup/${mac} from RTDB
        const snap = await database.ref(`/mac_lookup/${mac}`).once('value');
        mapping = snap.val();

        if (mapping) {
            // Cache it in Redis for 3600 seconds
            await redis.set(redisKey, JSON.stringify(mapping), 'EX', 3600);
        } else {
            console.warn(`No mapping found in RTDB for MAC: ${mac}`);
            return null;
        }
    }

    const { uid, unit, connection } = mapping;
    if (!uid || unit === undefined) {
        console.warn(`Invalid mapping object for MAC: ${mac}`, mapping);
        return null;
    }

    // 2. Fetch Unit Data: look up the full _unit object from Redis hash units using field ${uid}-${unit}
    const hashField = `${uid}-${unit}`;
    let _unit = null;
    const _unitRaw = await redis.hget('units', hashField);

    if (_unitRaw) {
        try {
            const parsed = JSON.parse(_unitRaw);
            // Check custom TTL of 600s
            if (parsed && parsed.expiresAt && Date.now() < parsed.expiresAt) {
                _unit = parsed;
            } else {
                // Expired. Clean up.
                await redis.hdel('units', hashField);
            }
        } catch (e) {
            console.error(`Error parsing cached _unit for ${hashField}:`, e);
        }
    }

    // 3. Initialize Unit Cache: If not found, populate it from RTDB using Promise.all
    if (!_unit) {
        _unit = {
            connected: true,
            machines: {},
            equipments: {},
            info: {},
            address: {},
            targets: {},
            error: {},
            extentionErrors: {},
            errorData: {},
            idCheck: {},
            connection: null,
            uploadingPrev: { status: true, time: null },
            machinePendingData: {},
            packetID: { count: 0, val: 0 },
            offlineElectricityTrack: [],
            trackingUpDown: false,
            connections: {}
        };

        const paths = {
            connection: `/users/${uid}/units/${unit}/connection`,
            packetID: `/users/${uid}/units/${unit}/packetID`,
            packetOrder: `/users/${uid}/units/${unit}/packetOrder`,
            lastNowCounts: `/users/${uid}/units/${unit}/lastNowCounts`,
            targets: `/users/${uid}/targets/${unit}`,
            offlineElectricityTrack: `/users/${uid}/offlineElectricityTrack/${unit}`,
            connections: `/users/${uid}/connections/${unit}`,
            address: `/users/${uid}/address/${unit}`,
            errors: `/users/${uid}/errors/extention-error/${unit}`,
            machines: `/users/${uid}/machines`,
            equipments: `/users/${uid}/equipments`,
            factories: `/users/${uid}/factories`,
            info: `/users/${uid}/info`
        };

        const keys = Object.keys(paths);
        const promises = keys.map(key => database.ref(paths[key]).once('value').then(snap => snap.val()));
        const rtdbData = await Promise.all(promises);

        const results = {};
        keys.forEach((key, index) => {
            results[key] = rtdbData[index];
        });

        // Map results to _unit object
        if (results.connection !== null && results.connection !== undefined) {
            _unit.connection = results.connection;
        }
        if (results.packetID !== null && results.packetID !== undefined) {
            _unit.packetID.val = results.packetID;
        }
        if (results.packetOrder !== null && results.packetOrder !== undefined) {
            _unit.packetOrder = results.packetOrder;
        }
        if (results.lastNowCounts !== null && results.lastNowCounts !== undefined) {
            _unit.lastNowCounts = results.lastNowCounts;
        }
        if (results.targets !== null && results.targets !== undefined) {
            _unit.targets = results.targets;
        }
        if (results.offlineElectricityTrack !== null && results.offlineElectricityTrack !== undefined) {
            _unit.offlineElectricityTrack = Array.isArray(results.offlineElectricityTrack)
                ? results.offlineElectricityTrack
                : Object.values(results.offlineElectricityTrack || {});
        }
        if (results.connections !== null && results.connections !== undefined) {
            _unit.connections = results.connections;
        }
        if (results.address !== null && results.address !== undefined) {
            _unit.address = results.address;
        }
        if (results.errors !== null && results.errors !== undefined) {
            _unit.errorData = results.errors;
        }

        // Machines
        const machinesVal = results.machines || {};
        for (const [key, machine] of Object.entries(machinesVal)) {
            if (machine && Number(machine.unit) === Number(unit)) {
                _unit.machines[key] = machine;
                if (machine.pending_mold !== undefined) {
                    _unit.machinePendingData[machine.post] = machine.pending_mold;
                }
            }
        }

        // Equipments
        const equipmentsVal = results.equipments || {};
        for (const [key, equipment] of Object.entries(equipmentsVal)) {
            if (equipment && Number(equipment.unit) === Number(unit)) {
                _unit.equipments[key] = equipment;
            }
        }

        // Factories & Info
        let subFactoryInfo = null;
        let subFactoryKey = null;
        const factoriesVal = results.factories || {};
        for (const [fKey, factory] of Object.entries(factoriesVal)) {
            if (factory && factory.units) {
                let hasUnit = false;
                if (Array.isArray(factory.units)) {
                    hasUnit = factory.units.some(u => Number(u) === Number(unit));
                } else if (typeof factory.units === 'object') {
                    hasUnit = Object.keys(factory.units).some(u => Number(u) === Number(unit)) || factory.units[unit] !== undefined;
                }
                if (hasUnit) {
                    subFactoryInfo = factory.info || {};
                    subFactoryKey = fKey;
                    break;
                }
            }
        }

        if (subFactoryInfo) {
            _unit.info = subFactoryInfo;
            _unit.subFactory = subFactoryKey;
        } else {
            _unit.info = results.info || {};
        }

        // Set local expiration timestamp (TTL 600s)
        _unit.expiresAt = Date.now() + 600 * 1000;

        // Cache _unit in Redis hash units under field ${uid}-${unit}
        await redis.hset('units', hashField, JSON.stringify(_unit));
    }

    return {
        uid,
        unit,
        connection,
        inputs: mapping.inputs || null,
        _unit
    };
}

/**
 * Saves/updates _unit object back to Redis.
 * @param {string} uid
 * @param {number} unit
 * @param {Object} _unit
 */
async function saveUnitToCache(uid, unit, _unit) {
    const hashField = `${uid}-${unit}`;
    _unit.expiresAt = Date.now() + 600 * 1000; // Extend TTL
    await redis.hset('units', hashField, JSON.stringify(_unit));
}

module.exports = {
    lookupMacAndUnit,
    saveUnitToCache
};
