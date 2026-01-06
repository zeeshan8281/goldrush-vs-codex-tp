# Changelog

All notable changes to the "GoldRush vs Codex" Trading Bot POC.

## [2026-01-07]

### 🚀 New Features
- **Multi-Chain Support**: Added automatic detection for **Base** (0x addresses) and **Solana** (Base58 addresses).
- **Dual-Axis Charts**: Replaced single aggregate chart with **3 discrete charts** (GoldRush, Codex, Gecko).
  - **Left Axis**: Cumulative PnL ($)
  - **Right Axis**: Average Latency (ms)
- **Throughput Metrics**: Added real-time **Hertz (Hz)** counters to dashboard cards to visualize data arrival rates (e.g., ~1.0 Hz vs 0.05 Hz).
- **Axis Labels**: Added explicit "PnL ($)" and "Latency (ms)" overlays to charts for clarity.

### ⚡ Performance & Stability
- **Crash Fix**: Resolved critical "Object is disposed" white-screen crash by refactoring `StatsPage.jsx` chart initialization logic.
- **Stream Optimization**: Fixed "0 Hz" / Stalling issue on GoldRush by optimizing history fetch size (reverted generic 1h request to 15m logic).
- **Latency Tracking**: Fixed "N/A" latency display by implementing correct state tracking for `latencyRace` API endpoint.

### 🛠 Improvements
- **History Normalization**: Enforced consistent **15-Minute History** (15 candles of 1m interval) across all three providers for fair comparison.
- **Code Clarity**: Renamed misleading `startCodexPolling` function to `initCodexProvider` to correctly reflect WebSocket usage.
- **Trade Sync**: Verified 100% accuracy between Backend execution logs and Frontend PnL display.

### 🐛 Bug Fixes
- Fixed duplicate variable declarations in `index.js`.
- Fixed generic "Polling" label for Codex (now confirmed WebSocket subscription).
- Fixed missing labels on right Y-axis.
