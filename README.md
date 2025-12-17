# GoldRush vs Codex Trading Paper Simulator

A real-time trading paper simulator that compares **GoldRush Streaming API** against **Codex Polling API** for the BONK token on Solana.

![Dashboard Preview](https://img.shields.io/badge/Status-Live-green) ![Node.js](https://img.shields.io/badge/Node.js-18+-blue) ![React](https://img.shields.io/badge/React-19-blue)

## 🎯 What This Does

This proof-of-concept runs **identical trading algorithms** on two different data sources to compare: GoldRush and Codex

Both APIs feed into the **same momentum-based paper trading strategy**, allowing you to compare PnL outcomes based on data delivery speed and reliability.

## 📊 Features

- **Side-by-side candlestick charts** (lightweight-charts)
- **Independent paper trading** for each API
- **Real-time execution logs**
- **Cumulative PnL tracking**
- **Terminal log boxes** showing live data flow

## 🏗️ Architecture

```
┌─────────────────┐     ┌─────────────────┐
│  GoldRush SDK   │     │   Codex API     │
│   (WebSocket)   │     │   (Polling)     │
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       ▼
┌────────────────────────────────────────┐
│           Node.js Backend              │
│  - Independent trading logic           │
│  - Candle accumulation                 │
│  - WebSocket broadcast                 │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│         React Frontend (Vite)          │
│  - Charts  │  Trades  │  Terminal      │
└────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- GoldRush API Key ([Get one here](https://goldrush.dev))
- Codex API Key ([Get one here](https://codex.io))

### 1. Clone & Install

```bash
git clone https://github.com/zeeshan8281/goldrush-vs-codex-tp.git
cd goldrush-vs-codex-tp

# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Configure Environment

Create `backend/.env`:
```env
COVALENT_API_KEY=your_goldrush_api_key
CODEX_API_KEY=your_codex_api_key
```

### 3. Run Locally

```bash
# Terminal 1 - Backend
cd backend && node index.js

# Terminal 2 - Frontend
cd frontend && npm run dev
```

Open http://localhost:5173

## 📈 Trading Algorithm

Both APIs use identical **momentum-based strategy**:

```javascript
THRESHOLD = 0.01%  // Price change to trigger

// Entry
if (priceChange > +0.01%) → Open LONG
if (priceChange < -0.01%) → Open SHORT

// Exit
if (opposite signal OR held > 10 seconds) → Close position

// PnL
LONG:  (exitPrice - entryPrice) × 10000
SHORT: (entryPrice - exitPrice) × 10000
```

## 🌐 Deployment

### Backend (Render)
1. Create Web Service → Root Directory: `backend`
2. Build: `npm install` | Start: `npm start`
3. Add env vars: `COVALENT_API_KEY`, `CODEX_API_KEY`

### Frontend (Vercel)
1. Import repo → Root Directory: `frontend`
2. Framework: Vite
3. Add env var: `VITE_WS_URL=wss://your-backend.onrender.com`

## 📁 Project Structure

```
├── backend/
│   ├── index.js          # Main server, trading logic
│   ├── package.json
│   └── .env              # API keys (not committed)
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx       # WebSocket client, state
│   │   └── components/
│   │       ├── Dashboard.jsx    # Main layout
│   │       ├── Chart.jsx        # Candlestick chart
│   │       ├── TradeList.jsx    # Execution table
│   │       └── TerminalLog.jsx  # Live data log
│   └── package.json
```

## 🔧 Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `COVALENT_API_KEY` | GoldRush API key | Required |
| `CODEX_API_KEY` | Codex API key | Required |
| `PORT` | Backend port | 3002 |
| `VITE_WS_URL` | WebSocket URL | ws://localhost:3002 |

## 📊 Token Tracked

| Property | Value |
|----------|-------|
| Symbol | BONK |
| Address | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` |
| Chain | Solana Mainnet |
| Interval | 1 Minute |

## 🤝 Contributing

1. Fork the repo
2. Create feature branch
3. Commit changes
4. Push and open PR

## 📝 License

MIT

---

Built with ❤️ using [GoldRush SDK](https://goldrush.dev) and [Codex](https://codex.io)
