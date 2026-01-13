const { createClient } = require('graphql-ws');
const WebSocket = require('ws');
require('dotenv').config();

// CONFIG
const GOLDRUSH_CHAIN = 'SOLANA_MAINNET';
const SOLANA_PAIR = '8PhnCfgq17utwucfb95tr5d60AH7NMBnS1TryTRSipHc'; // BONK/SOL Pair
const SOLANA_TOKEN = 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQJh5KX2XRwQwYv7'; // BONK Token
const CODEX_NETWORK = '1399811149';

console.log('--- STARTING SIDE-BY-SIDE CHECK (SOLANA) ---');

// 1. GOLDRUSH STREAM
const grClient = createClient({
    url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
    webSocketImpl: WebSocket,
    connectionParams: { GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY }
});

const grQuery = `subscription {
    updatePairs(
        chain_name: ${GOLDRUSH_CHAIN}
        pair_addresses: ["${SOLANA_PAIR}"]
    ) {
        timestamp
        quote_rate_usd
    }
}`;

grClient.subscribe({ query: grQuery }, {
    next: (data) => console.log(`[GoldRush] Data:`, JSON.stringify(data)),
    error: (err) => console.error(`[GoldRush] Error:`, err),
});

// 2. CODEX STREAM (Events)
const cxClient = createClient({
    url: 'wss://graph.codex.io/graphql',
    webSocketImpl: WebSocket,
    connectionParams: { Authorization: process.env.CODEX_API_KEY }
});

// Use Token Address
const cxQueryToken = `subscription {
    onEventsCreated(
        networkId: ${CODEX_NETWORK}
        address: "${SOLANA_TOKEN}"
    ) {
        events { timestamp }
    }
}`;

console.log('Subscribing to Codex (Token Address)...');
cxClient.subscribe({ query: cxQueryToken }, {
    next: (data) => console.log(`[Codex-Token] Data:`, JSON.stringify(data)),
    error: (err) => console.error(`[Codex-Token] Error:`, err),
});

// Use Pair Address
const cxQueryPair = `subscription {
    onEventsCreated(
        networkId: ${CODEX_NETWORK}
        address: "${SOLANA_PAIR}"
    ) {
        events { timestamp }
    }
}`;

console.log('Subscribing to Codex (Pair Address)...');
cxClient.subscribe({ query: cxQueryPair }, {
    next: (data) => console.log(`[Codex-Pair] Data:`, JSON.stringify(data)),
    error: (err) => console.error(`[Codex-Pair] Error:`, err),
});
