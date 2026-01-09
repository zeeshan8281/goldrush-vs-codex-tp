// Test updatePairs subscription in isolation
const WebSocket = require('ws');
const { createClient } = require('graphql-ws');
require('dotenv').config();

const PAIR_ADDRESS = '0x9c087eb773291e50cf6c6a90ef0f4500e349b903'; // lowercase

console.log('🔗 Connecting to GoldRush updatePairs stream...');
console.log('API Key:', process.env.COVALENT_API_KEY?.substring(0, 10) + '...');

const client = createClient({
    url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
    webSocketImpl: WebSocket,
    connectionParams: {
        GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
    },
    on: {
        connected: () => console.log('✅ WebSocket Connected!'),
        error: (err) => console.error('❌ WS Error:', err),
        closed: () => console.log('📴 WS Closed')
    }
});

const query = `subscription {
    updatePairs(
        chain_name: BASE_MAINNET
        pair_addresses: ["${PAIR_ADDRESS}"]
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

console.log('\n📤 Subscribing with query:\n', query);

client.subscribe({ query }, {
    next: (result) => {
        console.log('\n📊 updatePairs Event:', JSON.stringify(result, null, 2));
    },
    error: (err) => {
        console.error('❌ Subscription Error:', err);
    },
    complete: () => {
        console.log('✅ Subscription Complete');
    }
});

// Keep running for 60 seconds
console.log('\n⏳ Waiting for events (60 seconds)...\n');
setTimeout(() => {
    console.log('\n⏰ Timeout - closing connection');
    client.dispose();
    process.exit(0);
}, 60000);
