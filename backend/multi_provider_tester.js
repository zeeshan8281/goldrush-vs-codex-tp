/**
 * Multi-Provider Event Comparison Tester
 * Runs for 10 minutes, logs events live with timestamps, then exports to CSV.
 * 
 * GoldRush: updatePairs (with timestamp)
 * Mobula: market-details stream (trades with hash + timestamp)
 * Codex: onBarsUpdated (with timestamp)
 */
require('dotenv').config();
const WebSocket = require('ws');
const { createClient } = require('graphql-ws');
const fs = require('fs');
const path = require('path');

// Configuration
const PAIR_ADDRESS = '0x9c087Eb773291e50CF6c6a90ef0F4500e349B903';
const CHAIN = 'evm:8453';
const CODEX_NETWORK_ID = 8453;
const RUNTIME_MS = 10 * 60 * 1000; // 10 minutes

// Event storage
const events = {
    goldrush: [],
    mobula: [],
    codex: []
};

let startTime = Date.now();

// Helper to format time
function timeStr() {
    return new Date().toISOString().slice(11, 23);
}

// ============= GOLDRUSH =============
function startGoldRush() {
    console.log('🚀 Starting GoldRush updatePairs...');

    const client = createClient({
        url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
        }
    });

    const query = `subscription {
        updatePairs(
            chain_name: BASE_MAINNET
            pair_addresses: ["${PAIR_ADDRESS}"]
        ) {
            chain_name
            pair_address
            timestamp
            quote_rate
        }
    }`;

    client.subscribe({ query }, {
        next: (result) => {
            const update = result?.data?.updatePairs;
            if (update) {
                const eventNum = events.goldrush.length + 1;
                const receivedAt = timeStr();
                events.goldrush.push({
                    num: eventNum,
                    dataTimestamp: update.timestamp,
                    receivedAt: receivedAt
                });
                console.log(`[${receivedAt}] [GOLDRUSH] Event #${eventNum} | Data TS: ${update.timestamp}`);
            }
        },
        error: (err) => console.error('GoldRush Error:', err.message),
        complete: () => console.log('GoldRush Complete')
    });
}

// ============= MOBULA (market-details) =============
function startMobula() {
    console.log('🔌 Starting Mobula market-details stream...');

    const ws = new WebSocket('wss://api.mobula.io');

    ws.on('open', () => {
        console.log('✅ Mobula Connected');

        // Subscribe to market-details
        ws.send(JSON.stringify({
            type: 'market-details',
            authorization: process.env.MOBULA_API_KEY,
            payload: {
                pools: [{ address: PAIR_ADDRESS, blockchain: CHAIN }],
                subscriptionTracking: true
            }
        }));
        console.log('📤 Mobula market-details subscription sent');
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            // market-details trade event: has date (timestamp) and hash
            if (msg.date && msg.hash) {
                const eventNum = events.mobula.length + 1;
                const receivedAt = timeStr();
                const tradeTime = new Date(msg.date).toISOString().slice(11, 23);

                events.mobula.push({
                    num: eventNum,
                    dataTimestamp: tradeTime,
                    dataTimestampRaw: msg.date,
                    hash: msg.hash,
                    receivedAt: receivedAt
                });
                console.log(`[${receivedAt}] [MOBULA] Event #${eventNum} | Trade TS: ${tradeTime} | Hash: ${msg.hash.slice(0, 12)}...`);
            }
        } catch (e) { }
    });

    ws.on('error', (err) => console.error('Mobula Error:', err.message));
    ws.on('close', () => {
        console.log('Mobula Closed. Reconnecting in 5s...');
        setTimeout(startMobula, 5000);
    });
}

// ============= CODEX =============
function startCodex() {
    console.log('🐢 Starting Codex onBarsUpdated...');

    const client = createClient({
        url: 'wss://graph.codex.io/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            Authorization: process.env.CODEX_API_KEY
        }
    });

    const pairId = `${PAIR_ADDRESS}:${CODEX_NETWORK_ID}`;
    const query = `
        subscription($pairId: String!) {
            onBarsUpdated(pairId: $pairId, quoteToken: token0) {
                pairId
                timestamp
                aggregates { r1 { usd { c } } }
            }
        }
    `;

    client.subscribe({ query, variables: { pairId } }, {
        next: (result) => {
            const bar = result?.data?.onBarsUpdated;
            if (bar) {
                const eventNum = events.codex.length + 1;
                const receivedAt = timeStr();
                const dataTs = new Date(bar.timestamp * 1000).toISOString().slice(11, 23);
                events.codex.push({
                    num: eventNum,
                    dataTimestamp: bar.timestamp,
                    dataTimestampISO: dataTs,
                    receivedAt: receivedAt
                });
                console.log(`[${receivedAt}] [CODEX] Event #${eventNum} | Data TS: ${dataTs} (${bar.timestamp})`);
            }
        },
        error: (err) => console.error('Codex Error:', err.message),
        complete: () => console.log('Codex Complete')
    });
}

// ============= EXPORT TO CSV =============
function exportToCSV() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `provider_comparison_${timestamp}.csv`;
    const filepath = path.join(__dirname, filename);

    // Build CSV content
    const headers = 'Event,GoldRush_ReceivedAt,GoldRush_DataTS,Mobula_ReceivedAt,Mobula_TradeTS,Mobula_Hash,Codex_ReceivedAt,Codex_DataTS';

    const maxLen = Math.max(events.goldrush.length, events.mobula.length, events.codex.length);
    const rows = [];

    for (let i = 0; i < maxLen; i++) {
        const gr = events.goldrush[i] || {};
        const mb = events.mobula[i] || {};
        const cx = events.codex[i] || {};

        rows.push([
            i + 1,
            gr.receivedAt || '',
            gr.dataTimestamp || '',
            mb.receivedAt || '',
            mb.dataTimestamp || '',
            mb.hash || '',
            cx.receivedAt || '',
            cx.dataTimestampISO || ''
        ].join(','));
    }

    const csvContent = [headers, ...rows].join('\n');
    fs.writeFileSync(filepath, csvContent);

    console.log(`\n📊 CSV exported to: ${filepath}\n`);
    return filepath;
}

// ============= FINAL TABLE =============
function printFinalTable() {
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    console.log('\n\n');
    console.log('█'.repeat(160));
    console.log(`  FINAL REPORT | Runtime: ${elapsed}s`);
    console.log('█'.repeat(160));
    console.log(`\nTotal Events:`);
    console.log(`  GoldRush (updatePairs): ${events.goldrush.length}`);
    console.log(`  Mobula (market-details): ${events.mobula.length}`);
    console.log(`  Codex (onBarsUpdated): ${events.codex.length}`);
    console.log('\n');

    console.log('─'.repeat(160));
    console.log(`${'Event'.padStart(6)} || ${'GoldRush (ReceivedAt | DataTS)'.padEnd(42)} || ${'Mobula (ReceivedAt | TradeTS | Hash)'.padEnd(60)} || ${'Codex (ReceivedAt | DataTS)'.padEnd(35)}`);
    console.log('─'.repeat(160));

    const maxLen = Math.max(events.goldrush.length, events.mobula.length, events.codex.length);
    for (let i = 0; i < maxLen; i++) {
        const gr = events.goldrush[i];
        const mb = events.mobula[i];
        const cx = events.codex[i];

        const grStr = gr ? `${gr.receivedAt} | ${gr.dataTimestamp}` : '-';
        const mbStr = mb ? `${mb.receivedAt} | ${mb.dataTimestamp} | ${mb.hash?.slice(0, 10)}...` : '-';
        const cxStr = cx ? `${cx.receivedAt} | ${cx.dataTimestampISO}` : '-';

        console.log(`${String(i + 1).padStart(6)} || ${grStr.padEnd(42)} || ${mbStr.padEnd(60)} || ${cxStr.padEnd(35)}`);
    }

    console.log('─'.repeat(160));

    // Export to CSV
    exportToCSV();

    console.log('\n✅ Test Complete!\n');
    process.exit(0);
}

// ============= PROGRESS TICKER =============
function showProgress() {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = Math.max(0, 600 - elapsed);
    console.log(`\n--- [${timeStr()}] Progress: ${elapsed}s / 600s | GR: ${events.goldrush.length} | MB: ${events.mobula.length} | CX: ${events.codex.length} ---\n`);
}

// ============= MAIN =============
console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
console.log('║       MULTI-PROVIDER LATENCY TESTER (10 MINUTES)                              ║');
console.log('║       GoldRush (updatePairs) | Mobula (market-details) | Codex (onBarsUpdated)║');
console.log('║       Exports to CSV at the end                                               ║');
console.log('╚═══════════════════════════════════════════════════════════════════════════════╝');
console.log(`Target: ${PAIR_ADDRESS}`);
console.log(`Chain: ${CHAIN}`);
console.log('');

startTime = Date.now();
startGoldRush();
startMobula();
startCodex();

// Progress update every 60 seconds
setInterval(showProgress, 60000);

// End after 10 minutes
setTimeout(() => {
    printFinalTable();
}, RUNTIME_MS);

console.log('🕐 Logging events live for 10 minutes. CSV will be exported at the end.\n');
