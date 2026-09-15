const { database } = require('./firebase');

// Ensure all transactions in backend worker suppress intermediate local events (applyLocally = false)
// by default to prevent client-side cache thrashing and maxretry errors during concurrent metric updates.
if (database && database.ref) {
    const origTransaction = database.ref().constructor.prototype.transaction;
    database.ref().constructor.prototype.transaction = function(updateFn, onComplete, applyLocally) {
        const useApplyLocally = applyLocally !== undefined ? applyLocally : false;
        return origTransaction.call(this, updateFn, onComplete, useApplyLocally);
    };
}

module.exports = database;

