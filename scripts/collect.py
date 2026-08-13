#!/usr/bin/env python3
"""Generate Solstice JSON and Markdown reports using Python's standard library."""

from __future__ import annotations

import json
import math
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RPC_URL = os.environ.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")


def fetch_json(url: str, payload: Any | None = None) -> tuple[Any, int]:
    started = time.perf_counter()
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        result = json.loads(response.read())
    return result, round((time.perf_counter() - started) * 1000)


def safe_number(value: Any) -> float | int | None:
    return value if isinstance(value, (int, float)) and math.isfinite(value) else None


def change(first: float | None, last: float | None) -> float | None:
    return None if not first or not last else ((last - first) / first) * 100


def zscore(values: list[float]) -> float:
    if len(values) < 3:
        return 0
    latest, history = values[0], values[1:]
    mean = sum(history) / len(history)
    variance = sum((value - mean) ** 2 for value in history) / len(history)
    deviation = math.sqrt(variance)
    return (latest - mean) / deviation if deviation else 0


def collect() -> dict[str, Any]:
    now = int(time.time())
    week_ago = now - 7 * 86400
    rpc_payload = [
        {"jsonrpc": "2.0", "id": 1, "method": "getHealth"},
        {"jsonrpc": "2.0", "id": 2, "method": "getVersion"},
        {"jsonrpc": "2.0", "id": 3, "method": "getSlot"},
        {"jsonrpc": "2.0", "id": 4, "method": "getEpochInfo"},
        {"jsonrpc": "2.0", "id": 5, "method": "getRecentPerformanceSamples", "params": [60]},
        {"jsonrpc": "2.0", "id": 6, "method": "getVoteAccounts"},
        {"jsonrpc": "2.0", "id": 7, "method": "getSupply"},
        {"jsonrpc": "2.0", "id": 8, "method": "getTransactionCount"},
    ]
    jobs = {
        "rpc": ("Solana RPC", RPC_URL, rpc_payload),
        "tvl": ("DefiLlama TVL", "https://api.llama.fi/v2/chains", None),
        "price": ("DefiLlama Price", "https://coins.llama.fi/prices/current/coingecko:solana", None),
        "price_history": ("DefiLlama Price History", f"https://coins.llama.fi/chart/coingecko:solana?start={week_ago}&span=7&period=1d", None),
        "stables": ("DefiLlama Stablecoins", "https://stablecoins.llama.fi/stablecoinchains", None),
        "dex": ("DefiLlama DEX Volume", "https://api.llama.fi/overview/dexs/Solana?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true&dataType=dailyVolume", None),
        "tvl_history": ("DefiLlama TVL History", "https://api.llama.fi/v2/historicalChainTvl/Solana", None),
    }
    results: dict[str, Any] = {}
    sources: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {
            pool.submit(fetch_json, url, payload): (key, label, url)
            for key, (label, url, payload) in jobs.items()
        }
        for future in as_completed(futures):
            key, label, url = futures[future]
            try:
                data, latency = future.result()
                results[key] = data
                sources.append({"id": key, "label": label, "url": url, "status": "live", "latencyMs": latency})
            except Exception as error:  # reports remain useful when one source fails
                sources.append({"id": key, "label": label, "url": url, "status": "degraded", "latencyMs": None, "message": str(error)})

    rpc = {reply["id"]: reply.get("result") for reply in results.get("rpc", [])}
    epoch = rpc.get(4) or {}
    samples = [sample for sample in (rpc.get(5) or []) if sample.get("samplePeriodSecs")]
    sample_tps = [sample["numTransactions"] / sample["samplePeriodSecs"] for sample in samples]
    latest_sample = samples[0] if samples else None
    votes = rpc.get(6) or {}
    current = votes.get("current", [])
    delinquent = votes.get("delinquent", [])
    validator_total = len(current) + len(delinquent)
    delinquent_percent = len(delinquent) / validator_total * 100 if validator_total else None
    slot_time = (latest_sample["samplePeriodSecs"] / latest_sample["numSlots"] * 1000) if latest_sample else None
    chains = results.get("tvl", [])
    solana_chain = next((item for item in chains if item.get("name") == "Solana"), {})
    current_price = results.get("price", {}).get("coins", {}).get("coingecko:solana", {}).get("price")
    price_points = results.get("price_history", {}).get("coins", {}).get("coingecko:solana", {}).get("prices", [])
    stable = next((item for item in results.get("stables", []) if item.get("name") == "Solana"), {})
    stable_supply = stable.get("totalCirculatingUSD", {}).get("peggedUSD")
    dex = results.get("dex", {})
    tvl_history = results.get("tvl_history", [])[-30:]

    alerts: list[dict[str, str]] = []
    if delinquent_percent is not None and delinquent_percent > 2:
        alerts.append({"level": "critical" if delinquent_percent > 5 else "warning", "title": "Validator delinquency elevated", "detail": f"{delinquent_percent:.2f}% of vote accounts are delinquent."})
    if slot_time is not None and slot_time > 600:
        alerts.append({"level": "critical" if slot_time > 800 else "warning", "title": "Slot production is slower than baseline", "detail": f"Latest observed slot time is {slot_time:.0f} ms."})
    tps_z = zscore(sample_tps)
    if abs(tps_z) >= 2:
        alerts.append({"level": "critical" if abs(tps_z) >= 3 else "warning", "title": "Transaction throughput spike" if tps_z > 0 else "Transaction throughput drop", "detail": f"Latest TPS is {abs(tps_z):.1f} standard deviations from its recent mean."})
    degraded_count = sum(source["status"] == "degraded" for source in sources)
    if degraded_count:
        alerts.append({"level": "info", "title": "Partial source degradation", "detail": f"{degraded_count} data source(s) unavailable; healthy sources remain visible."})
    if not alerts:
        alerts.append({"level": "info", "title": "No material anomalies detected", "detail": "Indicators are within their recent operating ranges."})

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "network": {
            "health": rpc.get(1),
            "version": (rpc.get(2) or {}).get("solana-core"),
            "slot": safe_number(rpc.get(3)),
            "epoch": epoch.get("epoch"),
            "epochProgress": epoch.get("slotIndex", 0) / epoch.get("slotsInEpoch", 1) * 100 if epoch else None,
            "tps": sample_tps[0] if sample_tps else None,
            "nonVoteTps": latest_sample["numNonVoteTransactions"] / latest_sample["samplePeriodSecs"] if latest_sample else None,
            "averageTps": sum(sample_tps) / len(sample_tps) if sample_tps else None,
            "slotTimeMs": slot_time,
            "transactionCount": safe_number(rpc.get(8)),
            "circulatingSupply": (rpc.get(7) or {}).get("value", {}).get("circulating", 0) / 1_000_000_000 if rpc.get(7) else None,
        },
        "validators": {
            "active": len(current) or None,
            "delinquent": len(delinquent) or None,
            "delinquentPercent": delinquent_percent,
            "activeStakeSol": sum(item.get("activatedStake", 0) for item in current) / 1_000_000_000 if current else None,
        },
        "economics": {
            "solPrice": current_price,
            "priceChange7d": change(price_points[0].get("price") if price_points else None, price_points[-1].get("price") if price_points else None),
            "tvl": solana_chain.get("tvl"),
            "tvlChange7d": change(tvl_history[-8].get("tvl") if len(tvl_history) >= 8 else None, tvl_history[-1].get("tvl") if tvl_history else None),
            "stablecoinSupply": stable_supply,
            "dexVolume24h": dex.get("total24h"),
            "dexChange1d": dex.get("change_1d"),
            "dexChange7d": dex.get("change_7d"),
        },
        "trends": {
            "tps": [{"timestamp": now - sample["samplePeriodSecs"], "value": sample["numTransactions"] / sample["samplePeriodSecs"]} for sample in reversed(samples[:30])],
            "solPrice": [{"timestamp": point["timestamp"], "value": point["price"]} for point in price_points],
            "dexVolume": [{"timestamp": point[0], "value": point[1]} for point in dex.get("totalDataChart", [])[-30:]],
            "tvl": [{"timestamp": point["date"], "value": point["tvl"]} for point in tvl_history],
        },
        "alerts": alerts,
        "sources": sorted(sources, key=lambda item: item["id"]),
    }


def markdown(snapshot: dict[str, Any]) -> str:
    def metric(value: Any, suffix: str = "") -> str:
        return "Unavailable" if value is None else f"{value:,.2f}{suffix}"

    network, validators, economics = snapshot["network"], snapshot["validators"], snapshot["economics"]
    alerts = "\n".join(f'- **{item["level"].upper()} — {item["title"]}:** {item["detail"]}' for item in snapshot["alerts"])
    sources = "\n".join(f'- {item["label"]}: {item["status"]}' for item in snapshot["sources"])
    return f"""# Solstice — Solana Ecosystem Pulse

Generated: {snapshot['generatedAt']}

## Network

| Metric | Value |
| --- | ---: |
| Health | {network['health'] or 'Unavailable'} |
| Slot | {metric(network['slot'])} |
| Epoch | {metric(network['epoch'])} ({metric(network['epochProgress'], '%')}) |
| TPS | {metric(network['tps'])} |
| Slot time | {metric(network['slotTimeMs'], ' ms')} |

## Validators

| Metric | Value |
| --- | ---: |
| Active | {metric(validators['active'])} |
| Delinquent | {metric(validators['delinquent'])} |
| Delinquent share | {metric(validators['delinquentPercent'], '%')} |

## Economics

| Metric | Value |
| --- | ---: |
| SOL price | {metric(economics['solPrice'], ' USD')} |
| Solana TVL | {metric(economics['tvl'], ' USD')} |
| Stablecoin supply | {metric(economics['stablecoinSupply'], ' USD')} |
| DEX volume (24h) | {metric(economics['dexVolume24h'], ' USD')} |

## Signals

{alerts}

## Source health

{sources}
"""


def main() -> None:
    snapshot = collect()
    data_path = ROOT / "public" / "data" / "latest.json"
    report_path = ROOT / "public" / "reports" / "latest.md"
    data_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    data_path.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    report_path.write_text(markdown(snapshot), encoding="utf-8")
    print(f"Generated {data_path.relative_to(ROOT)} and {report_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
