import React, { useEffect, useState, useRef } from 'react';
import { Zap } from 'lucide-react';
import Dashboard from './components/Dashboard';

function App() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);

  const [marketState, setMarketState] = useState({
    goldrush: { ticks: {}, trades: [] },
    codex: { ticks: {}, trades: [] },
    ticks: {},
    trades: [],
    ideas: []
  });

  const connectWebSocket = () => {
    // Use environment variable for deployment, fallback to localhost for dev
    const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3002';
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log(`Connected to backend at ${WS_URL}`);
      setConnected(true);
      setSocket(ws);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    };

    ws.onclose = () => setConnected(false);

    // Return cleanup
    return () => ws.close();
  };

  useEffect(() => {
    const cleanup = connectWebSocket();
    return cleanup;
  }, []);

  const handleMessage = (msg) => {
    // Log incoming messages for debugging
    if (msg.type === 'TICK') {
      console.log('📉 TICK RECEIVED:', msg.data);
    } else {
      console.log('📩 WS MESSAGE:', msg);
    }

    switch (msg.type) {
      case 'INIT':
        // Initialize if backend sends data
        const initPairs = msg.data.pairs || {};
        const firstPair = Object.keys(initPairs)[0];
        const initialData = firstPair ? initPairs[firstPair] : null;

        setMarketState(prev => ({
          ...prev,
          ticks: initPairs,
          trades: msg.data.trades,
          ideas: msg.data.ideas,
          // Populate Split View immediately
          goldrush: {
            ...prev.goldrush,
            ticks: initialData ? { [firstPair]: { pair: firstPair, price: initialData.fastPrice || initialData.price, timestamp: Date.now() } } : prev.goldrush.ticks
          },
          codex: {
            ...prev.codex,
            ticks: initialData ? { [firstPair]: { pair: firstPair, price: initialData.slowPrice || initialData.price, latency: 'Init', timestamp: Date.now() } } : prev.codex.ticks
          }
        }));
        break;

      case 'FAST_TICK':
        setMarketState(prev => ({
          ...prev,
          goldrush: {
            ...prev.goldrush,
            ticks: {
              ...prev.goldrush.ticks,
              [msg.data.pair]: msg.data
            }
          }
        }));
        break;

      case 'SLOW_TICK':
        setMarketState(prev => ({
          ...prev,
          codex: {
            ...prev.codex,
            ticks: {
              ...prev.codex.ticks,
              [msg.data.pair]: msg.data
            }
          }
        }));
        break;

      case 'FAST_TRADE':
        setMarketState(prev => ({
          ...prev,
          goldrush: {
            ...prev.goldrush,
            trades: [msg.data, ...prev.goldrush.trades].slice(0, 50)
          }
        }));
        break;

      case 'SLOW_TRADE':
        setMarketState(prev => ({
          ...prev,
          codex: {
            ...prev.codex,
            trades: [msg.data, ...prev.codex.trades].slice(0, 50)
          }
        }));
        break;

      case 'TICK': // Legacy fallback
        setMarketState(prev => ({
          ...prev,
          ticks: {
            ...prev.ticks,
            [msg.data.pair]: { price: msg.data.price, timestamp: msg.data.timestamp }
          }
        }));
        break;
      case 'IDEA':
        setMarketState(prev => ({
          ...prev,
          ideas: [msg.data, ...prev.ideas]
        }));
        break;
      case 'TRADE_OPEN':
        setMarketState(prev => ({
          ...prev,
          trades: [msg.data, ...prev.trades]
        }));
        break;
      case 'TRADE_CLOSE':
        setMarketState(prev => ({
          ...prev,
          trades: prev.trades.map(t => t.id === msg.data.id ? msg.data : t)
        }));
        break;
      default:
        break;
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      {/* Header */}
      <header className="border-b border-white/5 bg-black/20 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 p-2 rounded-lg">
              <Zap className="w-5 h-5 text-primary" />
            </div>
            <h1 className="font-bold text-xl tracking-tight">
              Rush <span className="text-muted-foreground">&</span> Codex
              <span className="ml-3 text-xs font-mono bg-white/5 px-2 py-1 rounded text-primary">TP SIMULATOR</span>
            </h1>
          </div>

          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${connected ? 'bg-green-500/10 border-green-500/20 text-green-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
              <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'} animate-pulse`} />
              {connected ? 'SYSTEM ONLINE' : 'DISCONNECTED'}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-[1600px] mx-auto p-6">
        <Dashboard state={marketState} />
      </main>
    </div>
  );
}

export default App;
