const redis = require('../config/redis');

async function resetRedis() {
    try {
        console.log('Connecting to Redis and flushing database...');
        const initialCount = await redis.dbsize();
        console.log(`Current keys in database: ${initialCount}`);

        const result = await redis.flushall();
        console.log(`FLUSHALL result: ${result}`);

        const remainingCount = await redis.dbsize();
        console.log(`Keys remaining: ${remainingCount}`);
        console.log('Redis reset complete.');
    } catch (error) {
        console.error('Failed to reset Redis:', error);
        process.exitCode = 1;
    } finally {
        await redis.quit();
    }
}

resetRedis();
