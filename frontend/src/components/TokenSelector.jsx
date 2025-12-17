import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';

const TokenSelector = () => {
    const [address, setAddress] = useState('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'); // Default BONK
    const [loading, setLoading] = useState(false);

    // Use environment variable for backend URL, fallback to localhost
    const API_URL = import.meta.env.VITE_WS_URL ? import.meta.env.VITE_WS_URL.replace('ws://', 'http://').replace('wss://', 'https://') : 'http://localhost:3002';

    const handleUpdate = async () => {
        if (!address) return;
        setLoading(true);
        try {
            await fetch(`${API_URL}/update-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, symbol: 'CUSTOM' })
            });
        } catch (err) {
            console.error("Failed to update token:", err);
        }
        setLoading(false);
    };

    return (
        <div className="flex items-center gap-2 bg-white/5 p-1 rounded-lg border border-white/10">
            <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Enter Solana Token Address..."
                className="bg-transparent border-none focus:ring-0 text-xs w-64 text-white font-mono placeholder:text-white/30"
            />
            <button
                onClick={handleUpdate}
                disabled={loading}
                className="bg-primary/20 hover:bg-primary/30 text-primary text-xs px-3 py-1.5 rounded-md flex items-center gap-2 transition-colors disabled:opacity-50"
            >
                <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                {loading ? 'Switching...' : 'Update Stream'}
            </button>
        </div>
    );
};

export default TokenSelector;
