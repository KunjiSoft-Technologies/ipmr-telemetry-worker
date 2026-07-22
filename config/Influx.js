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

    const bucket = process.env.INFLUX_RECORDS_BUCKET || 'ipmr-v2-records-streams';

    const formatJson = (val) => {
        let str = '';
        if (typeof val === 'object' && val !== null) {
            str = JSON.stringify(val);
        } else if (typeof val === 'string') {
            str = val;
        } else {
            str = '{}';
        }
        return str.replace(/"/g, "'");
    };

    const valuesStr = formatJson(record.values || { "60_a": 0 });
    const nowValuesStr = formatJson(record.now_values || {});
    const phaseValuesStr = formatJson(record.phase_values || {});
    const digitalValuesStr = formatJson(record.digital_values || {});
    const unixVal = record.unix;
    const temperatureVal = record.temperature !== undefined && record.temperature !== null 
        ? Math.round(Number(record.temperature)) 
        : 0;
    const activeAlertsVal = record.active_alerts || 0;

    // Line Protocol:
    // ipmr-records,uid="${uid}",unit=${unit},mac="${mac}" status=${success},realtime=${realtime},values="${values}",now_values="${now_values}",phase_values="${phase_values}",digital_values="${digital_values}",unix=${unix}i,temperature=${temperature}i,active_alerts=${active_alerts}i
    const lineProtocol = `ipmr-records,uid="${uid}",unit=${unit},mac="${mac}" status=${success},realtime=${realtime},values="${valuesStr}",now_values="${nowValuesStr}",phase_values="${phaseValuesStr}",digital_values="${digitalValuesStr}",unix=${unixVal}i,temperature=${temperatureVal}i,active_alerts=${activeAlertsVal}i`;

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
