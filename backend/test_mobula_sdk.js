
const { MobulaClient } = require('@mobula_labs/sdk');
require('dotenv').config();

const API_KEY = process.env.MOBULA_API_KEY;
if (!API_KEY) {
    console.error("Missing API KEY");
    process.exit(1);
}

const PAIR = '0x9c087Eb773291e50CF6c6a90ef0F4500e349B903';
const CHAIN = 'evm:8453';

console.log("Creating MobulaClient...");
const client = new MobulaClient(API_KEY);

// Listen to stream events
// Assuming 'market-details' emits events?
client.streams.on('market-details', (data) => {
    console.log("Event [market-details]:", JSON.stringify(data, null, 2));
});

client.streams.on('trade', (data) => {
    console.log("Event [trade]:", JSON.stringify(data, null, 2));
});

client.streams.on('message', (data) => {
    console.log("Event [message]:", JSON.stringify(data).slice(0, 100));
});

client.streams.on('error', (err) => {
    console.error("Stream Error:", err);
});

async function run() {
    console.log("Waiting for SDK init...");
    await new Promise(r => setTimeout(r, 5000));
    console.log("Subscribing to Market Details...");
    try {
        await client.streams.subscribe({
            type: "market-details",
            payload: {
                pools: [{ address: PAIR, blockchain: CHAIN }]
            }
        });
        console.log("Subscribed Market Details");
    } catch (e) {
        console.error("Sub Error MD:", e);
    }

    console.log("Subscribing to OHLCV...");
    try {
        await client.streams.subscribe({
            type: "ohlcv",
            payload: {
                address: PAIR,
                chainId: CHAIN,
                period: "1m"
            }
        });
        console.log("Subscribed OHLCV");
    } catch (e) {
        console.error("Sub Error OHLCV:", e);
    }
}

run();
