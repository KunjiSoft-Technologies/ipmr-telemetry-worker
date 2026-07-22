const https = require('https');
const http = require('http');
const url = require('url');
require('dotenv').config();

const writeInfluxRecord = async (uid, unit, mac, record) => {
    const influxUrl = process.env.INFLUX_URL;
    if (!influxUrl) {
        return; // InfluxDB writing is optional if INFLUX_URL is not set
    }

    const org = process.env.INFLUX_ORG || '';
    const token = process.env.INFLUX_TOKEN || '';
    const success = record.success !== undefined ? record.success : true;
    const realtime = record.realtime !== undefined ? record.realtime : true;

    const bucket = process.env.INFLUX_RECORDS_BUCKET || 'ipmr-v2-streams';

    const recordsDataRaw = {
        success,
        realtime,
        values: record.values || { "60_a": 0 },
        now_values: record.now_values || {},
        phase_values: record.phase_values || {},
        digital_values: record.digital_values || {},
        temperature: record.temperature !== undefined && record.temperature !== null ? record.temperature : 0,
        active_alerts: record.active_alerts || 0
    };
    const recordsDataStr = JSON.stringify(recordsDataRaw);
    const escapedRecordsData = recordsDataStr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const unixVal = record.unix || Math.floor(Date.now() / 1000);

    const lineProtocol = `ipmr-records,mac="${mac}" unix=${unixVal}i,records_data="${escapedRecordsData}"`;

    const writeUrl = `${influxUrl}/api/v2/write?org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}&precision=s`;

    return new Promise((resolve) => {
        try {
            const parsedUrl = url.parse(writeUrl);
            const protocol = parsedUrl.protocol === 'https:' ? https : http;

            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port,
                path: parsedUrl.path,
                method: 'POST',
                headers: {
                    'Authorization': `Token ${token}`,
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Content-Length': Buffer.byteLength(lineProtocol)
                }
            };

            const req = protocol.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ success: true, statusCode: res.statusCode, body });
                    } else {
                        console.error(`InfluxDB write failed with status ${res.statusCode}: ${body}`);
                        resolve({ success: false, statusCode: res.statusCode, error: body });
                    }
                });
            });

            req.on('error', (err) => {
                console.error('InfluxDB HTTP request error:', err);
                resolve({ success: false, error: err });
            });

            req.write(lineProtocol);
            req.end();
        } catch (err) {
            console.error('Error constructing or sending InfluxDB request:', err);
            resolve({ success: false, error: err });
        }
    });
};

module.exports = { writeInfluxRecord };
