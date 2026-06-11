/**
 * API utility helpers.
 */

const withTimeout = async (promise, label, timeoutMs = 15000) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Timeout of ${timeoutMs}ms exceeded for Firebase operation: ${label}`));
        }, timeoutMs);
    });
    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId);
        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
};

module.exports = {
    withTimeout,
    update: async () => {},
    set: async () => {},
    get: async () => {},
};
