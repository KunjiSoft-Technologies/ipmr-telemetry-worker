const database = require('../config/database');

const TIMEOUT_MS = 15000; // 15 seconds timeout for Firebase operations

/**
 * Wraps a promise with a timeout. If the promise does not resolve or reject
 * within the specified time, it rejects with a timeout error.
 */
const withTimeout = (promise, name) => {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`Firebase RTDB ${name} timed out after ${TIMEOUT_MS}ms`));
        }, TIMEOUT_MS);
    });

    return Promise.race([
        promise.then(result => {
            clearTimeout(timer);
            return result;
        }).catch(err => {
            clearTimeout(timer);
            throw err;
        }),
        timeoutPromise
    ]);
};

const get = path => {
    return withTimeout(database.ref(path).once('value'), `get(${path})`);
};

const set = (path, data) => {
    return withTimeout(database.ref(path).set(data), `set(${path})`);
};

const update = (path, data) => {
    return withTimeout(database.ref(path).update(data), `update(${path})`);
};

const remove = path => {
    return withTimeout(database.ref(path).remove(), `remove(${path})`);
};

const push = (path, data) => {
    return withTimeout(database.ref(path).push(data), `push(${path})`);
};

module.exports = {
    withTimeout,
    get,
    set,
    update,
    remove,
    push
};
