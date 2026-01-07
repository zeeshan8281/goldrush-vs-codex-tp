import React, { useEffect, useState, useRef } from 'react';
import { Zap, BarChart3 } from 'lucide-react';
import Dashboard from './components/Dashboard';
import StatsPage from './components/StatsPage';
import TokenSelector from './components/TokenSelector';

function App() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [currentTimeframe, setCurrentTimeframe] = useState('1m');
  const [switchingTimeframe, setSwitchingTimeframe] = useState(false);
  const [currentChain, setCurrentChain] = useState('Solana'); // Track current chain

  const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002';

  const [marketState, setMarketState] = useState({
    goldrush: { ticks: {}, trades: [], logs: [] },
    codex: { ticks: {}, trades: [], logs: [] },
    gecko: { ticks: {}, trades: [], logs: [] },
    ticks: {},
    trades: [],
    ideas: []
  });

  // Derive current symbol from ticks (first key) or fallback to 'BONK'
  const currentSymbol = Object.keys(marketState.ticks)[0] || 'BONK';

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
    fetchTimeframe();
    return cleanup;
  }, []);

  const fetchTimeframe = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/timeframe`);
      const data = await res.json();
      setCurrentTimeframe(data.current);
    } catch (err) {
      console.error('Failed to fetch timeframe:', err);
    }
  };

  const switchTimeframe = async (tf) => {
    if (tf === currentTimeframe || switchingTimeframe) return;
    setSwitchingTimeframe(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/timeframe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeframe: tf })
      });
      if (res.ok) setCurrentTimeframe(tf);
    } catch (err) {
      console.error('Failed to switch timeframe:', err);
    } finally {
      setSwitchingTimeframe(false);
    }
  };

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
          },
          gecko: {
            ...prev.gecko,
            ticks: initialData ? { [firstPair]: { pair: firstPair, price: initialData.geckoPrice || initialData.price, latency: 'Init', timestamp: Date.now() } } : prev.gecko.ticks
          }
        }));
        break;

      case 'FAST_TICK':
        setMarketState(prev => {
          const newLog = {
            time: new Date().toLocaleTimeString(),
            type: 'TICK',
            message: `$${msg.data.price?.toFixed(6)} | ${msg.data.candles?.length || 0} candles | ${msg.data.latency}ms`
          };
          return {
            ...prev,
            goldrush: {
              ...prev.goldrush,
              ticks: {
                ...prev.goldrush.ticks,
                [msg.data.pair]: msg.data
              },
              logs: [...prev.goldrush.logs, newLog].slice(-50)
            }
          };
        });
        break;

      case 'SLOW_TICK':
        setMarketState(prev => {
          const newLog = {
            time: new Date().toLocaleTimeString(),
            type: 'TICK',
            message: `$${msg.data.price?.toFixed(6)} | ${msg.data.candles?.length || 0} candles | ${msg.data.latency}ms`
          };
          return {
            ...prev,
            codex: {
              ...prev.codex,
              ticks: {
                ...prev.codex.ticks,
                [msg.data.pair]: msg.data
              },
              logs: [...prev.codex.logs, newLog].slice(-50)
            }
          };
        });
        break;

      case 'FAST_TRADE':
        setMarketState(prev => {
          const newLog = {
            time: new Date().toLocaleTimeString(),
            type: 'TRADE',
            message: `${msg.data.side} | Entry $${msg.data.entryPrice?.toFixed(8)} → Exit $${msg.data.exitPrice?.toFixed(8)} | PnL ${msg.data.pnl >= 0 ? '+' : ''}$${msg.data.pnl?.toFixed(2)}`
          };
          return {
            ...prev,
            goldrush: {
              ...prev.goldrush,
              trades: [msg.data, ...prev.goldrush.trades].slice(0, 50),
              logs: [...prev.goldrush.logs, newLog].slice(-50)
            }
          };
        });
        break;

      case 'SLOW_TRADE':
        setMarketState(prev => {
          const newLog = {
            time: new Date().toLocaleTimeString(),
            type: 'TRADE',
            message: `${msg.data.side} | Entry $${msg.data.entryPrice?.toFixed(8)} → Exit $${msg.data.exitPrice?.toFixed(8)} | PnL ${msg.data.pnl >= 0 ? '+' : ''}$${msg.data.pnl?.toFixed(2)}`
          };
          return {
            ...prev,
            codex: {
              ...prev.codex,
              trades: [msg.data, ...prev.codex.trades].slice(0, 50),
              logs: [...prev.codex.logs, newLog].slice(-50)
            }
          };
        });
        break;

      case 'GECKO_TICK':
        setMarketState(prev => {
          const newLog = {
            time: new Date().toLocaleTimeString(),
            type: 'TICK',
            message: `$${msg.data.price?.toFixed(6)} | ${msg.data.candles?.length || 0} candles | ${msg.data.latency}ms`
          };
          return {
            ...prev,
            gecko: {
              ...prev.gecko,
              ticks: {
                ...prev.gecko.ticks,
                [msg.data.pair]: msg.data
              },
              logs: [...prev.gecko.logs, newLog].slice(-50)
            }
          };
        });
        break;

      case 'GECKO_TRADE':
        setMarketState(prev => {
          const newLog = {
            time: new Date().toLocaleTimeString(),
            type: 'TRADE',
            message: `${msg.data.side} | Entry $${msg.data.entryPrice?.toFixed(8)} → Exit $${msg.data.exitPrice?.toFixed(8)} | PnL ${msg.data.pnl >= 0 ? '+' : ''}$${msg.data.pnl?.toFixed(2)}`
          };
          return {
            ...prev,
            gecko: {
              ...prev.gecko,
              trades: [msg.data, ...prev.gecko.trades].slice(0, 50),
              logs: [...prev.gecko.logs, newLog].slice(-50)
            }
          };
        });
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
      case 'RESET':
        // Clear everything on reset
        setMarketState({
          goldrush: { ticks: {}, trades: [], logs: [] },
          codex: { ticks: {}, trades: [], logs: [] },
          gecko: { ticks: {}, trades: [], logs: [] },
          ticks: {},
          trades: [],
          ideas: []
        });
        console.log("♻️ State Reset for new token:", msg.data.pair);
        // Update chain based on RESET data
        if (msg.data.chain) {
          setCurrentChain(msg.data.chain === 'BASE' ? 'Base' : 'Solana');
        }
        break;
      case 'SYMBOL_UPDATE':
        console.log("🔀 Symbol Updated:", msg.data.symbol);
        // We rely on derived state "currentSymbol" which looks at marketState.ticks keys.
        // But for immediate UI feedback without waiting for a tick:
        setMarketState(prev => {
          // Rename the key in ticks if it exists
          const oldSymbol = Object.keys(prev.ticks)[0];
          const newTicks = { ...prev.ticks };
          if (oldSymbol && oldSymbol !== msg.data.symbol) {
            newTicks[msg.data.symbol] = newTicks[oldSymbol];
            delete newTicks[oldSymbol];
          }
          return {
            ...prev,
            ticks: newTicks
          };
        });
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
              GoldRush <span className="text-muted-foreground">&</span> Codex
              <span className="ml-3 text-xs font-mono bg-white/5 px-2 py-1 rounded text-primary">TP SIMULATOR</span>
              <span className="ml-2 text-xs font-mono bg-purple-500/20 px-2 py-1 rounded text-purple-400 border border-purple-500/30">{currentSymbol} ({currentChain})</span>
            </h1>
            <TokenSelector />
            <div className="flex items-center gap-1 ml-4 bg-white/5 rounded-lg p-1 border border-white/10">
              {['1m', '5m', '15m'].map(tf => (
                <button
                  key={tf}
                  onClick={() => switchTimeframe(tf)}
                  disabled={switchingTimeframe}
                  className={`px-3 py-1 rounded text-xs font-bold transition-all ${currentTimeframe === tf
                    ? 'bg-primary text-white'
                    : 'text-muted-foreground hover:bg-white/10'
                    } ${switchingTimeframe ? 'opacity-50' : ''}`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowStats(!showStats)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${showStats ? 'bg-primary/20 border-primary/30 text-primary' : 'bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10'}`}
            >
              <BarChart3 size={14} />
              {showStats ? 'Dashboard' : 'Stats'}
            </button>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${connected ? 'bg-green-500/10 border-green-500/20 text-green-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
              <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'} animate-pulse`} />
              {connected ? 'SYSTEM ONLINE' : 'DISCONNECTED'}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-[1600px] mx-auto p-6">
        {showStats ? (
          <StatsPage onBack={() => setShowStats(false)} />
        ) : (
          <Dashboard state={marketState} />
        )}
      </main>
    </div>
  );
}

export default App;
