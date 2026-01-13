#!/bin/bash
# Simulate switching to BONK on Solana
curl -X POST http://localhost:3002/update-token \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BONK",
    "address": "HeLp6NuQkmYB4pYWo2zYs22mESHXPQJh5KX2XRwQwYv7",
    "pairAddress": "6oFWm7KPLfxnwMb3z5xwBoXNSPP3JJyirAPqPSiVcnsp"
  }'
