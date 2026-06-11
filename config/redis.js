const Redis = require('ioredis');
require('dotenv').config();

const redisUrl = process.env.REDIS_URL;
let redis;

if (redisUrl) {
    redis = new Redis(redisUrl);
} else {
    const host = process.env.REIDS_URL || process.env.REDIS_HOST || '127.0.0.1';
    const password = process.env.REDIS_PASSWORD || undefined;
    let port = parseInt(process.env.REDIS_PORT || '6379', 10);
    if (host.includes('redislabs.com') && !process.env.REDIS_PORT) {
        port = 14014;
    }
    const db = parseInt(process.env.REDIS_DB || '0', 10);

    redis = new Redis({
        host,
        port,
        password,
        db
    });
}

redis.on('error', (err) => {
    console.error('Redis client error:', err);
});

redis.on('connect', () => {
    console.log('Successfully connected to Redis.');
});

module.exports = redis;
