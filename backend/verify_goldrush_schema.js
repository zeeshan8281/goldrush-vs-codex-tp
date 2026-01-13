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

const query = `
  query {
    __type(name: "ChainName") {
      name
      enumValues {
        name
      }
    }
  }
`;

// There is no specific "query" method in graphql-ws, usually we subscribe.
// But we can try a subscription that returns the schema immediately or use 'subscribe' with sink.
// Actually, graphql-ws is for subscriptions. Introspection usually requires HTTP.
// BUT Covalent GoldRush might support introspection via WS query?
// Let's try sending it as a subscription (some servers handle queries over WS).

client.subscribe(
    { query },
    {
        next: (data) => {
            console.log('Schema Data:', JSON.stringify(data, null, 2));
            process.exit(0);
        },
        error: (err) => {
            console.error('Introspection Error:', err);
            process.exit(1);
        },
        complete: () => {
            console.log('Complete');
            process.exit(0);
        },
    },
);
