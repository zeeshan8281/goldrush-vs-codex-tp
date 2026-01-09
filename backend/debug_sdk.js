const { GoldRushClient } = require('@covalenthq/client-sdk');
require('dotenv').config();

const client = new GoldRushClient(
    process.env.COVALENT_API_KEY || 'test'
);

const service = client.StreamingService;

console.log('Own Properties:', Object.keys(service));
console.log('Prototype Properties:', Object.getOwnPropertyNames(Object.getPrototypeOf(service)));
