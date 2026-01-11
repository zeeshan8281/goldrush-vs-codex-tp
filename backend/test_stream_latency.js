require('dotenv').config();
const { createClient } = require('graphql-ws');
const WebSocket = require('ws');

const PAIR_ADDRESS = '0x9c087eb773291e50cf6c6a90ef0f4500e349b903';
const CODEX_NETWORK_ID = 8453;
const TEST_DURATION_MS = 10 * 60 * 1000; // 10 minutes

let grClient = null;
let codexClient = null;
let grCount = 0;
let codexCount = 0;

// Store events for comparison
const grEvents = [];
const codexEvents = [];

// GOLDRUSH STREAM
function startGoldrushStream() {
    grClient = createClient({
        url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
        }
    });

    const query = `
        subscription UpdatePairs($pair_addresses: [String!]) {
            updatePairs(
                chain_name: BASE_MAINNET
                pair_addresses: $pair_addresses
            ) {
                timestamp
                volume
                volume_usd
                swap_counts {
                    last_5m
                    last_1hr
                }
                price_deltas {
                    last_5m
                    last_1hr
                }
                quote_rate_usd
            }
        }`;

    grClient.subscribe({ query, variables: { pair_addresses: [PAIR_ADDRESS] } }, {
        next: (result) => {
            const arrivedAt = Date.now();
            const data = result?.data?.updatePairs;
            if (data) {
                grCount++;
                grEvents.push({
                    timestamp: data.timestamp,
                    arrivedAt,
                    volume: data.volume_usd,
                    price: data.quote_rate_usd,
                    swaps: data.swap_counts?.last_5m
                });
                console.log(`\n🟠 GOLDRUSH #${grCount}`);
                console.log(`   Timestamp: ${data.timestamp}`);
                console.log(`   Volume:    $${data.volume_usd}`);
                console.log(`   Price:     $${data.quote_rate_usd}`);
                console.log(`   Swaps(5m): ${data.swap_counts?.last_5m}`);
                const serverTime = new Date(data.timestamp).getTime();
                const latencyMs = arrivedAt - serverTime;
                console.log(`Latency: ${latencyMs}ms`);
            }
        },
        error: (err) => console.error('🟠 [GOLDRUSH] Error:', err),
        complete: () => console.log('🟠 [GOLDRUSH] Complete')
    });
}

// CODEX STREAM
function startCodexStream() {
    const pairId = `${PAIR_ADDRESS}:${CODEX_NETWORK_ID}`;

    codexClient = createClient({
        url: 'wss://graph.codex.io/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            Authorization: process.env.CODEX_API_KEY
        }
    });

    const query = `
        subscription OnBarsUpdated($pairId: String!) {
            onBarsUpdated(pairId: $pairId) {
                timestamp
                eventSortKey
                aggregates {
                    r1 {
                        t
                        usd {
                            o
                            h
                            l
                            c
                            volume
                            transactions
                            buyVolume
                            sellVolume
                            liquidity
                        }
                    }
                    r5 {
                        t
                        usd {
                            o
                            h
                            l
                            c
                            volume
                            transactions
                            buyVolume
                            sellVolume
                            liquidity
                        }
                    }
                }
            }
        }
    `;

    codexClient.subscribe(
        { query, variables: { pairId } },
        {
            next: (result) => {
                const arrivedAt = Date.now();
                const bar = result?.data?.onBarsUpdated;
                if (bar?.aggregates) {
                    codexCount++;
                    const readableTime = new Date(bar.timestamp * 1000).toISOString();
                    const r1 = bar.aggregates.r1?.usd;
                    const r5 = bar.aggregates.r5?.usd;

                    codexEvents.push({
                        timestamp: readableTime,
                        arrivedAt,
                        r1Volume: r1?.volume,
                        r5Volume: r5?.volume,
                        r1Price: r1?.c,
                        r5Price: r5?.c,
                        r1Txns: r1?.transactions,
                        r5Txns: r5?.transactions
                    });

                    console.log(`\n🔵 CODEX #${codexCount}`);
                    console.log(`   Timestamp:    ${readableTime}`);
                    console.log(`   R1 (1-min):   Price: $${r1?.c} | Vol: $${r1?.volume} | Txns: ${r1?.transactions}`);
                    console.log(`   R5 (5-min):   Price: $${r5?.c} | Vol: $${r5?.volume} | Txns: ${r5?.transactions}`);
                    const serverTime = bar.timestamp * 1000; // Convert Unix seconds to milliseconds
                    const latencyMs = arrivedAt - serverTime;
                    console.log(`Latency: ${latencyMs}ms`);
                }
            },
            error: (err) => console.error('🔵 [CODEX] Error:', err),
            complete: () => console.log('🔵 [CODEX] Complete')
        }
    );
}

// SUMMARY REPORT
function printSummary() {
    console.log('\n' + '='.repeat(80));
    console.log('TIMESTAMP COMPARISON');
    console.log('='.repeat(80));
    console.log('Codex Timestamp          | Codex Vol    | GoldRush Timestamp       | GoldRush Vol');
    console.log('-'.repeat(80));

    const maxLen = Math.max(grEvents.length, codexEvents.length);
    for (let i = 0; i < maxLen; i++) {  // REMOVED the Math.min(maxLen, 20) limit
        const cx = codexEvents[i];
        const gr = grEvents[i];
        const cxTime = cx?.timestamp?.substring(0, 24) || '                        ';
        const cxVol = cx?.r5Volume ? `$${parseFloat(cx.r5Volume).toFixed(2)}` : '          ';
        const grTime = gr?.timestamp?.substring(0, 24) || '                        ';
        const grVol = gr?.volume ? `$${parseFloat(gr.volume).toFixed(2)}` : '';
        console.log(`${cxTime.padEnd(24)} | ${cxVol.padEnd(12)} | ${grTime.padEnd(24)} | ${grVol}`);
    }

    console.log('='.repeat(80));
}

// MAIN
console.log('🚀 Starting comparison test...');
console.log(`📍 Pair: ${PAIR_ADDRESS}`);
console.log(`⏰ Duration: ${TEST_DURATION_MS / 1000 / 60} minutes`);
console.log('='.repeat(80));

startGoldrushStream();
startCodexStream();

setTimeout(() => {
    console.log('\n✅ Test complete');
    printSummary();

    if (grClient) grClient.dispose();
    if (codexClient) codexClient.dispose();
    process.exit(0);
}, TEST_DURATION_MS);