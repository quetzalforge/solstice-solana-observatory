# Superteam Earn submission

## Main link

https://github.com/quetzalforge/solstice-solana-observatory

## Live dashboard

https://solstice-solana-observatory.jocund-morel-7157.chatgpt.site

## Submission copy

Solstice is a keyless, automatically updating observatory for the Solana ecosystem. It batches direct Solana JSON-RPC calls for health, version, slot, epoch, recent performance, validators, supply, and transaction count, then correlates those measurements with public DefiLlama price, TVL, stablecoin, DEX-volume, and historical feeds.

The interactive dark-theme dashboard refreshes every five minutes and includes transparent anomaly detection for TPS, slot time, and validator delinquency. It degrades gracefully: if any upstream source fails, healthy metrics remain visible and the failed source, latency, and reason are exposed in the provenance table rather than replaced with fabricated values.

Outputs are available as interactive HTML, downloadable JSON, and downloadable Markdown. The repository also includes a Python standard-library collector and an hourly GitHub Action that generates checked-in sample reports without packages or API keys.

Highlights:

- direct batched Solana RPC measurements;
- network, validator, liquidity, and economic indicators;
- 7-day price and 30-day DEX/TVL trends;
- auditable z-score and threshold-based detection;
- source lineage, latency, and degradation visibility;
- no API keys required by default;
- Cloudflare-compatible deployment and responsive UI;
- reproducible JSON and Markdown samples.
