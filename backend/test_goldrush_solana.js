const { createClient } = require('graphql-ws');
const WebSocket = require('ws');
require('dotenv').config();

const client = createClient({
    url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
    webSocketImpl: WebSocket,
    connectionParams: {
        GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
    }
});

const PAIR_ADDRESS = "6oFWm7KPLfxnwMb3z5xwBoXNSPP3JJyirAPqPSiVcnsp"; // User provided pair

console.log('Testing GoldRush Solana Stream for Pair:', PAIR_ADDRESS);

// Test updatePairs
const updateQuery = `subscription {
    updatePairs(
        chain_name: SOLANA_MAINNET
        pair_addresses: ["${PAIR_ADDRESS}"]
    ) {
        chain_name
        pair_address
        timestamp
        quote_rate
        quote_rate_usd
    }
}`;

// Test OHLCV
const ohlcvQuery = `subscription {
    ohlcvCandlesForPair(
        chain_name: SOLANA_MAINNET
        pair_addresses: ["${PAIR_ADDRESS}"]
        interval: ONE_MINUTE
        timeframe: ONE_HOUR
    ) {
        timestamp
        close
    }
}`;

client.subscribe({ query: updateQuery }, {
    next: (data) => console.log('UpdatePairs Data:', JSON.stringify(data)),
    error: (err) => console.error('UpdatePairs Error:', err),
});

client.subscribe({ query: ohlcvQuery }, {
    next: (data) => console.log('OHLCV Data:', JSON.stringify(data)),
    error: (err) => console.error('OHLCV Error:', err),
});
