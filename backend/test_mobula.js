
const WebSocket = require('ws');
require('dotenv').config();

const API_KEY = process.env.MOBULA_API_KEY;
if (!API_KEY) {
    console.error("❌ Stats: Missing MOBULA_API_KEY in .env");
    process.exit(1);
}

// Configuration
const PAIR_ADDRESS = '3ne4mWqdYuNiYrYZC9TrA3FcfuFdErghH97vNPbjicr1'; // BONK/SOL (Raydium)
const CHAIN_ID = 'solana';

console.log(`🔌 Connecting to Mobula WebSocket...`);
const ws = new WebSocket('wss://api.mobula.io');

ws.on('open', () => {
    console.log("✅ Mobula WS Connected");

    // Subscribe Market Details (Trades)
    const marketMsg = {
        type: "market-details",
        authorization: API_KEY,
        payload: {
            pools: [
                {
                    address: PAIR_ADDRESS,
                    blockchain: CHAIN_ID
                }
            ]
        }
    };
    console.log(`📤 sending market-details sub for ${PAIR_ADDRESS} on ${CHAIN_ID}`);
    ws.send(JSON.stringify(marketMsg));

    // Subscribe OHLCV (Pair Mode)
    const ohlcvMsg = {
        type: "ohlcv",
        authorization: API_KEY,
        payload: {
            address: PAIR_ADDRESS,
            chainId: CHAIN_ID,
            period: "1m"
        }
    };
    console.log(`📤 sending ohlcv sub`);
    ws.send(JSON.stringify(ohlcvMsg));
});

ws.on('message', (data) => {
    try {
        const msg = JSON.parse(data);
        const now = Date.now();
        console.log(`\n📩 Received Message at ${new Date(now).toISOString()}:`);

        // Log simplified structure
        if (msg.data) {
            console.log("Type:", msg.type || "Unknown");
            console.log("Data:", JSON.stringify(msg.data, null, 2));

            if (msg.data.timestamp || msg.data.date) {
                const eventTime = (msg.data.timestamp || msg.data.date) * (msg.data.timestamp < 10000000000 ? 1000 : 1);
                console.log(`⏱ Latency: ${now - eventTime}ms`);
            }
        } else {
            console.log("Raw:", msg);
        }

    } catch (err) {
        console.error("❌ Parse Error:", err.message);
    }
});

ws.on('error', (err) => {
    console.error("❌ WebSocket Error:", err.message);
});

ws.on('close', () => {
    console.log("⚠️ WebSocket Connection Closed");
});
