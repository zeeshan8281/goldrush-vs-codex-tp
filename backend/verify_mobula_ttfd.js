require('dotenv').config();
const WebSocket = require('ws');

// Configuration
const PAIR_ADDRESS = '0x9c087Eb773291e50CF6c6a90ef0F4500e349B903'; // WETH/USDC (Base)
const CHAIN = 'evm:8453'; // Base
const URL = 'wss://api.mobula.io';

console.log("🛠️  Mobula TTFD Verification Script (Market Details)");
console.log(`🎯 Target: ${PAIR_ADDRESS} on ${CHAIN}`);
console.log("----------------------------------------");

const ws = new WebSocket(URL);
let connectTime = 0;
let ttfd = 0;

ws.on('open', () => {
    connectTime = Date.now();
    console.log(`[${new Date().toISOString()}] ✅ WebSocket Connected. Timer Started.`);

    // Subscribe to Market Details (Trades) - Matches index.js logic
    const payload = {
        type: "market-details",
        authorization: process.env.MOBULA_API_KEY,
        payload: {
            pools: [
                {
                    address: PAIR_ADDRESS,
                    blockchain: CHAIN
                }
            ],
            subscriptionTracking: true
        }
    };

    console.log("📤 Sending Subscription:", JSON.stringify(payload));
    ws.send(JSON.stringify(payload));
});

ws.on('message', (data) => {
    const now = Date.now();
    try {
        const msg = JSON.parse(data.toString());

        // Log all messages to see structure
        // console.log("Msg Type:", msg.type);

        // Check for Trade Data (or Snapshot)
        // Adjust condition based on actual 'market-details' response
        if (msg.data) {
            if (ttfd === 0) {
                ttfd = now - connectTime;
                console.log(`[${new Date().toISOString()}] ⚡️ First Data Received!`);
                console.log("----------------------------------------");
                console.log(`⏱️  TTFD (Time to First Data): ${ttfd} ms`);
                console.log("----------------------------------------");

                const output = JSON.stringify(msg, null, 2);
                console.log("Payload:", output.length > 500 ? output.substring(0, 500) + "...(truncated)" : output);

                process.exit(0);
            }
        }
    } catch (e) {
        console.error("Parse Error:", e);
    }
});

ws.on('error', (err) => {
    console.error("❌ WebSocket Error:", err);
});

ws.on('close', () => {
    console.log("⚠️  WebSocket Closed");
});
