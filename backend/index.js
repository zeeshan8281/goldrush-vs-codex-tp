const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('graphql-ws');
require('dotenv').config();

// --- CONFIGURATION ---
const PORT = 3002;
const SYMBOL = 'VIRTUAL-USD';
// Using CODEX API Key for the REST fetch
// Using CODEX API Key for the REST fetch
const WS_STREAM_URL = 'wss://gr-staging-v2.streaming.covalenthq.com/graphql';

// --- STATE MANAGEMENT ---
let pairs = {
    [SYMBOL]: {
        price: 0,
        fastPrice: 0,
        slowPrice: 0
    }
};
let trades = [];
let clients = new Set();
let isRunning = true;

// --- SERVER SETUP ---
const app = express();
app.use(cors());
app.use(express.json());
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

// --- CORE LOGIC: PROCESS REAL PRICE UPDATE ---
async function processNewPrice(price, candleTimestamp) {
    // 1. Capture High-Res Timestamp of "Fast" Arrival
    const fastArrival = Date.now();

    // GoldRush Latency (Real Calculation): 
    // Candle arrives *after* the minute closes.
    // candleTimestamp is usually the *start* of the minute (e.g. 12:00:00).
    // The candle is "ready" at 12:01:00 (start + 60s).
    // Latency = Now - (CandleStart + 60s).

    const candleTimeMs = new Date(candleTimestamp).getTime();
    const candleCloseTime = candleTimeMs + 60000; // +1 minute
    let goldRushLatency = fastArrival - candleCloseTime;

    // Handle slight clock skews or if timestamp was actually close-time (unlikely for OHLCV)
    if (goldRushLatency < 0) goldRushLatency = 0;

    console.log(`\n⚡ GOLDRUSH [STREAM]: $${price} | Candle: ${candleTimestamp} | Latency: ${goldRushLatency}ms`);

    // Update State
    pairs[SYMBOL].price = price;
    pairs[SYMBOL].fastPrice = price;

    broadcast({
        type: 'FAST_TICK',
        data: {
            pair: SYMBOL,
            price: price,
            timestamp: fastArrival,
            latency: goldRushLatency // "Live"
        }
    });

    // Check Arbitrage on Fast Update
    checkArbitrageAndBroadcast();
}

// --- CODEX POLLING LOOP (Independent Feed) ---
async function startCodexPolling() {
    console.log("🐢 Starting Codex Polling Loop...");
    setInterval(async () => {
        await fetchCodexPrice();
    }, 2000); // Poll every 2 seconds
}

async function fetchCodexPrice() {
    const startTime = Date.now();
    try {
        const now = Math.floor(Date.now() / 1000);
        const lookback = now - 900;

        const query = `
            query {
                getBars(
                    symbol: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b:8453"
                    from: ${lookback}
                    to: ${now}
                    resolution: "1"
                ) {
                    c
                }
            }
        `;

        // console.log("🐢 Polling Codex...");
        const response = await axios.post(
            'https://graph.codex.io/graphql',
            { query },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': process.env.CODEX_API_KEY
                },
                timeout: 5000
            }
        );

        const endTime = Date.now();
        const networkLatency = endTime - startTime;
        const data = response.data?.data?.getBars;

        if (data && data.c && data.c.length > 0) {
            const codexPrice = data.c[data.c.length - 1];

            // Only broadcast/log if price changed or it's a heartbeat
            // For this demo, let's broadcast every poll to show it's alive
            // console.log(`🐢 CODEX: $${codexPrice}`);

            pairs[SYMBOL].slowPrice = codexPrice;

            broadcast({
                type: 'SLOW_TICK',
                data: {
                    pair: SYMBOL,
                    price: codexPrice,
                    timestamp: endTime,
                    latency: networkLatency
                }
            });

            checkArbitrageAndBroadcast();
        }

    } catch (err) {
        // console.error("🐢 Poll Error:", err.message);
    }
}


// --- CENTRAL ARBITRAGE LOGIC ---
function checkArbitrageAndBroadcast() {
    const goldRushPrice = pairs[SYMBOL].fastPrice;
    const codexPrice = pairs[SYMBOL].slowPrice;

    if (!goldRushPrice || !codexPrice) return;

    const priceDiff = Math.abs(goldRushPrice - codexPrice);
    const hasArb = priceDiff > 0.00000001;

    if (hasArb) {
        // Debounce: Don't spam trades for the same price diff? 
        // For simulation, let's just log unique ones or cap rate.
        // We'll keep it simple: detected = trade.

        console.log(`[ARBITRAGE] Diff $${priceDiff.toFixed(8)}`);

        const tradeId = Date.now();
        const side = goldRushPrice > codexPrice ? 'LONG' : 'SHORT';
        const pnl = Number((priceDiff * 10000).toFixed(4));

        // We need a way to attribute who "won" or just show the diff.
        // In decoupled mode, "Fast" is just the current GoldRush State.

        const goldRushTrade = {
            id: `fast-${tradeId}`,
            timestamp: Date.now(),
            pair: SYMBOL,
            side: side,
            entryPrice: codexPrice,
            exitPrice: goldRushPrice,
            pnl: pnl,
            status: 'Win',
            latency: `Live`,
            latencyAdvantageMs: 0 // Calculated differently in async mode
        };

        const codexTrade = {
            id: `slow-${tradeId}`,
            timestamp: Date.now(),
            pair: SYMBOL,
            side: side,
            entryPrice: goldRushPrice,
            exitPrice: goldRushPrice,
            pnl: -pnl,
            status: 'Late',
            latency: `Pooled`
        };

        trades.unshift(goldRushTrade);
        if (trades.length > 50) trades.pop();

        broadcast({ type: 'FAST_TRADE', data: goldRushTrade });
        broadcast({ type: 'SLOW_TRADE', data: codexTrade });
    }
}


// --- GOLDRUSH WEBSOCKET CLIENT ---
const client = createClient({
    url: WS_STREAM_URL,
    webSocketImpl: WebSocket,
    connectionParams: {
        GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY,
    },
    shouldRetry: () => true,
});

const QUERY = `
  subscription {
    ohlcvCandlesForToken(
      chain_name: BASE_MAINNET
      token_addresses: ["0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b"]
      interval: ONE_MINUTE
      timeframe: ONE_HOUR
    ) {
      timestamp
      close
    }
  }
`;

function startStream() {
    console.log("🔗 Connecting to GoldRush Stream...");
    client.subscribe(
        { query: QUERY },
        {
            next: (data) => {
                if (data.data?.ohlcvCandlesForToken?.[0]) {
                    const candle = data.data.ohlcvCandlesForToken[0];
                    processNewPrice(candle.close, candle.timestamp);
                }
            },
            error: (err) => console.error('Stream Error:', err),
            complete: () => console.log('Stream Closed'),
        }
    );
}

// --- INITIALIZATION ---
async function init() {
    console.log("🚀 Server Starting (REAL MODE)...");

    // Get Initial Price using Codex GraphQL
    try {
        const now = Math.floor(Date.now() / 1000);
        const lookback = now - 900;
        const query = `
            query {
                getBars(
                    symbol: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b:8453"
                    from: ${lookback}
                    to: ${now}
                    resolution: "1"
                ) {
                    c
                }
            }
        `;

        const res = await axios.post(
            'https://graph.codex.io/graphql',
            { query },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': process.env.CODEX_API_KEY
                },
                timeout: 5000
            }
        );

        const data = res.data?.data?.getBars;
        const initialPrice = (data && data.c && data.c.length > 0) ? data.c[data.c.length - 1] : 0;

        pairs[SYMBOL].price = initialPrice;
        pairs[SYMBOL].fastPrice = initialPrice;
        pairs[SYMBOL].slowPrice = initialPrice;
        console.log(`✅ Initial Price Snapshot: $${initialPrice}`);
    } catch (err) {
        console.log("⚠️ Could not fetch initial price:", err.message);
    }

    startStream();
    startCodexPolling();

    server.listen(PORT, () => {
        console.log(`✅ Backend listening on http://localhost:${PORT}`);
    });
}

// --- WS CONNECTION HANDLING ---
wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({
        type: 'INIT',
        data: { pairs, trades, ideas: [] }
    }));
    ws.on('close', () => clients.delete(ws));
});

init();
