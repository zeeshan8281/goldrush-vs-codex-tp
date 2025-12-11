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

    // TRIGGER CODEX SIDE
    fetchAndEmitCodexTick(price, fastArrival, goldRushLatency);
}

// --- CODEX GraphQL API (Slow/Standard) ---
async function fetchAndEmitCodexTick(goldRushPrice, goldRushArrival, goldRushLatencyVal) {
    const startTime = Date.now();
    let codexPrice = goldRushPrice; // Default fallback
    let networkLatency = 0;

    try {
        // Construct GraphQL Query for latest 1-min bar
        const now = Math.floor(Date.now() / 1000);
        const lookback = now - 900; // 15 mins lookback

        const query = `
            query {
                getBars(
                    symbol: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b:8453"
                    from: ${lookback}
                    to: ${now}
                    resolution: "1"
                ) {
                    c
                    t
                }
            }
        `;

        console.log("🐢 CODEX: Fetching GraphQL...");
        const response = await axios.post(
            'https://graph.codex.io/graphql',
            { query },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': process.env.CODEX_API_KEY
                    // Note: If Codex requires Bearer, use `Bearer ${...}`. Docs say 'Authorization'.
                },
                timeout: 5000
            }
        );

        const endTime = Date.now();
        networkLatency = endTime - startTime;

        const data = response.data?.data?.getBars;

        if (data && data.c && data.c.length > 0) {
            // Get the last available close price
            codexPrice = data.c[data.c.length - 1];
            console.log(`🐢 CODEX [GRAPHQL]: $${codexPrice} | Latency: ${networkLatency}ms`);
        } else {
            console.log(`🐢 CODEX: No data returned. Latency: ${networkLatency}ms`);
            // We keep codexPrice = fastPrice or old price to avoid 0
        }

    } catch (err) {
        console.error("🐢 CODEX API Error:", err.message);
        if (err.response) {
            console.error("   Response Data:", JSON.stringify(err.response.data));
        }
        networkLatency = Date.now() - startTime; // Record the failed time
    }

    // --- BROADCAST SLOW TICK ---
    pairs[SYMBOL].slowPrice = codexPrice;

    broadcast({
        type: 'SLOW_TICK',
        data: {
            pair: SYMBOL,
            price: codexPrice,
            timestamp: Date.now(),
            latency: networkLatency
        }
    });

    // --- ARBITRAGE LOGIC ---
    const priceDiff = Math.abs(goldRushPrice - codexPrice);
    const hasArb = priceDiff > 0.00000001;

    if (hasArb) {
        console.log(`[ARBITRAGE] Diff $${priceDiff.toFixed(8)}`);

        const tradeId = Date.now();
        const side = goldRushPrice > codexPrice ? 'LONG' : 'SHORT';
        const pnl = Number((priceDiff * 10000).toFixed(4));

        const goldRushTrade = {
            id: `fast-${tradeId}`,
            timestamp: goldRushArrival,
            pair: SYMBOL,
            side: side,
            entryPrice: codexPrice,
            exitPrice: goldRushPrice,
            pnl: pnl,
            status: 'Win',
            latency: `${goldRushLatencyVal}ms`,
            latencyAdvantageMs: networkLatency
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
            latency: `${networkLatency}ms`
        };

        trades.unshift(goldRushTrade);
        if (trades.length > 50) trades.pop();

        broadcast({ type: 'FAST_TRADE', data: goldRushTrade });
        broadcast({ type: 'SLOW_TRADE', data: codexTrade });
    } else {
        console.log("[SYNC] No Arbitrage");
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
