"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Alert, PulseSnapshot, TrendPoint } from "../lib/pulse";

type View = "overview" | "network" | "economics" | "validators" | "sources";

const money = (value: number | null, compact = true) => {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(value);
};

const number = (value: number | null, digits = 0) => {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US", {
    notation: value > 999_999 ? "compact" : "standard",
    maximumFractionDigits: digits,
  }).format(value);
};

const signed = (value: number | null) => {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
};

function TrendBars({ points, tone = "violet" }: { points: TrendPoint[]; tone?: string }) {
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  if (!points.length) return <div className="chart-empty">Awaiting source data</div>;

  return (
    <div className={`trend-bars tone-${tone}`} aria-label="Metric trend">
      {points.map((point, index) => {
        const height = 18 + ((point.value - min) / span) * 82;
        return (
          <span
            key={`${point.timestamp}-${index}`}
            style={{ height: `${height}%` }}
            title={`${new Date(point.timestamp * 1000).toLocaleString()}: ${number(point.value, 2)}`}
          />
        );
      })}
    </div>
  );
}

function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="delta neutral">No baseline</span>;
  return <span className={`delta ${value >= 0 ? "positive" : "negative"}`}>{signed(value)}</span>;
}

function AlertCard({ alert }: { alert: Alert }) {
  return (
    <article className={`alert-card ${alert.level}`}>
      <span className="alert-mark" aria-hidden="true" />
      <div>
        <div className="eyebrow">{alert.level}</div>
        <h3>{alert.title}</h3>
        <p>{alert.detail}</p>
      </div>
    </article>
  );
}

function Gauge({ value }: { value: number | null }) {
  const normalized = Math.min(100, Math.max(0, value ?? 0));
  return (
    <div className="gauge" aria-label={`Epoch ${normalized.toFixed(1)} percent complete`}>
      <div className="gauge-track"><div className="gauge-fill" style={{ width: `${normalized}%` }} /></div>
      <span>{value === null ? "—" : `${value.toFixed(1)}%`}</span>
    </div>
  );
}

export default function Dashboard() {
  const [snapshot, setSnapshot] = useState<PulseSnapshot | null>(null);
  const [view, setView] = useState<View>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextRefresh, setNextRefresh] = useState(300);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      if (!response.ok) throw new Error(`Snapshot returned ${response.status}`);
      setSnapshot((await response.json()) as PulseSnapshot);
      setNextRefresh(300);
    } catch {
      setError("Live refresh is temporarily unavailable. Retrying automatically.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = window.setInterval(() => void load(), 300_000);
    const timer = window.setInterval(() => setNextRefresh((s) => (s <= 1 ? 300 : s - 1)), 1_000);
    return () => { window.clearInterval(refresh); window.clearInterval(timer); };
  }, [load]);

  const healthySources = snapshot?.sources.filter((source) => source.status === "live").length ?? 0;
  const sourceCount = snapshot?.sources.length ?? 0;
  const pulseState = useMemo(() => {
    if (!snapshot) return "Connecting";
    if (snapshot.alerts.some((alert) => alert.level === "critical")) return "Action required";
    if (snapshot.alerts.some((alert) => alert.level === "warning")) return "Watch";
    return "Nominal";
  }, [snapshot]);
  const nav: Array<{ id: View; label: string }> = [
    { id: "overview", label: "Pulse" }, { id: "network", label: "Network" },
    { id: "economics", label: "Economics" }, { id: "validators", label: "Validators" },
    { id: "sources", label: "Sources" },
  ];

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Solstice home">
          <span className="brand-orbit" aria-hidden="true"><i /></span><span>SOLSTICE</span>
        </a>
        <nav aria-label="Dashboard sections">
          {nav.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>{item.label}</button>)}
        </nav>
        <div className="header-actions">
          <a href="/api/report?format=md" className="text-link">Download report</a>
          <button className="refresh-button" onClick={() => void load()} disabled={loading}><span aria-hidden="true">↻</span> {loading ? "Syncing" : "Refresh"}</button>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="live-row"><span className={`live-dot ${pulseState === "Nominal" ? "ok" : "watch"}`} />MAINNET / LIVE OBSERVATORY</div>
          <h1>See Solana<br /><em>as a system.</em></h1>
          <p className="hero-description">A keyless, auto-updating field report for network health, validator resilience and economic activity. Built for signal, not spectacle.</p>
          <div className="hero-meta">
            <div><span>NETWORK STATE</span><strong>{pulseState}</strong></div>
            <div><span>SOURCE HEALTH</span><strong>{sourceCount ? `${healthySources}/${sourceCount} live` : "Connecting"}</strong></div>
            <div><span>NEXT REFRESH</span><strong>{Math.floor(nextRefresh / 60)}:{String(nextRefresh % 60).padStart(2, "0")}</strong></div>
          </div>
        </div>

        <aside className="hero-instrument" aria-label="Live network pulse">
          <div className="instrument-grid" />
          <div className="instrument-header"><span>THROUGHPUT</span><span>{snapshot?.network.version ? `v${snapshot.network.version}` : "MAINNET-BETA"}</span></div>
          <div className="instrument-value">{number(snapshot?.network.tps ?? null)}<small>TPS</small></div>
          <TrendBars points={snapshot?.trends.tps ?? []} tone="green" />
          <div className="instrument-footer">
            <div><span>NON-VOTE</span><b>{number(snapshot?.network.nonVoteTps ?? null)}</b></div>
            <div><span>SLOT TIME</span><b>{number(snapshot?.network.slotTimeMs ?? null)} ms</b></div>
            <div><span>AVERAGE</span><b>{number(snapshot?.network.averageTps ?? null)}</b></div>
          </div>
        </aside>
      </section>

      {error && <div className="error-banner" role="status">{error}</div>}

      <section className="section-shell">
        <div className="section-kicker"><span>01 / SYSTEM PULSE</span><span>{snapshot ? `Updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}` : "Connecting to sources"}</span></div>

        {(view === "overview" || view === "network") && <div className="metric-grid">
          <article className="metric-card span-two"><div className="metric-head"><span>Epoch progress</span><b>#{number(snapshot?.network.epoch ?? null)}</b></div><div className="metric-big">{number(snapshot?.network.epochProgress ?? null, 1)}<small>%</small></div><Gauge value={snapshot?.network.epochProgress ?? null} /><p>Consensus cycle completion from the latest RPC epoch state.</p></article>
          <article className="metric-card"><div className="metric-head"><span>Current slot</span><b>RPC</b></div><div className="metric-big compact">{number(snapshot?.network.slot ?? null)}</div><p>Canonical progression height observed at collection time.</p></article>
          <article className="metric-card"><div className="metric-head"><span>Total transactions</span><b>ALL TIME</b></div><div className="metric-big compact">{number(snapshot?.network.transactionCount ?? null)}</div><p>Transactions processed by the cluster since genesis.</p></article>
        </div>}

        {(view === "overview" || view === "economics") && <div className="economics-layout">
          <article className="panel market-panel"><div className="panel-heading"><div><span>ECONOMIC LAYER</span><h2>SOL market pulse</h2></div><Delta value={snapshot?.economics.priceChange7d ?? null} /></div><div className="market-price">{money(snapshot?.economics.solPrice ?? null, false)}</div><TrendBars points={snapshot?.trends.solPrice ?? []} tone="violet" /><div className="axis-labels"><span>7 days ago</span><span>Today</span></div></article>
          <div className="stacked-metrics">
            <article className="mini-metric"><span>TOTAL VALUE LOCKED</span><strong>{money(snapshot?.economics.tvl ?? null)}</strong><Delta value={snapshot?.economics.tvlChange7d ?? null} /></article>
            <article className="mini-metric"><span>DEX VOLUME / 24H</span><strong>{money(snapshot?.economics.dexVolume24h ?? null)}</strong><Delta value={snapshot?.economics.dexChange1d ?? null} /></article>
            <article className="mini-metric"><span>STABLECOIN SUPPLY</span><strong>{money(snapshot?.economics.stablecoinSupply ?? null)}</strong><span className="delta neutral">On-chain liquidity</span></article>
          </div>
        </div>}

        {(view === "overview" || view === "validators") && <div className="validators-layout">
          <article className="panel validator-panel"><div className="panel-heading"><div><span>CONSENSUS LAYER</span><h2>Validator resilience</h2></div><span className="status-chip">RPC DIRECT</span></div><div className="validator-numbers"><div><span>ACTIVE</span><strong>{number(snapshot?.validators.active ?? null)}</strong></div><div><span>DELINQUENT</span><strong>{number(snapshot?.validators.delinquent ?? null)}</strong></div><div><span>DELINQUENCY</span><strong>{number(snapshot?.validators.delinquentPercent ?? null, 2)}%</strong></div><div><span>ACTIVE STAKE</span><strong>{number(snapshot?.validators.activeStakeSol ?? null, 1)} SOL</strong></div></div><div className="validator-track"><span style={{ width: `${Math.max(0.4, snapshot?.validators.delinquentPercent ?? 0)}%` }} /></div><div className="track-legend"><span>Healthy vote accounts</span><span>Delinquent share</span></div></article>
          <div className="alerts-list"><div className="panel-heading compact-heading"><div><span>DETECTION ENGINE</span><h2>Signals</h2></div><span className="status-chip">Z-SCORE + RULES</span></div>{(snapshot?.alerts ?? []).map((alert, index) => <AlertCard key={`${alert.title}-${index}`} alert={alert} />)}</div>
        </div>}

        {(view === "overview" || view === "sources") && <section className="sources-section">
          <div className="panel-heading"><div><span>DATA PROVENANCE</span><h2>Source health & lineage</h2></div><div className="download-group"><a href="/api/report?format=json">JSON</a><a href="/api/report?format=md">MARKDOWN</a></div></div>
          <div className="source-table" role="table" aria-label="Data sources"><div className="source-row source-header" role="row"><span>Source</span><span>Status</span><span>Latency</span><span>Role</span></div>{(snapshot?.sources ?? []).map((source) => <div className="source-row" role="row" key={source.id}><span><i className={source.status} />{source.label}</span><span>{source.status}</span><span>{source.latencyMs === null ? "—" : `${source.latencyMs} ms`}</span><a href={source.url} target="_blank" rel="noreferrer">Inspect ↗</a></div>)}{!snapshot && <div className="source-loading">Establishing source connections…</div>}</div>
        </section>}
      </section>

      <section className="method-section"><div><span className="eyebrow">OPEN METHODOLOGY</span><h2>Every number has a route home.</h2></div><p>Solstice uses direct Solana JSON-RPC calls and public, keyless DefiLlama endpoints. It preserves partial results when a source degrades, exposes collection latency, and emits the same snapshot as HTML, Markdown and JSON.</p><a href="https://github.com/quetzalforge/solstice-solana-observatory" target="_blank" rel="noreferrer">View methodology ↗</a></section>

      <footer><div className="brand"><span className="brand-orbit"><i /></span><span>SOLSTICE</span></div><p>Independent Solana ecosystem observatory. Data is informational, not financial advice.</p><span>{new Date().getFullYear()} / BUILT IN GUATEMALA</span></footer>
    </main>
  );
}
