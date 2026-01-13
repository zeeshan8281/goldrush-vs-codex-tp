const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
// Using raw graphql-ws instead of SDKs
const { createClient } = require('graphql-ws');
require('dotenv').config();
const logger = require('./utils/logger');
const RollingStats = require('./utils/stats');

const grStats = new RollingStats();
const cxStats = new RollingStats();

// Globa Interval Buckets for Raw Jitter (Reset every 5s)
let intervalLatencies = {
    goldrush: [],
    codex: []
};

// Carry-Forward Stats (Prevent 0-flicker)
let lastIntervalStats = {
    goldrush: { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0, eventCount: 0 },
    codex: { p50: 0, p95: 0, p99: 0, jitter: 0, stdDev: 0, eventCount: 0 }
};

// Track last value of previous interval for Delta calculation
let lastIntervalEndVal = {
    goldrush: 0,
    codex: 0
};

let codexLatestStats = { p50: 0, p95: 0, jitter: 0 };

global.getSymbol = () => SYMBOL;

global.updatePairs = (symbol, data) => {
    if (pairs[symbol]) {
        // Merge data into pairs state
        Object.assign(pairs[symbol], data);

        // Capture Stats if provided (from Codex)
        if (data.stats) {
            codexLatestStats = data.stats;
        }
    }
};

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3002;
// Default to VIRTUAL (Base), but allow dynamic updates
let SYMBOL = 'VIRTUAL';
let VIRTUALS_ADDRESS = '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b'; // Token address if needed, but we use PAIR for events
let PAIR_ADDRESS = '0x9c087Eb773291e50CF6c6a90ef0F4500e349B903';
let TOKEN_ADDRESS = PAIR_ADDRESS; // Codex events stream often uses Pair Address for swaps
let CURRENT_CHAIN = 'BASE_MAINNET';

const CHAIN_CONFIG = {
    SOLANA_MAINNET: {
        name: 'SOLANA',
        codexNetworkId: '1399811149',
        goldrushChain: 'SOLANA_MAINNET'
    },
    BASE_MAINNET: {
        name: 'BASE',
        codexNetworkId: '8453',
        goldrushChain: 'BASE_MAINNET'
    }
};

let CODEX_NETWORK_ID = CHAIN_CONFIG.SOLANA_MAINNET.codexNetworkId;

// --- STATE MANAGEMENT ---
let pairs = {
    [SYMBOL]: {
        price: 0,
        fastPrice: 0,
        slowPrice: 0
    }
};

// Store OHLCV candle arrays for charts (independent)
let goldrushCandles = [];
let codexCandles = [];

let clients = new Set();
let isRunning = true;
let streamsStartTime = 0; // Global start time for fair comparison

// Event counters for numbered logging
let eventCounters = {
    goldrushOHLCV: 0,
    goldrushUpdatePairs: 0,
    codexBars: 0
};

// --- SERVER SETUP ---
const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint for Railway
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'GoldRush vs Codex Trading Bot (SOLANA)' });
});

// Endpoint to update the token dynamically
app.post('/update-token', async (req, res) => {
    const { address, symbol, pairAddress } = req.body;
    if (!address) return res.status(400).json({ error: 'Address is required' });

    // CHAIN DETECTION
    // Solana addresses are Base58 (no '0x'), Base (EVM) addresses start with '0x'
    const isEVM = address.startsWith('0x');
    const newChain = isEVM ? 'BASE_MAINNET' : 'SOLANA_MAINNET';
    const config = CHAIN_CONFIG[newChain];

    // Only restart if chain changed OR token changed OR pair changed
    const needsFullRestart = newChain !== CURRENT_CHAIN || address !== TOKEN_ADDRESS || (pairAddress && pairAddress !== PAIR_ADDRESS);

    if (needsFullRestart) {
        console.log(`\n🔄 SWITCHING TO ${newChain} NETWORK...`);
        CURRENT_CHAIN = newChain;
        TOKEN_ADDRESS = address;
        if (pairAddress) PAIR_ADDRESS = pairAddress; // Update if provided
        SYMBOL = symbol || (isEVM ? 'TOKEN' : 'BONK');
        CODEX_NETWORK_ID = config.codexNetworkId;

        // Reset Global State
        pairs = { [SYMBOL]: { price: 0, fastPrice: 0, slowPrice: 0 } };
        goldrushCandles = [];
        codexCandles = [];

        performanceHistory = []; // Reset history on token switch

        broadcast({ type: 'RESET', data: { symbol: SYMBOL, chain: newChain } });

        // Reset Metrics & Stats
        metricsHistory = [];
        throughputCounters = { goldrush: 0, codex: 0 };
        currentThroughput = { goldrush: 0, codex: 0 };
        throughputHistory = { goldrush: [], codex: [] };
        avgCandlesPerSecond = { goldrush: 0, codex: 0 };

        latencyStats = {
            goldrush: { sum: 0, count: 0 },
            codex: { sum: 0, count: 0 }
        };

        latency300 = {
            goldrush: { samples: [], sum: 0 },
            codex: { samples: [], sum: 0 }
        };

        connectionMetrics = {
            goldrush: { loadStart: 0, loadTime: 0, connects: 0, errors: 0, lastError: null },
            codex: { loadStart: 0, loadTime: 0, connects: 0, errors: 0, lastError: null }
        };

        latencyDelta = {
            goldrush: { prevLatency: null, deltas: [], sum: 0 },
            codex: { prevLatency: null, deltas: [], sum: 0 }
        };

        // Update Providers
        // 1. GoldRush
        // We aren't using the external provider module instances in index.js yet, 
        // but we can call startStream() which now uses CURRENT_CHAIN config.
        startStream();

        // 2. Codex
        // Codex polling uses global CODEX_NETWORK_ID, which is updated above.
        // Subscription would need potential restart if we had one.
        // For now, relies on startCodexPolling() loop which reads the global var/
        // But better to restart services if needed.
        if (codexCleanup) {
            codexCleanup();
            // Start Codex (History + Subscription)
            await initCodexProvider();
        }
    }

    res.json({ success: true, symbol: SYMBOL, chain: newChain });
});

// --- TIMEFRAME API ---
let currentTimeframe = '1m';

app.get('/api/timeframe', (req, res) => {
    res.json({
        current: currentTimeframe,
        available: ['1m', '5m', '15m']
    });
});

app.post('/api/timeframe', (req, res) => {
    const { timeframe } = req.body;
    if (!timeframe || !['1m', '5m', '15m'].includes(timeframe)) {
        return res.status(400).json({ error: 'Invalid timeframe. Use 1m, 5m, or 15m.' });
    }

    console.log(`🕐 Switching all providers to ${timeframe} timeframe`);
    currentTimeframe = timeframe;

    // Reset trading state


    // Broadcast reset
    broadcast({ type: 'TIMEFRAME_CHANGE', data: { timeframe } });

    res.json({ success: true, timeframe });
});

// --- THROUGHPUT TRACKING (Hz) ---
// Count updates per second
let throughputCounters = { goldrush: 0, codex: 0 };
let currentThroughput = { goldrush: 0, codex: 0 };
let throughputHistory = { goldrush: [], codex: [] };
let avgCandlesPerSecond = { goldrush: 0, codex: 0 };

let latencyStats = {
    goldrush: { sum: 0, count: 0 },
    codex: { sum: 0, count: 0 }
};

// Rolling latency over last 300 candles per provider
let latency300 = {
    goldrush: { samples: [], sum: 0 },
    codex: { samples: [], sum: 0 }
};

// --- METRICS HISTORY FOR COMPARISON CHARTS ---
// Track connection/load time for each provider
let connectionMetrics = {
    goldrush: { loadStart: 0, loadTime: 0, connects: 0, errors: 0, lastError: null },
    codex: { loadStart: 0, loadTime: 0, connects: 0, errors: 0, lastError: null }
};

// --- LATENCY DELTA TRACKING (for stability score) ---
// Track previous latency and deltas for each provider
let latencyDelta = {
    goldrush: { prevLatency: null, deltas: [], sum: 0 },
    codex: { prevLatency: null, deltas: [], sum: 0 }
};

const MAX_ACCEPTABLE_DELTA = 50000; // 50 seconds max delta for 0% stability

// Helper to add a latency delta sample
function addLatencyDelta(provider, currentLatency) {
    const data = latencyDelta[provider];
    if (!data) return;

    if (data.prevLatency !== null) {
        const delta = Math.abs(currentLatency - data.prevLatency);
        data.deltas.push(delta);
        data.sum += delta;

        // Keep only last 100 deltas
        if (data.deltas.length > 100) {
            const removed = data.deltas.shift();
            data.sum -= removed;
        }
    }
    data.prevLatency = currentLatency;
}

// Get stability score (0-100, higher = more stable AND fast)
// Combines: consistency (low delta variance) + speed (low avg latency)
function getStabilityScore(provider) {
    const data = latencyDelta[provider];

    // 1. Delta Score (consistency) - max 100 points
    let deltaScore = 100; // Default to perfect if no data
    if (data && data.deltas.length > 0) {
        const avgDelta = data.sum / data.deltas.length;
        deltaScore = Math.max(0, 100 - (avgDelta / MAX_ACCEPTABLE_DELTA * 100));
    }

    // 2. Latency Penalty (speed) - max 30 point penalty
    // ALWAYS apply this, even if no delta samples
    const MAX_LATENCY_FOR_PENALTY = 60000; // 60 seconds
    const PENALTY_WEIGHT = 30; // Max points to deduct
    const avgLatency = getAvgLatency300(provider);
    const latencyPenalty = Math.min(PENALTY_WEIGHT, (avgLatency / MAX_LATENCY_FOR_PENALTY) * PENALTY_WEIGHT);

    // Final score = consistency - speed penalty
    const score = Math.max(0, deltaScore - latencyPenalty);
    return Math.round(score);
}

// Get raw average delta (latency variance in ms) - lower is better
function getAvgDelta(provider) {
    const data = latencyDelta[provider];
    if (!data || data.deltas.length === 0) return 0;
    return Math.round(data.sum / data.deltas.length);
}

// Time-series history for charts (last 5 min, sampled every 5s = 60 points)
let metricsHistory = [];

// Helper to add a latency sample (rolling window of 300)
function addLatencySample(provider, latency) {
    const data = latency300[provider];
    if (!data) return;

    data.samples.push(latency);
    data.sum += latency;

    // Keep only last 300 samples
    if (data.samples.length > 300) {
        const removed = data.samples.shift();
        data.sum -= removed;
    }
}

function getAvgLatency300(provider) {
    const data = latency300[provider];
    if (!data || data.samples.length === 0) return 0;
    return Math.round(data.sum / data.samples.length);
}

// Reset counters every second and calculate rolling average
setInterval(() => {
    currentThroughput = { ...throughputCounters };

    // Update rolling history (last 60 seconds)
    ['goldrush', 'codex'].forEach(p => {
        throughputHistory[p].push(currentThroughput[p]);
        if (throughputHistory[p].length > 60) throughputHistory[p].shift();

        // Calculate average
        const sum = throughputHistory[p].reduce((a, b) => a + b, 0);
        avgCandlesPerSecond[p] = throughputHistory[p].length > 0
            ? parseFloat((sum / throughputHistory[p].length).toFixed(2))
            : 0;
    });

    throughputCounters = { goldrush: 0, codex: 0 };

    if (isRunning) {
        broadcast({
            type: 'METRICS_UPDATE',
            data: {
                current: currentThroughput,
                average: avgCandlesPerSecond
            }
        });
    }
}, 1000);

// Store latest averages for the API
let latestLatency = { goldrush: 0, codex: 0 };

// Snapshot History every 5 seconds (Fast for testing, normally 1m or 10m)
setInterval(() => {
    if (!isRunning) return;

    const getAvg = (provider) => {
        const s = latencyStats[provider];
        if (s.count === 0) return latestLatency[provider] || 0; // Carry forward last known value
        const avg = Math.round(s.sum / s.count);
        // Reset
        s.sum = 0; s.count = 0;
        return avg;
    };

    // Calculate averages
    const grAvg = getAvg('goldrush');
    const cxAvg = getAvg('codex');

    // Update global state for /stats
    latestLatency = { goldrush: grAvg, codex: cxAvg };

    const snapshot = {
        time: Date.now(),
        goldrush: { avgLatency: grAvg },
        codex: { avgLatency: cxAvg }
    };

    performanceHistory.push(snapshot);
    if (performanceHistory.length > 1000) performanceHistory.shift(); // Keep last 1000

    broadcast({ type: 'HISTORY_UPDATE', data: performanceHistory });

    // --- METRICS HISTORY SNAPSHOT (for comparison charts) ---
    const grCurrentStats = grStats.getStats();

    // Calculate Raw Jitter (Max Delta)
    // Use Max Delta (biggest jump) to show volatility even with low throughput

    function calculateMaxIntervalDelta(samples, prevVal) {
        if (!samples || samples.length === 0) return 0;
        let maxD = 0;
        let prev = prevVal;

        // If prev is 0 (first run), use first sample as baseline (delta 0)
        if (prev === 0 && samples.length > 0) prev = samples[0];

        for (const val of samples) {
            const diff = Math.abs(val - prev);
            if (diff > maxD) maxD = diff;
            prev = val;
        }
        return maxD;
    }

    if (intervalLatencies.goldrush.length > 0) {
        lastIntervalStats.goldrush.stdDev = calculateMaxIntervalDelta(intervalLatencies.goldrush, lastIntervalEndVal.goldrush);
        lastIntervalEndVal.goldrush = intervalLatencies.goldrush[intervalLatencies.goldrush.length - 1]; // Update last val
    }
    if (intervalLatencies.codex.length > 0) {
        lastIntervalStats.codex.stdDev = calculateMaxIntervalDelta(intervalLatencies.codex, lastIntervalEndVal.codex);
        lastIntervalEndVal.codex = intervalLatencies.codex[intervalLatencies.codex.length - 1];
    }

    const metricsSnapshot = {
        time: Date.now(),
        goldrush: {
            loadTime: connectionMetrics.goldrush.loadTime,
            candlesPerSec: avgCandlesPerSecond.goldrush,
            jitter: grCurrentStats.jitter,              // Rolling Jitter (for Table)
            stdDev: lastIntervalStats.goldrush.stdDev,  // Max Delta (for Chart)
            p95: grCurrentStats.p95,
            p99: grCurrentStats.p99,
            eventCount: grStats.samples?.length || 0,
            avgLatency: grAvg
        },
        codex: {
            loadTime: connectionMetrics.codex.loadTime,
            candlesPerSec: avgCandlesPerSecond.codex,
            jitter: codexLatestStats.jitter,            // Rolling Jitter (for Table)
            stdDev: lastIntervalStats.codex.stdDev,     // Max Delta (for Chart)
            p95: codexLatestStats.p95,
            p99: codexLatestStats.p99,
            eventCount: cxStats.samples?.length || 0,
            avgLatency: cxAvg
        }
    };

    // Reset Interval Buckets for next snapshot
    intervalLatencies.goldrush = [];
    intervalLatencies.codex = [];

    metricsHistory.push(metricsSnapshot);
    if (metricsHistory.length > 720) metricsHistory.shift(); // Keep last 60 min (720 * 5s = 3600s = 1hr)
}, 5000);

// Helper to increment throughput
function countUpdate(provider) {
    if (throughputCounters[provider] !== undefined) {
        throughputCounters[provider]++;
    }
}

// --- STATS ENDPOINT ---
const startedAt = Date.now();
let performanceHistory = [];

app.get('/stats', (req, res) => {
    const uptime = Date.now() - startedAt;

    res.json({
        uptime,
        history: performanceHistory,
        throughput: currentThroughput,
        candlesPerMinute: {
            goldrush: currentThroughput.goldrush * 60,
            codex: currentThroughput.codex * 60
        },
        latencyRace: {
            goldrush: { avgLatency: latestLatency.goldrush },
            codex: { avgLatency: latestLatency.codex }
        },
        avgLatency300: {
            goldrush: getAvgLatency300('goldrush'),
            codex: getAvgLatency300('codex')
        }
    });
});

// --- METRICS HISTORY ENDPOINT (for comparison charts) ---
app.get('/metrics-history', (req, res) => {
    res.json({
        history: metricsHistory,
        current: {
            goldrush: {
                loadTime: connectionMetrics.goldrush.loadTime,
                candlesPerSec: avgCandlesPerSecond.goldrush,
                latencyVariance: getAvgDelta('goldrush'),
                latency300: getAvgLatency300('goldrush')
            },
            codex: {
                loadTime: connectionMetrics.codex.loadTime,
                candlesPerSec: avgCandlesPerSecond.codex,
                latencyVariance: getAvgDelta('codex'),
                latency300: getAvgLatency300('codex')
            }
        }
    });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- BROADCAST HELPER ---
function broadcast(msg) {
    if (!isRunning) return;
    const data = JSON.stringify(msg);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// --- GOLDRUSH: Process OHLCV Candles ---
async function processGoldrushCandles(candles) {
    const fastArrival = Date.now();

    if (!candles || candles.length === 0) return;

    const latestCandle = candles[candles.length - 1];
    const price = latestCandle.close || latestCandle.quote_rate_usd;

    // Auto-Detect Symbol from Metadata
    if (latestCandle.base_token && latestCandle.base_token.contract_ticker_symbol) {
        const detectedSymbol = latestCandle.base_token.contract_ticker_symbol;
        if (detectedSymbol && detectedSymbol !== SYMBOL) {
            // IGNORE 'Bonk' if we are on BASE (prevent cross-talk from zombie streams)
            if (CURRENT_CHAIN === 'BASE' && detectedSymbol === 'Bonk') return;

            console.log(`\n🔍 Auto-Detected Symbol: ${detectedSymbol} (was ${SYMBOL})`);
            const oldSymbol = SYMBOL;
            SYMBOL = detectedSymbol;

            // Migrate state
            if (pairs[oldSymbol]) {
                pairs[SYMBOL] = pairs[oldSymbol];
                delete pairs[oldSymbol];
            } else {
                pairs[SYMBOL] = {
                    price: pairs[oldSymbol]?.price || 0,
                    fastPrice: pairs[oldSymbol]?.fastPrice || 0,
                    slowPrice: pairs[oldSymbol]?.slowPrice || 0
                };
            }

            // Broadcast Update
            broadcast({ type: 'SYMBOL_UPDATE', data: { symbol: SYMBOL } });
        }
    }

    // Basic validation: Price must be positive
    if (!price || price <= 0) {
        console.warn(`⚠️ Ignored invalid price ($${price})`);
        return;
    }

    const candleTimeMs = new Date(latestCandle.timestamp).getTime();
    // For ONE_MINUTE interval, candle close time is candleStart + 60 seconds
    // We measure latency relative to when the candle *could* first arrive (at close)
    const CANDLE_DURATION_MS = 60 * 1000;
    let goldRushLatency = Date.now() - (candleTimeMs + CANDLE_DURATION_MS);

    // DEBUG:
    console.log(`[LATENCY DEBUG] GR: Now=${Date.now()} Candle=${candleTimeMs} Lat=${goldRushLatency}`);
    if (goldRushLatency < 0) goldRushLatency = 0;

    // Track Latency
    latencyStats.goldrush.sum += goldRushLatency;
    latencyStats.goldrush.count++;
    addLatencySample('goldrush', goldRushLatency);
    addLatencyDelta('goldrush', goldRushLatency);
    latestLatency.goldrush = goldRushLatency;

    logger.goldrush.stream(price, goldRushLatency, candles.length);
    countUpdate('goldrush'); // Track Hz


    pairs[SYMBOL].price = price;
    pairs[SYMBOL].fastPrice = price;

    // Accumulate candles
    const newCandles = candles.map(c => ({
        time: Math.floor(new Date(c.timestamp).getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
    }));



    const candleMap = new Map();
    goldrushCandles.forEach(c => candleMap.set(c.time, c));
    newCandles.forEach(c => candleMap.set(c.time, c));

    goldrushCandles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-15);

    broadcast({
        type: 'FAST_TICK',
        data: {
            pair: SYMBOL,
            price: price,
            timestamp: fastArrival,
            latency: goldRushLatency,
            candles: goldrushCandles,
            throughput: avgCandlesPerSecond.goldrush
        }
    });

    // Run INDEPENDENT GoldRush paper trading
    // checkGoldrushTrade(price);
}


// --- CODEX WEBSOCKET SUBSCRIPTION ---
let codexCleanup = null;


async function initCodexProvider() {
    // Start Live Subscription via SDK IMPACT: Run in parallel with history fetch
    startCodexSubscription();

    // Fetch History (Backfill) via HTTP - purely for chart data
    console.log("🐢 Fetching Codex History...");
    await fetchCodexPrice();
}

function startCodexSubscription() {
    if (codexCleanup) {
        try { codexCleanup(); } catch (e) { }
        codexCleanup = null;
    }

    console.log("🐢 Connecting to Codex GraphQL Stream (Events)...");
    connectionMetrics.codex.loadStart = Date.now(); // TTFD timer starts here
    connectionMetrics.codex.connects++;

    // Raw graphql-ws connection (NO SDK)
    const codexWsClient = createClient({
        url: 'wss://graph.codex.io/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            Authorization: process.env.CODEX_API_KEY
        },
        on: {
            connected: () => {
                const connectTime = Date.now() - connectionMetrics.codex.loadStart;
                console.log(`✅ Connected to Codex GraphQL Stream! (Handshake: ${connectTime}ms)`);
            },
            error: (err) => {
                console.error('❌ Codex WS Error:', err);
                connectionMetrics.codex.errors++;
                connectionMetrics.codex.lastError = Date.now();
            }
        }
    });

    const address = PAIR_ADDRESS;
    const networkId = parseInt(CODEX_NETWORK_ID);

    console.log(`🐢 Subscribing to Codex Events for: ${address} on Network: ${networkId}`);

    const query = `
        subscription($address: String!, $networkId: Int!) {
            onEventsCreated(
                address: $address
                networkId: $networkId
            ) {
                events {
                    transactionHash
                    blockNumber
                    timestamp
                    data {
                        ... on SwapEventData {
                            priceUsd
                            amount0
                            amount1
                            type
                        }
                    }
                }
            }
        }
    `;

    codexWsClient.subscribe(
        {
            query,
            variables: { address, networkId }
        },
        {
            next: (result) => {
                const events = result?.data?.onEventsCreated?.events;
                if (events && events.length > 0) {
                    // Track first data load time (WS Connection -> First Packet)
                    if (connectionMetrics.codex.loadTime === 0) {
                        connectionMetrics.codex.loadTime = Date.now() - connectionMetrics.codex.loadStart;
                        console.log(`✅ Codex Time to First Data (WS-Events Stopwatch): ${connectionMetrics.codex.loadTime}ms`);
                    }
                    processCodexEvents(events);
                }
            },
            error: (err) => {
                console.error('❌ Codex Subscription Error:', err);
                connectionMetrics.codex.errors++;
                connectionMetrics.codex.lastError = Date.now();
            },
            complete: () => console.log('🐢 Codex Subscription Complete')
        }
    );

    codexCleanup = () => codexWsClient.dispose();
    console.log("✅ Codex GraphQL Subscription Active (Events)!");

    // --- SECOND SUBSCRIPTION: onBarsUpdated for Bar Chart Throughput ---
    console.log("📊 Starting Codex onBarsUpdated Stream (Bar Chart)...");
    const codexBarsClient = createClient({
        url: 'wss://graph.codex.io/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            Authorization: process.env.CODEX_API_KEY
        },
        on: {
            connected: () => {
                const connectTime = Date.now() - connectionMetrics.codex.loadStart;
                console.log(`✅ Connected to Codex onBarsUpdated Stream! (Handshake: ${connectTime}ms)`);
            },
            error: (err) => console.error('❌ Codex Bars WS Error:', err)
        }
    });

    const pairId = `${PAIR_ADDRESS}:${CODEX_NETWORK_ID}`;
    const barsQuery = `
        subscription($pairId: String!) {
            onBarsUpdated(
                pairId: $pairId
                quoteToken: token0
            ) {
                pairId
                timestamp
                aggregates {
                    r1 {
                        t
                        usd {
                            o
                            h
                            l
                            c
                            volume
                            t
                        }
                    }
                }
            }
        }
    `;

    codexBarsClient.subscribe(
        { query: barsQuery, variables: { pairId } },
        {
            next: (result) => {
                const now = Date.now();
                const bar = result?.data?.onBarsUpdated;
                if (bar && bar.aggregates?.r1?.usd) {
                    // Track TTFD if not already rejected
                    if (connectionMetrics.codex.loadTime === 0) {
                        connectionMetrics.codex.loadTime = Date.now() - connectionMetrics.codex.loadStart;
                        console.log(`✅ Codex Time to First Data (WS-Bars Stopwatch): ${connectionMetrics.codex.loadTime}ms`);
                    }
                    countUpdate('codex');

                    // Latency: now - bar timestamp (Unix seconds)
                    const barTimeMs = bar.timestamp * 1000;
                    const latency = now - barTimeMs;
                    const price = bar.aggregates.r1.usd.c;

                    // Metrics (same stream type as GoldRush updatePairs)
                    latencyStats.codex.sum += latency;
                    latencyStats.codex.count++;
                    addLatencySample('codex', latency);
                    addLatencyDelta('codex', latency);
                    latestLatency.codex = latency;

                    // Rolling Stats
                    cxStats.add(latency);
                    const stats = cxStats.getStats();
                    codexLatestStats = stats;

                    // Interval Push (Raw Jitter)
                    if (latency >= 0 && latency < 60000) intervalLatencies.codex.push(latency);

                    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                    eventCounters.codexBars++;
                    const agg = bar.aggregates?.r1?.usd;
                    console.log(`\n[${timeStr}] [CODEX] onBarsUpdated Event #${eventCounters.codexBars}`);
                    console.log(`  O:${agg?.o?.toFixed(4)} H:${agg?.h?.toFixed(4)} L:${agg?.l?.toFixed(4)} C:${agg?.c?.toFixed(4)}`);
                    console.log(`  Timestamp: ${bar.timestamp} | Latency: ${latency}ms`);

                    // Broadcast log event to frontend
                    broadcast({
                        type: 'LOG_EVENT',
                        provider: 'codex',
                        data: {
                            id: `codex-${eventCounters.codexBars}`,
                            eventNum: eventCounters.codexBars,
                            eventType: 'onBarsUpdated',
                            time: timeStr,
                            o: agg?.o?.toFixed(4),
                            h: agg?.h?.toFixed(4),
                            l: agg?.l?.toFixed(4),
                            c: agg?.c?.toFixed(4),
                            timestamp: bar.timestamp,
                            latency: latency
                        }
                    });

                    broadcast({
                        type: 'SLOW_TICK',
                        data: {
                            pair: SYMBOL,
                            price: price,
                            timestamp: now,
                            latency: latency,
                            candles: [],
                            throughput: avgCandlesPerSecond.codex,
                            stats: stats
                        }
                    });
                }
            },
            error: (err) => console.error('❌ Codex Bars Subscription Error:', err),
            complete: () => console.log('📊 Codex Bars Subscription Complete')
        }
    );

    // Update cleanup to dispose BOTH clients
    const originalCleanup = codexCleanup;
    codexCleanup = () => {
        try { originalCleanup(); } catch (e) { }
        try { codexBarsClient.dispose(); } catch (e) { }
    };
}


function processCodexEvents(events) {
    // NOTE: Latency stats are now calculated in onBarsUpdated for equal comparison with GoldRush
    // This function only updates the price state from swap events

    events.forEach(event => {
        if (event.data && event.data.priceUsd) {
            const price = parseFloat(event.data.priceUsd);

            // Update State only
            if (!pairs[SYMBOL]) pairs[SYMBOL] = { price: 0, fastPrice: 0, slowPrice: 0, geckoPrice: 0 };
            pairs[SYMBOL].slowPrice = price;

            // Update global stats capture
            updatePairs(SYMBOL, {
                slowPrice: price
            });
        }
    });
}

async function fetchCodexPrice() {
    const startTime = Date.now();
    try {
        const now = Math.floor(Date.now() / 1000);
        const lookback = now - 900;

        const query = `
            query {
                getBars(
                    symbol: "${TOKEN_ADDRESS}:${CODEX_NETWORK_ID}"
                    from: ${lookback}
                    to: ${now}
                    resolution: "1"
                ) {
                    t
                    o
                    h
                    l
                    c
                }
            }
        `;

        const response = await axios.post(
            'https://graph.codex.io/graphql',
            { query },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': process.env.CODEX_API_KEY
                },
                timeout: 15000
            }
        );

        const endTime = Date.now();
        const networkLatency = endTime - startTime;
        const data = response.data?.data?.getBars;

        if (data && data.c && data.c.length > 0) {
            const codexPrice = data.c[data.c.length - 1];

            // TTFD now calculated in onBarsUpdated subscription (standardized)

            pairs[SYMBOL].slowPrice = codexPrice;

            // Format OHLCV candles
            codexCandles = data.t.map((timestamp, i) => ({
                time: timestamp,
                open: data.o[i],
                high: data.h[i],
                low: data.l[i],
                close: data.c[i]
            })).sort((a, b) => a.time - b.time);

            broadcast({
                type: 'SLOW_TICK',
                data: {
                    pair: SYMBOL,
                    price: codexPrice,
                    timestamp: endTime,
                    latency: networkLatency,
                    candles: codexCandles,
                    throughput: avgCandlesPerSecond.codex
                }
            });

            // Run INDEPENDENT Codex paper trading
            // checkCodexTrade(codexPrice);
        }

    } catch (err) {
        // Log Codex errors for debugging
        console.warn("⚠️ Codex fetch error:", err.message);
    }
}


// --- GOLDRUSH STREAM (raw graphql-ws) ---
let goldrushCleanup = null;

function startStream() {
    console.log(`🚀 Starting GoldRush OHLCV Pairs Stream on: ${CURRENT_CHAIN}`);
    connectionMetrics.goldrush.loadStart = Date.now();

    // Use graphql-ws for raw GraphQL subscription (NO SDK)
    const grWsClient = createClient({
        url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
        },
        on: {
            connected: () => {
                console.log('✅ Connected to GoldRush OHLCV Stream!');
                connectionMetrics.goldrush.connects++;
            },
            error: (err) => {
                console.error('❌ GoldRush WS Error:', err);
                connectionMetrics.goldrush.errors++;
                connectionMetrics.goldrush.lastError = Date.now();
            },
            closed: () => console.log('📴 GoldRush OHLCV Stream Disconnected')
        }
    });

    const query = `subscription {
        ohlcvCandlesForPair(
            chain_name: ${CURRENT_CHAIN}
            pair_addresses: ["${PAIR_ADDRESS}"]
            interval: ONE_MINUTE
            timeframe: ONE_HOUR
        ) {
            chain_name
            pair_address
            interval
            timeframe
            timestamp
            open
            high
            low
            close
            volume
            volume_usd
            quote_rate
            quote_rate_usd
            base_token {
                contract_ticker_symbol
            }
            quote_token {
                contract_ticker_symbol
            }
        }
    }`;

    // Subscribe and handle events
    grWsClient.subscribe({ query }, {
        next: (result) => {
            const candles = result?.data?.ohlcvCandlesForPair;
            if (candles && candles.length > 0) {
                eventCounters.goldrushOHLCV++;
                const c = candles[candles.length - 1];
                const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                console.log(`\n[GOLDRUSH] OHLCV Event #${eventCounters.goldrushOHLCV}`);
                console.log(`  O:${c.open?.toFixed(4)} H:${c.high?.toFixed(4)} L:${c.low?.toFixed(4)} C:${c.close?.toFixed(4)} V:${c.volume?.toFixed(2)}`);
                console.log(`  Timestamp: ${c.timestamp}`);

                // TTFD now calculated from updatePairs (raw latency stream)
                processGoldrushOHLCV(candles);
            }
        },
        error: (err) => {
            console.error('❌ GoldRush Subscription Error:', err);
            connectionMetrics.goldrush.errors++;
            connectionMetrics.goldrush.lastError = Date.now();
        },
        complete: () => console.log('GoldRush OHLCV Stream Completed')
    });

    // Cleanup logic for OHLCV client
    const disposeOHLCV = () => grWsClient.dispose();

    // --- SEPARATE CLIENT: updatePairs for LATENCY METRICS ---
    console.log('📊 Starting GoldRush updatePairs Stream...');
    const grUpdatePairsClient = createClient({
        url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
        },
        on: {
            connected: () => console.log('✅ Connected to GoldRush updatePairs Stream!'),
            error: (err) => console.error('❌ GoldRush updatePairs WS Error:', err)
        }
    });

    const updatePairsQuery = `subscription {
        updatePairs(
            chain_name: ${CURRENT_CHAIN}
            pair_addresses: ["${PAIR_ADDRESS.toLowerCase()}"]
        ) {
            chain_name
            pair_address
            timestamp
            quote_rate
            quote_rate_usd
            volume
            volume_usd
            market_cap
            liquidity
        }
    }`;

    grUpdatePairsClient.subscribe({ query: updatePairsQuery }, {
        next: (result) => {
            const update = result?.data?.updatePairs;
            if (update && update.timestamp) {
                eventCounters.goldrushUpdatePairs++;
                const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                console.log(`\n[GOLDRUSH] updatePairs Event #${eventCounters.goldrushUpdatePairs}`);
                console.log(`  Timestamp: ${update.timestamp}`);

                // Broadcast log event to frontend
                broadcast({
                    type: 'LOG_EVENT',
                    provider: 'goldrush',
                    data: {
                        id: `gr-update-${eventCounters.goldrushUpdatePairs}`,
                        eventNum: eventCounters.goldrushUpdatePairs,
                        eventType: 'updatePairs',
                        time: timeStr,
                        timestamp: update.timestamp,
                        price: update.quote_rate_usd?.toFixed(4)
                    }
                });

                // Track TTFD from first updatePairs packet (more accurate freshness)
                if (connectionMetrics.goldrush.loadTime === 0) {
                    connectionMetrics.goldrush.loadTime = Date.now() - connectionMetrics.goldrush.loadStart;
                    console.log(`✅ GoldRush Time to First Data (updatePairs Stopwatch): ${connectionMetrics.goldrush.loadTime}ms`);
                }
                processGoldrushUpdate(update);
            }
        },
        error: (err) => {
            console.error('❌ GoldRush updatePairs Error:', err);
        },
        complete: () => console.log('GoldRush updatePairs Stream Completed')
    });

    // Cleanup BOTH clients
    goldrushCleanup = () => {
        try { disposeOHLCV(); } catch (e) { }
        try { grUpdatePairsClient.dispose(); } catch (e) { }
    };
}

// --- GOLDRUSH: Process updatePairs for LATENCY METRICS ---
function processGoldrushUpdate(update) {
    if (!update || !update.timestamp) return;

    const now = Date.now();

    // TTFD now calculated in ohlcvCandlesForPair handler (standardized to bar chart stream)

    // timestamp is the block timestamp (ISO string)
    const blockTime = new Date(update.timestamp).getTime();
    const latency = now - blockTime; // client_receive_time - block_time

    // Log latency like Codex
    const price = parseFloat(update.quote_rate_usd || 0).toFixed(2);
    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    console.log(`[${timeStr}] [GOLDRUSH] STREAM     | Tick received | Price: $${price} | Latency: ${latency}ms | Timestamp: ${update.timestamp}`);

    // Add to rolling stats for p50/p95/p99
    grStats.add(latency);
    latestLatency.goldrush = latency;

    // Interval Push (Raw Jitter)
    intervalLatencies.goldrush.push(latency);

    addLatencySample('goldrush', latency);
    latencyStats.goldrush.sum += latency;
    latencyStats.goldrush.count++;
    addLatencyDelta('goldrush', latency);
    countUpdate('goldrush');
}

// --- GOLDRUSH: Process OHLCV Candles (charts only, latency comes from updatePairs) ---
function processGoldrushOHLCV(candles) {
    if (!candles || candles.length === 0) return;

    const latestCandle = candles[candles.length - 1];
    const price = latestCandle.close || latestCandle.quote_rate;

    if (price) {
        pairs[SYMBOL].price = price;
        pairs[SYMBOL].fastPrice = price;
    }

    // Update candles array for charts
    const newCandles = candles.map(c => ({
        time: Math.floor(new Date(c.timestamp).getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume_usd
    }));

    // Merge with existing candles
    const candleMap = new Map();
    goldrushCandles.forEach(c => candleMap.set(c.time, c));
    newCandles.forEach(c => candleMap.set(c.time, c));

    goldrushCandles = Array.from(candleMap.values())
        .sort((a, b) => a.time - b.time)
        .slice(-60); // Keep last 60 candles (1 hour of 1-min candles)

    // Broadcast candle update (latency stats come from updatePairs stream)
    broadcast({
        type: 'FAST_TICK',
        data: {
            pair: SYMBOL,
            price: price,
            timestamp: Date.now(),
            latency: latestLatency.goldrush,
            candles: goldrushCandles,
            throughput: avgCandlesPerSecond.goldrush
        }
    });
}

// --- INITIALIZATION ---
server.listen(PORT, async () => {
    console.log(`🚀 Server Starting (${CURRENT_CHAIN} - ${SYMBOL})...`);

    // Resolve Network ID dynamically
    if (CHAIN_CONFIG[CURRENT_CHAIN]) {
        CODEX_NETWORK_ID = CHAIN_CONFIG[CURRENT_CHAIN].codexNetworkId;
        console.log(`✅ Using Codex Network ID: ${CODEX_NETWORK_ID}`);
    } else {
        console.warn(`⚠️ Unknown Chain: ${CURRENT_CHAIN}, defaulting to Solana ID`);
    }

    // Initialize Providers
    try {
        streamsStartTime = Date.now(); // Set global start time for all streams
        startStream(); // GoldRush
        await initCodexProvider(); // Codex
    } catch (err) {
        console.error("❌ Stats Server Init Error:", err);
    }

    console.log(`✅ Backend listening on http://localhost:${PORT}`);
});

// --- WS CONNECTION HANDLING ---
wss.on('connection', (ws) => {
    clients.add(ws);

    ws.send(JSON.stringify({
        type: 'INIT',
        data: { pairs, trades: [], ideas: [] }
    }));

    // Send existing candle data
    if (goldrushCandles.length > 0) {
        ws.send(JSON.stringify({
            type: 'FAST_TICK',
            data: {
                pair: SYMBOL,
                price: pairs[SYMBOL].fastPrice,
                timestamp: Date.now(),
                latency: 0,
                candles: goldrushCandles
            }
        }));
    }

    if (codexCandles.length > 0) {
        ws.send(JSON.stringify({
            type: 'SLOW_TICK',
            data: {
                pair: SYMBOL,
                price: pairs[SYMBOL].slowPrice,
                timestamp: Date.now(),
                latency: 0,
                candles: codexCandles
            }
        }));
    }






    ws.on('close', () => clients.delete(ws));
});


