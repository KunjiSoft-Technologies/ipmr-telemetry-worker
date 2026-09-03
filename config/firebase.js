const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const databaseUrl = process.env.FIREBASE_DATABASE_URL;

if (!admin.apps.length) {
    const config = {
        databaseURL: databaseUrl
    };

    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (serviceAccountPath) {
        try {
            const trimmed = serviceAccountPath.trim();
            if (trimmed.startsWith('{')) {
                config.credential = admin.credential.cert(JSON.parse(trimmed));
            } else {
                // Resolve path relative to project root or current working dir or absolute
                let absolutePath = path.isAbsolute(trimmed) 
                    ? trimmed 
                    : path.resolve(__dirname, '..', trimmed);
                if (!fs.existsSync(absolutePath)) {
                    absolutePath = path.resolve(process.cwd(), trimmed);
                }
                if (fs.existsSync(absolutePath)) {
                    const serviceAccount = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
                    config.credential = admin.credential.cert(serviceAccount);
                } else {
                    console.warn(`Credentials file not found at ${absolutePath}. Trying standard applicationDefault.`);
                    config.credential = admin.credential.applicationDefault();
                }
            }
        } catch (err) {
            console.error("Failed to load credentials from GOOGLE_APPLICATION_CREDENTIALS. Falling back to applicationDefault.", err);
            config.credential = admin.credential.applicationDefault();
        }
    } else {
        config.credential = admin.credential.applicationDefault();
    }

    admin.initializeApp(config);
}

const database = admin.database();

module.exports = {
    admin,
    database
};
