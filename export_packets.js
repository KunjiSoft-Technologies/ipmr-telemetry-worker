const fs = require('fs');
const https = require('https');
const url = require('url');
const path = require('path');
require('dotenv').config();

// Determine hours to export
const args = process.argv.slice(2);
const hours = args[0] ? parseInt(args[0], 10) : 24;

if (isNaN(hours) || hours <= 0) {
    console.error('Invalid hours argument. Please provide a positive integer.');
    process.exit(1);
}

const exportPackets = async () => {
    const influxUrl = process.env.INFLUX_URL;
    const org = process.env.INFLUX_ORG;
    const bucket = process.env.INFLUX_RECORDS_BUCKET || process.env.INFLUX_BUCKET;
    const token = process.env.INFLUX_TOKEN;

    if (!influxUrl || !org || !bucket || !token) {
        console.error('Missing InfluxDB configuration in .env (INFLUX_URL, INFLUX_ORG, INFLUX_RECORDS_BUCKET/INFLUX_BUCKET, INFLUX_TOKEN)');
        process.exit(1);
    }

    console.log(`Starting export for the last ${hours} hour(s) from bucket "${bucket}"...`);

    // Flux query to fetch range and pivot fields to columns
    const fluxQuery = `
        from(bucket: "${bucket}")
          |> range(start: -${hours}h)
          |> filter(fn: (r) => r._measurement == "ipmr-records")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
          |> keep(columns: ["_time", "uid", "unit", "unix", "status", "realtime", "values", "now_values", "phase_values", "digital_values", "temperature", "active_alerts"])
          |> sort(columns: ["_time"], desc: true)
    `.trim();

    const queryEndpoint = `${influxUrl}/api/v2/query?org=${encodeURIComponent(org)}`;
    const parsedUrl = url.parse(queryEndpoint);

    const postData = JSON.stringify({
        query: fluxQuery,
        type: 'flux',
        dialect: {
            header: true,
            delimiter: ',',
            annotations: [], // Exclude InfluxDB metadata annotation lines
            headerAndComment: false
        }
    });

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.path,
        method: 'POST',
        headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'text/csv',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    console.log('Sending request to InfluxDB...');
    const req = https.request(options, (res) => {
        let csvData = '';
        res.on('data', (chunk) => csvData += chunk);
        res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                const outputFileName = `last_${hours}h_packets.csv`;
                const outputPath = path.join(__dirname, outputFileName);
                fs.writeFileSync(outputPath, csvData);
                console.log(`\n✓ CSV successfully exported to: ${outputPath}`);
                
                const lines = csvData.trim().split('\n');
                const count = csvData.trim() === '' ? 0 : lines.length - 1;
                console.log(`Total records written: ${count}`);
            } else {
                console.error(`\n✗ InfluxDB query failed with status ${res.statusCode}:`, csvData);
            }
        });
    });

    req.on('error', (err) => {
        console.error('\n✗ Network Request error:', err);
    });

    req.write(postData);
    req.end();
};

exportPackets();
