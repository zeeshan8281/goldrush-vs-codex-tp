#!/usr/bin/env python3
"""Analyze trading bot logs and compute performance metrics for GoldRush and Codex.

Usage: python3 analyze_trading_logs.py
"""
import json
import re
import statistics
import sys
from pathlib import Path

LOG_PATH = Path(__file__).parent / "logs.1766156472792.json"

def extract_latency(message: str) -> int:
    m = re.search(r"Latency: (\d+)ms", message)
    return int(m.group(1)) if m else None

def extract_price(message: str) -> float:
    m = re.search(r"@ \$(\d+\.\d+)", message)
    return float(m.group(1)) if m else None

def extract_pnl(message: str) -> float:
    m = re.search(r"PnL \$(\-?\d+\.\d+)", message)
    return float(m.group(1)) if m else None

class BotStats:
    def __init__(self, name: str):
        self.name = name
        self.latencies = []
        self.trades_closed = 0
        self.wins = 0
        self.total_pnl = 0.0
        self.open_trades = []  # track open trades for ghost detection (Codex only)

    def record_latency(self, latency: int):
        if latency is not None:
            self.latencies.append(latency)

    def record_open(self, direction: str, price: float):
        self.open_trades.append({"direction": direction, "price": price})

    def record_close(self, pnl: float):
        self.trades_closed += 1
        self.total_pnl += pnl
        if pnl > 0:
            self.wins += 1
        if self.open_trades:
            self.open_trades.pop()

    def average_latency(self):
        return round(statistics.mean(self.latencies), 2) if self.latencies else None

    def win_rate(self):
        return round((self.wins / self.trades_closed) * 100, 2) if self.trades_closed else None

    def avg_pnl_per_trade(self):
        return round(self.total_pnl / self.trades_closed, 4) if self.trades_closed else None

    def ghost_trades(self):
        return len(self.open_trades)

def main():
    if not LOG_PATH.is_file():
        print(f"Log file not found at {LOG_PATH}")
        sys.exit(1)
    with LOG_PATH.open() as f:
        data = json.load(f)

    bots = {"GoldRush": BotStats("GoldRush"), "Codex": BotStats("Codex")}

    for entry in data:
        msg = entry.get("message", "")
        # Latency streams
        if "GOLDRUSH [STREAM]" in msg:
            bots["GoldRush"].record_latency(extract_latency(msg))
        if "CODEX [STREAM]" in msg:
            bots["Codex"].record_latency(extract_latency(msg))
        # Trade actions
        if "GoldRush OPENED" in msg:
            direction = "LONG" if "LONG" in msg else "SHORT"
            price = extract_price(msg)
            bots["GoldRush"].record_open(direction, price)
        if "GoldRush CLOSED" in msg:
            pnl = extract_pnl(msg)
            if pnl is not None:
                bots["GoldRush"].record_close(pnl)
        if "Codex OPENED" in msg:
            direction = "LONG" if "LONG" in msg else "SHORT"
            price = extract_price(msg)
            bots["Codex"].record_open(direction, price)
        if "Codex CLOSED" in msg:
            pnl = extract_pnl(msg)
            if pnl is not None:
                bots["Codex"].record_close(pnl)

    for name, bot in bots.items():
        print(f"=== {name} ===")
        print(f"Total Trades Executed: {bot.trades_closed}")
        print(f"Win Rate: {bot.win_rate()}%")
        print(f"Average PnL per Trade: {bot.avg_pnl_per_trade()}")
        print(f"Total PnL: {round(bot.total_pnl,4)}")
        if name == "Codex":
            print(f"Ghost Trade Rate (open trades without close): {bot.ghost_trades()}")
        print(f"Average Latency (ms): {bot.average_latency()}")
        print()

if __name__ == "__main__":
    main()
