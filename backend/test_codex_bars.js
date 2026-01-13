/**
 * Test script to check if Codex onBarsUpdated sends historical data on first connect
 */
const WebSocket = require('ws');
const { createClient } = require('graphql-ws');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PAIR_ADDRESS = '0x9c087Eb773291e50CF6c6a90ef0F4500e349B903';
const CODEX_NETWORK_ID = '8453';

async function testCodexBars() {
    console.log('🧪 Testing Codex onBarsUpdated - checking for historical data...\n');

    const startTime = Date.now();
    let messageCount = 0;
    let allTimestamps = [];

    const client = createClient({
        url: 'wss://graph.codex.io/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            Authorization: process.env.CODEX_API_KEY
        },
        on: {
            connected: () => console.log(`✅ Connected in ${Date.now() - startTime}ms`),
            error: (err) => console.error('❌ Error:', err)
        }
    });

    const pairId = `${PAIR_ADDRESS}:${CODEX_NETWORK_ID}`;
    const query = `
        subscription($pairId: String!) {
            onBarsUpdated(pairId: $pairId, quoteToken: token0) {
                pairId
                timestamp
                aggregates {
                    r1 {
                        t
                        usd { o h l c t }
                    }
                }
            }
        }
    `;

    console.log(`📊 Subscribing to pair: ${pairId}`);
    console.log('⏳ Waiting for first 5 messages to analyze...\n');

    client.subscribe(
        { query, variables: { pairId } },
        {
            next: (result) => {
                messageCount++;
                const bar = result?.data?.onBarsUpdated;
                const barTimestamp = bar?.timestamp;
                const barTime = barTimestamp ? new Date(barTimestamp * 1000).toISOString() : 'N/A';

                allTimestamps.push(barTimestamp);

                console.log(`📦 Message #${messageCount}:`);
                console.log(`   Timestamp: ${barTimestamp} (${barTime})`);
                console.log(`   Time since connect: ${Date.now() - startTime}ms`);
                console.log(`   Has aggregates: ${bar?.aggregates ? 'Yes' : 'No'}`);

                if (messageCount >= 5) {
                    console.log('\n' + '='.repeat(60));
                    console.log('📊 ANALYSIS:');
                    console.log('='.repeat(60));

                    // Check if first messages have different timestamps (historical)
                    const uniqueTimestamps = [...new Set(allTimestamps)];
                    console.log(`Total messages: ${messageCount}`);
                    console.log(`Unique timestamps: ${uniqueTimestamps.length}`);

                    if (uniqueTimestamps.length > 1) {
                        console.log('\n✅ RESULT: Codex sends MULTIPLE timestamps on connect');
                        console.log('   This suggests historical buffer (ring buffer) behavior!');
                    } else {
                        console.log('\n⚠️ RESULT: Codex sends SAME timestamp repeatedly');
                        console.log('   This suggests LIVE-ONLY data (no historical buffer)');
                    }

                    console.log('\nTimestamps received:');
                    allTimestamps.forEach((ts, i) => {
                        console.log(`   ${i + 1}. ${ts} -> ${new Date(ts * 1000).toLocaleTimeString()}`);
                    });

                    client.dispose();
                    process.exit(0);
                }
            },
            error: (err) => {
                console.error('❌ Subscription Error:', err);
                process.exit(1);
            }
        }
    );

    // Timeout after 60 seconds
    setTimeout(() => {
        console.log('\n⏰ Timeout reached. Messages received:', messageCount);
        client.dispose();
        process.exit(0);
    }, 60000);
}

testCodexBars();
