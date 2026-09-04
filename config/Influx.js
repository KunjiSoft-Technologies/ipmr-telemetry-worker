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
        ...record
    };
    const recordsDataStr = JSON.stringify(recordsDataRaw);
    const escapedRecordsData = recordsDataStr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const unixVal = record.unix || Math.floor(Date.now() / 1000);

    // Build fields for ipmr-records
    const recordFields = [
        `unix=${unixVal}i`,
        `records_data="${escapedRecordsData}"`
    ];

    if (record.missing_in_last_10 !== undefined && record.missing_in_last_10 !== null) {
        const missingCount = Number(record.missing_in_last_10);
        if (!isNaN(missingCount)) {
            recordFields.push(`missing_in_last_10=${missingCount}i`);
        }
    }

    if (record.packet_id !== undefined && record.packet_id !== null) {
        const pktId = Number(record.packet_id);
        if (!isNaN(pktId)) {
            recordFields.push(`packet_id=${pktId}i`);
        }
    }

    if (record.version !== undefined && record.version !== null && typeof record.version === 'string') {
        const escapedVersion = record.version.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        recordFields.push(`version="${escapedVersion}"`);
    }

    if (record.last_10_packets && Array.isArray(record.last_10_packets)) {
        const escapedLast10 = JSON.stringify(record.last_10_packets).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        recordFields.push(`last_10_packets="${escapedLast10}"`);
    }

    const lines = [
        `ipmr-records,mac="${mac}" ${recordFields.join(',')}`
    ];

    // Build points for ipmr-packet-audit if last_10_packets is present
    if (record.last_10_packets && Array.isArray(record.last_10_packets)) {
        for (const pkt of record.last_10_packets) {
            if (!pkt || typeof pkt !== 'object') continue;
            const pid = pkt.id !== undefined ? Number(pkt.id) : null;
            const pts = pkt.ts ? Number(pkt.ts) : null;
            const st = pkt.st !== undefined ? String(pkt.st) : 'unknown';

            if (pid === null || isNaN(pid)) continue;

            const isOk = st === 'ok';
            const escapedStatus = st.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

            const auditFields = [
                `packet_id=${pid}i`,
                `is_ok=${isOk}`,
                `status_code="${escapedStatus}"`
            ];

            const timestampStr = pts && !isNaN(pts) && pts > 0 ? ` ${pts}` : '';
            lines.push(`ipmr-packet-audit,mac="${mac}",status="${escapedStatus}" ${auditFields.join(',')}${timestampStr}`);
        }
    }

    const lineProtocol = lines.join('\n');

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
