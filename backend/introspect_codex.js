const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const query = `
  query {
    __type(name: "Subscription") {
      name
      fields {
        name
        description
        args {
          name
          type {
              name
              kind
          }
        }
      }
    }
  }
`;

async function run() {
  try {
    console.log("🔍 Introspecting Subscription Type...");
    const res = await axios.post(
      'https://graph.codex.io/graphql',
      { query },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': process.env.CODEX_API_KEY
        }
      }
    );

    if (res.data.data && res.data.data.__type) {
      console.log(JSON.stringify(res.data.data.__type, null, 2));
    } else {
      console.log("No Subscription type found or empty data.");
      console.log(JSON.stringify(res.data, null, 2));
    }

  } catch (e) {
    console.error("Error:", e.message);
    if (e.response) console.error(e.response.data);
  }
}

run();
