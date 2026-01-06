const { GoldRushClient, StreamingInterval, StreamingChain } = require('@covalenthq/client-sdk');

console.log("--- StreamingInterval Options ---");
console.log(Object.keys(StreamingInterval));
console.log("\n--- StreamingInterval Values ---");
console.log(StreamingInterval);

const client = new GoldRushClient(process.env.COVALENT_API_KEY);
console.log("\n--- GoldRushClient.StreamingService Methods ---");
// Inspect prototype or instance
if (client.StreamingService) {
    console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(client.StreamingService)));
} else {
    console.log("StreamingService not found on client instance");
}
