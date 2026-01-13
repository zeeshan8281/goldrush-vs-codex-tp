/**
 * Test script to check if GoldRush ohlcvCandlesForPair sends historical data on first connect
 */
const WebSocket = require('ws');
const { createClient } = require('graphql-ws');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PAIR_ADDRESS = '0x9c087Eb773291e50CF6c6a90ef0F4500e349B903';
const CHAIN = 'BASE_MAINNET';

async function testGoldRushOHLCV() {
    console.log('🧪 Testing GoldRush ohlcvCandlesForPair - checking for historical data...\n');

    const startTime = Date.now();
    let messageCount = 0;
    let allTimestamps = [];
    let firstMessageCandleCount = 0;

    const client = createClient({
        url: 'wss://gr-staging-v2.streaming.covalenthq.com/graphql',
        webSocketImpl: WebSocket,
        connectionParams: {
            GOLDRUSH_API_KEY: process.env.COVALENT_API_KEY
        },
        on: {
            connected: () => console.log(`✅ Connected in ${Date.now() - startTime}ms`),
            error: (err) => console.error('❌ Error:', err)
        }
    });

    const query = `
        subscription {
            ohlcvCandlesForPair(
                chain_name: ${CHAIN}
                pair_addresses: ["${PAIR_ADDRESS}"]
                interval: ONE_MINUTE
                timeframe: ONE_HOUR
            ) {
                timestamp
                open
                high
                low
                close
                volume
            }
        }
    `;

    console.log(`📊 Subscribing to pair: ${PAIR_ADDRESS}`);
    console.log(`📊 Timeframe: ONE_HOUR, Interval: ONE_MINUTE`);
    console.log('⏳ Waiting for first 3 messages to analyze...\n');

    client.subscribe(
        { query },
        {
            next: (result) => {
                messageCount++;
                const candles = result?.data?.ohlcvCandlesForPair;
                const candleCount = candles?.length || 0;

                if (messageCount === 1) {
                    firstMessageCandleCount = candleCount;
                }

                console.log(`📦 Message #${messageCount}:`);
                console.log(`   Time since connect: ${Date.now() - startTime}ms`);
                console.log(`   Candles in this message: ${candleCount}`);

                if (candles && candles.length > 0) {
                    // Collect all timestamps from this message
                    candles.forEach(c => {
                        if (c.timestamp) allTimestamps.push(c.timestamp);
                    });

                    // Show first and last candle timestamps
                    const firstTs = candles[0]?.timestamp;
                    const lastTs = candles[candles.length - 1]?.timestamp;
                    console.log(`   First candle: ${firstTs} (${new Date(firstTs).toLocaleTimeString()})`);
                    console.log(`   Last candle:  ${lastTs} (${new Date(lastTs).toLocaleTimeString()})`);

                    // Calculate time span of candles in this message
                    if (candleCount > 1) {
                        const spanMinutes = (new Date(lastTs) - new Date(firstTs)) / (1000 * 60);
                        console.log(`   Time span: ${spanMinutes.toFixed(0)} minutes`);
                    }
                }

                if (messageCount >= 3) {
                    console.log('\n' + '='.repeat(60));
                    console.log('📊 ANALYSIS:');
                    console.log('='.repeat(60));

                    console.log(`First message had: ${firstMessageCandleCount} candles`);
                    console.log(`Total messages received: ${messageCount}`);
                    console.log(`Total unique timestamps: ${[...new Set(allTimestamps)].length}`);

                    if (firstMessageCandleCount > 1) {
                        console.log('\n✅ RESULT: GoldRush sends MULTIPLE candles in first message!');
                        console.log('   This is TRUE ring buffer (historical data on connect)!');
                    } else {
                        console.log('\n⚠️ RESULT: GoldRush sends only 1 candle per message');
                        console.log('   This is LIVE-ONLY (no historical buffer)');
                    }

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

testGoldRushOHLCV();
