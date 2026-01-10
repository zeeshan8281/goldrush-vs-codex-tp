/**
 * Stream Latency Comparison Test
 * 
 * Compares latency between:
 * - GoldRush updatePairs stream
 * - Codex onBarsUpdated stream
 * 
 * Run: node test_stream_latency.js
 */

require('dotenv').config();
const { createClient } = require('graphql-ws');
const WebSocket = require('ws');

// VIRTUAL pair address on Base
const PAIR_ADDRESS = '0x9c087eb773291e50cf6c6a90ef0f4500e349b903';
const CODEX_NETWORK_ID = 8453; // Base

// Test duration: 20 minutes
const TEST_DURATION_MS = 20 * 60 * 1000;

// Event counters
let goldrushEventCount = 0;
let codexEventCount = 0;

// Latency accumulators for average
let goldrushLatencies = [];
let codexLatencies = [];

// Clients for cleanup
let grClient = null;
let codexClient = null;

const startTime = Date.now();

console.log('='.repeat(80));
console.log('🚀 STREAM LATENCY COMPARISON TEST');
console.log('='.repeat(80));
console.log(`Pair: ${PAIR_ADDRESS}`);
console.log(`Network: Base (${CODEX_NETWORK_ID})`);
console.log(`Duration: 20 minutes`);
console.log(`Start Time: ${new Date(startTime).toISOString()}`);
console.log('='.repeat(80));

// ============================================================================
// GOLDRUSH updatePairs STREAM
// ============================================================================
function startGoldrushStream() {
    console.log('\n🟠 [GOLDRUSH] Starting updatePairs stream...');

    grClient = createClient({
        url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
        },
        on: {
            connected: () => console.log('🟠 [GOLDRUSH] WebSocket Connected'),
            error: (err) => console.error('🟠 [GOLDRUSH] WebSocket Error:', err),
        }
    });

    const query = `subscription {
        updatePairs(
            chain_name: BASE_MAINNET
            pair_addresses: ["${PAIR_ADDRESS}"]
        ) {
            timestamp
        }
    }`;

    console.log('🟠 [GOLDRUSH] Subscribed to updatePairs\n');

    grClient.subscribe({ query }, {
        next: (result) => {
            const now = Date.now();
            const data = result?.data?.updatePairs;

            if (data && data.timestamp) {
                goldrushEventCount++;
                const serverTimestamp = new Date(data.timestamp).getTime();
                const latencyMs = now - serverTimestamp;
                goldrushLatencies.push(latencyMs);

                console.log('─'.repeat(80));
                console.log(`🟠 [GOLDRUSH] updatePairs (#${goldrushEventCount})`);
                console.log(`   Timestamp:    ${data.timestamp}`);
                console.log(`   Wall Clock:   ${new Date(now).toISOString()}`);
                console.log(`   LATENCY:      ${latencyMs}ms (${(latencyMs / 1000).toFixed(2)}s)`);
                console.log('─'.repeat(80));
            }
        },
        error: (err) => console.error('🟠 [GOLDRUSH] Subscription Error:', err),
        complete: () => console.log('🟠 [GOLDRUSH] Subscription Complete')
    });
}

// ============================================================================
// CODEX onBarsUpdated STREAM
// ============================================================================
function startCodexStream() {
    console.log('\n🔵 [CODEX] Starting onBarsUpdated stream...');

    const pairId = `${PAIR_ADDRESS}:${CODEX_NETWORK_ID}`;

    codexClient = createClient({
        url: 'wss://graph.codex.io/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            Authorization: process.env.CODEX_API_KEY
        },
        on: {
            connected: () => console.log('🔵 [CODEX] WebSocket Connected'),
            error: (err) => console.error('🔵 [CODEX] WebSocket Error:', err),
        }
    });

    const query = `
        subscription OnBarsUpdated($pairId: String!) {
            onBarsUpdated(pairId: $pairId) {
                timestamp
                eventSortKey
            }
        }
    `;

    console.log(`🔵 [CODEX] Subscribing to pairId: ${pairId}\n`);

    codexClient.subscribe(
        { query, variables: { pairId } },
        {
            next: (result) => {
                const now = Date.now();
                const bar = result?.data?.onBarsUpdated;

                if (bar) {
                    codexEventCount++;
                    // Codex timestamp is Unix seconds
                    const serverTimestamp = bar.timestamp * 1000;
                    const latencyMs = now - serverTimestamp;
                    codexLatencies.push(latencyMs);
                    const humanTime = new Date(serverTimestamp).toISOString();

                    console.log('─'.repeat(80));
                    console.log(`🔵 [CODEX] onBarsUpdated (#${codexEventCount})`);
                    console.log(`   Timestamp:    ${bar.timestamp} (Unix) → ${humanTime}`);
                    console.log(`   eventSortKey: ${bar.eventSortKey}`);
                    console.log(`   Wall Clock:   ${new Date(now).toISOString()}`);
                    console.log(`   LATENCY:      ${latencyMs}ms (${(latencyMs / 1000).toFixed(2)}s)`);
                    console.log('─'.repeat(80));
                }
            },
            error: (err) => console.error('🔵 [CODEX] Subscription Error:', err),
            complete: () => console.log('🔵 [CODEX] Subscription Complete')
        }
    );
}

// ============================================================================
// PRINT FINAL RESULTS
// ============================================================================
function printFinalResults() {
    const endTime = Date.now();
    const durationMs = endTime - startTime;
    const durationMins = (durationMs / 1000 / 60).toFixed(2);

    const grAvgLatency = goldrushLatencies.length > 0
        ? (goldrushLatencies.reduce((a, b) => a + b, 0) / goldrushLatencies.length).toFixed(0)
        : 'N/A';

    const codexAvgLatency = codexLatencies.length > 0
        ? (codexLatencies.reduce((a, b) => a + b, 0) / codexLatencies.length).toFixed(0)
        : 'N/A';

    console.log('\n');
    console.log('='.repeat(80));
    console.log('📊 FINAL RESULTS');
    console.log('='.repeat(80));
    console.log(`Test Duration: ${durationMins} minutes`);
    console.log(`Start: ${new Date(startTime).toISOString()}`);
    console.log(`End:   ${new Date(endTime).toISOString()}`);
    console.log('─'.repeat(80));
    console.log('');
    console.log('  PROVIDER       │  EVENTS  │  AVG LATENCY');
    console.log('─'.repeat(50));
    console.log(`  🟠 GoldRush    │  ${String(goldrushEventCount).padStart(6)}  │  ${grAvgLatency}ms`);
    console.log(`  🔵 Codex       │  ${String(codexEventCount).padStart(6)}  │  ${codexAvgLatency}ms`);
    console.log('─'.repeat(50));
    console.log('');
    console.log('='.repeat(80));

    // Cleanup
    if (grClient) grClient.dispose();
    if (codexClient) codexClient.dispose();

    process.exit(0);
}

// ============================================================================
// MAIN
// ============================================================================
function main() {
    // Start both streams
    startGoldrushStream();
    startCodexStream();

    // Set timer for 20 minutes
    console.log(`\n⏱️  Test will run for 20 minutes. Auto-stopping at ${new Date(startTime + TEST_DURATION_MS).toISOString()}\n`);

    setTimeout(() => {
        console.log('\n\n⏱️  20 minutes elapsed! Stopping test...');
        printFinalResults();
    }, TEST_DURATION_MS);
}

main();

// Handle Ctrl+C
process.on('SIGINT', () => {
    console.log('\n\n🛑 Manual stop requested...');
    printFinalResults();
});
