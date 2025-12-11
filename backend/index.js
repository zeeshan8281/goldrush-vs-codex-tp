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
const REST_API_URL = `https://api.covalenthq.com/v1/base-mainnet/address/0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b/balances_v2/?key=${process.env.COVALENT_API_KEY}`;
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

    console.log(`\n⚡ FAST [STREAM]: $${price} | Candle: ${candleTimestamp} | Latency: ${goldRushLatency}ms`);

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

    // 2. Trigger SLOW Fetch (Codex / REST) - 100% REAL Network Call
    // We start the clock exactly when we received the Fast update.
    fetchAndEmitSlowTick(price, fastArrival, goldRushLatency);
}

async function fetchAndEmitSlowTick(fastPrice, fastArrivalTime, fastLatencyVal) {
    const start = Date.now();
    try {
        console.log("🐢 SLOW: Fetching REST API...");
        // Actual Network Request
        const response = await axios.get(REST_API_URL, { timeout: 5000 });
        const end = Date.now();

        // 3. Calculate REAL Network Latency (RTT)
        // This is the time it took to go text the REST API and get a result.
        const networkLatency = end - start;

        // Extract Price
        const items = response.data.data.items;
        // If quote_rate is null/undefined, we might have an issue, but we want "Real" data.
        // We will default to 0 if missing to show the error, or fastPrice if we must fallback, 
        // but for "Real" analysis, we should probably record it as is.
        const codexPrice = items[0]?.quote_rate;

        if (codexPrice === undefined) {
            console.log("🐢 SLOW: Warning - No price in REST response.");
            return;
        }

        console.log(`🐢 SLOW: $${codexPrice} | Latency: ${networkLatency}ms`);

        pairs[SYMBOL].slowPrice = codexPrice;

        broadcast({
            type: 'SLOW_TICK',
            data: {
                pair: SYMBOL,
                price: codexPrice,
                timestamp: end,
                latency: networkLatency
            }
        });

        // 4. CHECK FOR REAL ARBITRAGE OPPORTUNITY
        // Logic: Did the REST API give us a different price?
        const priceDiff = Math.abs(fastPrice - codexPrice);

        // Threshold: Even $0.0000001 is money in crypto.
        const hasArb = priceDiff > 0.00000001;

        if (hasArb) {
            console.log(`💰 ARBITRAGE FOUND: Diff $${priceDiff.toFixed(8)}`);

            const tradeId = Date.now();
            const side = fastPrice > codexPrice ? 'LONG' : 'SHORT';
            const pnl = Number((priceDiff * 10000).toFixed(4)); // 10k units size

            // GoldRush Execution (Win)
            // We "executed" at the fast price, capitalizing on the lag.
            const fastTrade = {
                id: `fast-${tradeId}`,
                timestamp: fastArrivalTime,
                pair: SYMBOL,
                side: side,
                entryPrice: codexPrice, // The "Old" price we saw on Codex
                exitPrice: fastPrice,   // The "New" price we executed on GoldRush
                pnl: pnl,
                status: 'Win',
                latency: `${fastLatencyVal}ms`,
                latencyAdvantageMs: networkLatency
            };

            // Codex Execution (Miss/Late)
            // We assign NEGATIVE PnL to represent the "Opportunity Cost" or "Slippage"
            // of being late to the trade.
            const slowTrade = {
                id: `slow-${tradeId}`,
                timestamp: end, // Arrived much later
                pair: SYMBOL,
                side: side,
                entryPrice: fastPrice,
                exitPrice: fastPrice,
                pnl: -pnl, // Negative PnL (Loss/Missed)
                status: 'Late',
                latency: `${networkLatency}ms`
            };

            trades.unshift(fastTrade);
            if (trades.length > 50) trades.pop();

            broadcast({ type: 'FAST_TRADE', data: fastTrade });
            broadcast({ type: 'SLOW_TRADE', data: slowTrade });
            broadcast({ type: 'TRADE_OPEN', data: fastTrade }); // For legacy handlers
        } else {
            console.log("⚖️  Synced: No Arbitrage");
        }

    } catch (err) {
        console.error("🐢 SLOW Fetch Error:", err.message);
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

    // Get Initial Price (Snapshot)
    try {
        const res = await axios.get(REST_API_URL);
        const initialPrice = res.data?.data?.items?.[0]?.quote_rate || 0;
        pairs[SYMBOL].price = initialPrice;
        pairs[SYMBOL].fastPrice = initialPrice;
        pairs[SYMBOL].slowPrice = initialPrice;
        console.log(`✅ Initial Price Snapshot: $${initialPrice}`);
    } catch (err) {
        console.log("⚠️ Could not fetch initial price.");
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
