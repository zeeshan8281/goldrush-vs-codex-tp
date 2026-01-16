/**
 * Multi-Provider OHLCV Comparison Tester
 * Runs for 10 minutes, logs OHLCV events live with timestamps, then exports to CSV.
 * 
 * Fair comparison using OHLCV only:
 * - GoldRush: ohlcvCandlesForPair
 * - Mobula: ohlcv stream
 * - Codex: onBarsUpdated
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
const RUNTIME_MS = 5 * 60 * 1000; // 5 minutes

// Event storage
const events = {
    goldrush: [],
    mobula: [],
    codex: []
};

let startTime = Date.now();
let grConnectTime = 0;
let mbConnectTime = 0;
let cxConnectTime = 0;

// TTFD tracking
const ttfd = {
    goldrush: 0,
    mobula: 0,
    codex: 0
};

// Helper to format time
function timeStr() {
    return new Date().toISOString().slice(11, 23);
}

// ============= GOLDRUSH updatePairs =============
function startGoldRush() {
    console.log('🚀 Starting GoldRush updatePairs...');

    const client = createClient({
        url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
        },
        on: {
            connected: () => {
                grConnectTime = Date.now();
                console.log('✅ GoldRush Connected');
            }
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
            base_token {
                contract_ticker_symbol
            }
            quote_token {
                contract_ticker_symbol
            }
        }
    }`;

    client.subscribe({ query }, {
        next: (result) => {
            const update = result?.data?.updatePairs;
            if (update) {
                const eventNum = events.goldrush.length + 1;
                const receivedAt = timeStr();

                if (ttfd.goldrush === 0 && grConnectTime > 0) {
                    ttfd.goldrush = Date.now() - grConnectTime;
                    console.log(`[${receivedAt}] [GOLDRUSH] TTFD: ${ttfd.goldrush}ms`);
                }

                events.goldrush.push({
                    num: eventNum,
                    dataTimestamp: update.timestamp,
                    price: update.quote_rate,
                    receivedAt: receivedAt
                });
                console.log(`[${receivedAt}] [GOLDRUSH] updatePairs #${eventNum} | Price: $${update.quote_rate?.toFixed(4)} | TS: ${update.timestamp}`);
            }
        },
        error: (err) => console.error('GoldRush Error:', err.message),
        complete: () => console.log('GoldRush Complete')
    });
}


// ============= MOBULA OHLCV =============
function startMobula() {
    console.log('🔌 Starting Mobula OHLCV stream...');

    const ws = new WebSocket('wss://api.mobula.io');

    ws.on('open', () => {
        mbConnectTime = Date.now();
        console.log('✅ Mobula Connected');

        // Subscribe to OHLCV with correct parameters from docs
        ws.send(JSON.stringify({
            type: 'ohlcv',
            authorization: process.env.MOBULA_API_KEY,
            payload: {
                address: PAIR_ADDRESS,
                chainId: CHAIN,           // Correct: chainId not blockchain
                period: '1m',             // 1-minute candles
                mode: 'pair',             // Explicit: only this specific pool
                subscriptionTracking: true
            }
        }));
        console.log('📤 Mobula OHLCV subscription sent (mode: pair)');
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            // OHLCV message: has open, high, low, close, time
            if (msg.open !== undefined && msg.close !== undefined && msg.time !== undefined) {
                const eventNum = events.mobula.length + 1;
                const receivedAt = timeStr();
                const dataTs = new Date(msg.time).toISOString().slice(11, 23);

                if (ttfd.mobula === 0 && mbConnectTime > 0) {
                    ttfd.mobula = Date.now() - mbConnectTime;
                    console.log(`[${receivedAt}] [MOBULA] TTFD: ${ttfd.mobula}ms`);
                }

                events.mobula.push({
                    num: eventNum,
                    dataTimestamp: msg.time,
                    dataTimestampISO: dataTs,
                    open: msg.open,
                    high: msg.high,
                    low: msg.low,
                    close: msg.close,
                    volume: msg.volume,
                    receivedAt: receivedAt
                });
                console.log(`[${receivedAt}] [MOBULA] OHLCV #${eventNum} | O:${msg.open?.toFixed(4)} H:${msg.high?.toFixed(4)} L:${msg.low?.toFixed(4)} C:${msg.close?.toFixed(4)} V:${msg.volume?.toFixed(2)} | TS: ${dataTs}`);
            }
        } catch (e) { }
    });

    ws.on('error', (err) => console.error('Mobula Error:', err.message));
    ws.on('close', () => {
        console.log('Mobula Closed. Reconnecting in 5s...');
        setTimeout(startMobula, 5000);
    });
}

// ============= CODEX OHLCV =============
function startCodex() {
    console.log('🐢 Starting Codex onBarsUpdated...');

    const client = createClient({
        url: 'wss://graph.codex.io/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            Authorization: process.env.CODEX_API_KEY
        },
        on: {
            connected: () => {
                cxConnectTime = Date.now();
                console.log('✅ Codex Connected');
            }
        }
    });

    const pairId = `${PAIR_ADDRESS}:${CODEX_NETWORK_ID}`;
    const query = `
        subscription($pairId: String!) {
            onBarsUpdated(pairId: $pairId, quoteToken: token0) {
                pairId
                timestamp
                aggregates { 
                    r60 { 
                        usd { 
                            o
                            h
                            l
                            c
                        } 
                    } 
                }
            }
        }
    `;

    client.subscribe({ query, variables: { pairId } }, {
        next: (result) => {
            const bar = result?.data?.onBarsUpdated;
            if (bar && bar.aggregates?.r60?.usd) {
                const agg = bar.aggregates.r60.usd;
                const eventNum = events.codex.length + 1;
                const receivedAt = timeStr();
                const dataTs = new Date(bar.timestamp * 1000).toISOString().slice(11, 23);

                if (ttfd.codex === 0 && cxConnectTime > 0) {
                    ttfd.codex = Date.now() - cxConnectTime;
                    console.log(`[${receivedAt}] [CODEX] TTFD: ${ttfd.codex}ms`);
                }

                events.codex.push({
                    num: eventNum,
                    dataTimestamp: bar.timestamp,
                    dataTimestampISO: dataTs,
                    open: agg.o,
                    high: agg.h,
                    low: agg.l,
                    close: agg.c,
                    receivedAt: receivedAt
                });
                console.log(`[${receivedAt}] [CODEX] OHLCV #${eventNum} | O:${agg.o?.toFixed(4)} H:${agg.h?.toFixed(4)} L:${agg.l?.toFixed(4)} C:${agg.c?.toFixed(4)} | TS: ${dataTs}`);
            }
        },
        error: (err) => console.error('Codex Error:', err.message),
        complete: () => console.log('Codex Complete')
    });
}

// ============= EXPORT TO CSV =============
function exportToCSV() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `ohlcv_comparison_${timestamp}.csv`;
    const filepath = path.join(__dirname, filename);

    // Build CSV content
    const headers = 'Event,GR_ReceivedAt,GR_O,GR_H,GR_L,GR_C,GR_V,GR_TS,MB_ReceivedAt,MB_O,MB_H,MB_L,MB_C,MB_V,MB_TS,CX_ReceivedAt,CX_O,CX_H,CX_L,CX_C,CX_TS';

    const maxLen = Math.max(events.goldrush.length, events.mobula.length, events.codex.length);
    const rows = [];

    for (let i = 0; i < maxLen; i++) {
        const gr = events.goldrush[i] || {};
        const mb = events.mobula[i] || {};
        const cx = events.codex[i] || {};

        rows.push([
            i + 1,
            gr.receivedAt || '',
            gr.open?.toFixed(4) || '',
            gr.high?.toFixed(4) || '',
            gr.low?.toFixed(4) || '',
            gr.close?.toFixed(4) || '',
            gr.volume?.toFixed(2) || '',
            gr.dataTimestamp || '',
            mb.receivedAt || '',
            mb.open?.toFixed(4) || '',
            mb.high?.toFixed(4) || '',
            mb.low?.toFixed(4) || '',
            mb.close?.toFixed(4) || '',
            mb.volume?.toFixed(2) || '',
            mb.dataTimestampISO || '',
            cx.receivedAt || '',
            cx.open?.toFixed(4) || '',
            cx.high?.toFixed(4) || '',
            cx.low?.toFixed(4) || '',
            cx.close?.toFixed(4) || '',
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
    console.log('█'.repeat(100));
    console.log(`  FINAL REPORT | Runtime: ${elapsed}s | ALL OHLCV STREAMS`);
    console.log('█'.repeat(100));
    console.log(`\nTotal OHLCV Events:`);
    console.log(`  GoldRush (ohlcvCandlesForPair): ${events.goldrush.length}`);
    console.log(`  Mobula (ohlcv):                 ${events.mobula.length}`);
    console.log(`  Codex (onBarsUpdated):          ${events.codex.length}`);
    console.log(`\nTime to First Data (TTFD):`);
    console.log(`  GoldRush: ${ttfd.goldrush}ms`);
    console.log(`  Mobula:   ${ttfd.mobula}ms`);
    console.log(`  Codex:    ${ttfd.codex}ms`);
    console.log('\n');

    // Export to CSV
    exportToCSV();

    console.log('\n✅ OHLCV Comparison Test Complete!\n');
    process.exit(0);
}

// ============= PROGRESS TICKER =============
function showProgress() {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = Math.max(0, 300 - elapsed);
    console.log(`\n--- [${timeStr()}] Progress: ${elapsed}s / 300s | GR: ${events.goldrush.length} | MB: ${events.mobula.length} | CX: ${events.codex.length} ---\n`);
}

// ============= MAIN =============
console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
console.log('║       MULTI-PROVIDER OHLCV TESTER (5 MINUTES)                                  ║');
console.log('║       GoldRush (ohlcv) | Mobula (ohlcv) | Codex (onBarsUpdated)               ║');
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

// End after 5 minutes
setTimeout(() => {
    printFinalTable();
}, RUNTIME_MS);

console.log('🕐 Logging OHLCV events live for 5 minutes. CSV will be exported at the end.\n');
