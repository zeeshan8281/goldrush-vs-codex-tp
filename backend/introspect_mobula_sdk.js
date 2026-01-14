
const { MobulaClient } = require('@mobula_labs/sdk');

try {
    const instance = new MobulaClient("test");
    console.log("Streams:", instance.streams);
    console.log("Streams Proto:", Object.getOwnPropertyNames(Object.getPrototypeOf(instance.streams)));
} catch (e) {
    console.log("Error:", e.message);
}
