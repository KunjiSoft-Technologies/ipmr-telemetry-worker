const redis = require('../config/redis');

async function clearCache() {
    try {
        console.log('Clearing all Redis cache with FLUSHDB...');
        const result = await redis.flushdb();
        console.log(`FLUSHDB result: ${result}`);
        console.log('All Redis cache cleared successfully!');
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
