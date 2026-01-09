import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';

const TokenSelector = ({ onChainChange }) => {
    const [address, setAddress] = useState('0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b'); // Default VIRTUALS (Base)
    const [chain, setChain] = useState('BASE');
    const [loading, setLoading] = useState(false);

    // Use environment variable for backend URL, fallback to localhost
    const API_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002';

    const handleUpdate = async () => {
        if (!address) return;
        setLoading(true);
        try {
            const symbol = address.startsWith('0x') ? 'VIRTUALS' : 'BONK';
            const res = await fetch(`${API_URL}/update-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, symbol })
            });
            const data = await res.json();
            if (data.success && data.chain) {
                setChain(data.chain);
                // Notify parent component about chain change
                if (onChainChange) {
                    onChainChange(data.chain);
                }
            }
        } catch (err) {
            console.error("Failed to update token:", err);
        }
        setLoading(false);
    };

    return (
        <div className="flex items-center gap-2 bg-white/5 p-1 rounded-lg border border-white/10">
            <select
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="bg-transparent border-none focus:ring-0 text-xs w-48 text-white font-mono cursor-pointer outline-none option:bg-black"
                style={{ appearance: 'none' }}
            >
                <option value="DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263">BONK (Solana)</option>
                <option value="0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b">VIRTUALS (Base)</option>
            </select>

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
