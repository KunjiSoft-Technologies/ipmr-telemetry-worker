const redis = require('../config/redis');

async function clearCache() {
    try {
        console.log('Fetching cached keys...');
        
        // Delete the entire 'units' hash
        const unitsDeleted = await redis.del('units');
        console.log(`Deleted 'units' hash: ${unitsDeleted > 0 ? 'Yes' : 'No'}`);
        
        // Find all mac_mapping:* keys and delete them
        const keys = await redis.keys('mac_mapping:*');
        if (keys.length > 0) {
            console.log(`Found mapping keys: ${keys.join(', ')}`);
            const mappingDeleted = await redis.del(...keys);
            console.log(`Deleted mapping keys count: ${mappingDeleted}`);
        } else {
            console.log('No mac_mapping:* keys found.');
        }
        
        console.log('Cache cleared successfully!');
    } catch (err) {
        console.error('Error clearing cache:', err);
    } finally {
        redis.disconnect();
        process.exit(0);
    }
}

// Wait for connection to open then run
redis.on('connect', () => {
    clearCache();
});
