export type SourceState = {
  id: string;
  label: string;
  url: string;
  status: "live" | "degraded";
  latencyMs: number | null;
  message?: string;
};

export type Alert = {
  level: "info" | "warning" | "critical";
  title: string;
  detail: string;
};

export type TrendPoint = {
  timestamp: number;
  value: number;
};

export type PulseSnapshot = {
  generatedAt: string;
  network: {
    health: string | null;
    version: string | null;
    slot: number | null;
    epoch: number | null;
    epochProgress: number | null;
    tps: number | null;
    nonVoteTps: number | null;
    averageTps: number | null;
    slotTimeMs: number | null;
    transactionCount: number | null;
    circulatingSupply: number | null;
  };
  validators: {
    active: number | null;
    delinquent: number | null;
    delinquentPercent: number | null;
    activeStakeSol: number | null;
  };
  economics: {
    solPrice: number | null;
    priceChange7d: number | null;
    tvl: number | null;
    tvlChange7d: number | null;
    stablecoinSupply: number | null;
    dexVolume24h: number | null;
    dexChange1d: number | null;
    dexChange7d: number | null;
  };
  trends: {
    tps: TrendPoint[];
    solPrice: TrendPoint[];
    dexVolume: TrendPoint[];
    tvl: TrendPoint[];
  };
  alerts: Alert[];
  sources: SourceState[];
};

const RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

async function timedJson<T>(
  id: string,
  label: string,
  url: string,
  init?: RequestInit,
): Promise<{ data: T; source: SourceState }> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9_000);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      data: (await response.json()) as T,
      source: {
        id,
        label,
        url,
        status: "live",
        latencyMs: Date.now() - started,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    throw Object.assign(new Error(message), {
      source: {
        id,
        label,
        url,
        status: "degraded" as const,
        latencyMs: Date.now() - started,
        message,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

type RpcReply = { id: number; result?: unknown; error?: unknown };
type PerformanceSample = {
  numNonVoteTransactions: number;
  numSlots: number;
  numTransactions: number;
  samplePeriodSecs: number;
  slot: number;
};

const rpcCalls = [
  { jsonrpc: "2.0", id: 1, method: "getHealth" },
  { jsonrpc: "2.0", id: 2, method: "getVersion" },
  { jsonrpc: "2.0", id: 3, method: "getSlot" },
  { jsonrpc: "2.0", id: 4, method: "getEpochInfo" },
  { jsonrpc: "2.0", id: 5, method: "getRecentPerformanceSamples", params: [60] },
  { jsonrpc: "2.0", id: 6, method: "getVoteAccounts" },
  { jsonrpc: "2.0", id: 7, method: "getSupply" },
  { jsonrpc: "2.0", id: 8, method: "getTransactionCount" },
];

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pctChange(first: number | undefined, last: number | undefined) {
  if (!first || !last) return null;
  return ((last - first) / first) * 100;
}

function resultMap(replies: RpcReply[]) {
  return new Map(replies.map((reply) => [reply.id, reply.result]));
}

function degradedSource(
  id: string,
  label: string,
  url: string,
  reason: unknown,
): SourceState {
  const source = (reason as { source?: SourceState })?.source;
  return (
    source ?? {
      id,
      label,
      url,
      status: "degraded",
      latencyMs: null,
      message: reason instanceof Error ? reason.message : "Unavailable",
    }
  );
}

function zScore(values: number[]) {
  if (values.length < 3) return 0;
  const [latest, ...history] = values;
  const mean = history.reduce((sum, value) => sum + value, 0) / history.length;
  const variance =
    history.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    history.length;
  const deviation = Math.sqrt(variance);
  return deviation ? (latest - mean) / deviation : 0;
}

export async function collectPulse(): Promise<PulseSnapshot> {
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 60 * 60;

  const requests = await Promise.allSettled([
    timedJson<RpcReply[]>("rpc", "Solana RPC", RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcCalls),
    }),
    timedJson<Array<{ name: string; tvl: number }>>(
      "defillama-tvl",
      "DefiLlama TVL",
      "https://api.llama.fi/v2/chains",
    ),
    timedJson<{
      coins: Record<string, { price: number; symbol: string; confidence: number }>;
    }>(
      "defillama-price",
      "DefiLlama Price",
      "https://coins.llama.fi/prices/current/coingecko:solana",
    ),
    timedJson<{
      coins: Record<
        string,
        { prices: Array<{ timestamp: number; price: number }> }
      >;
    }>(
      "defillama-price-history",
      "DefiLlama Price History",
      `https://coins.llama.fi/chart/coingecko:solana?start=${sevenDaysAgo}&span=7&period=1d`,
    ),
    timedJson<
      Array<{
        name: string;
        totalCirculatingUSD?: { peggedUSD?: number };
      }>
    >(
      "defillama-stables",
      "DefiLlama Stablecoins",
      "https://stablecoins.llama.fi/stablecoinchains",
    ),
    timedJson<{
      total24h: number;
      change_1d: number;
      change_7d: number;
      totalDataChart: Array<[number, number]>;
    }>(
      "defillama-dex",
      "DefiLlama DEX Volume",
      "https://api.llama.fi/overview/dexs/Solana?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true&dataType=dailyVolume",
    ),
    timedJson<Array<{ date: number; tvl: number }>>(
      "defillama-tvl-history",
      "DefiLlama TVL History",
      "https://api.llama.fi/v2/historicalChainTvl/Solana",
    ),
  ]);

  const sources: SourceState[] = [];
  for (const request of requests) {
    if (request.status === "fulfilled") sources.push(request.value.source);
  }
  const sourceMeta = [
    ["rpc", "Solana RPC", RPC_URL],
    ["defillama-tvl", "DefiLlama TVL", "https://api.llama.fi/v2/chains"],
    [
      "defillama-price",
      "DefiLlama Price",
      "https://coins.llama.fi/prices/current/coingecko:solana",
    ],
    [
      "defillama-price-history",
      "DefiLlama Price History",
      "https://coins.llama.fi/chart/coingecko:solana",
    ],
    [
      "defillama-stables",
      "DefiLlama Stablecoins",
      "https://stablecoins.llama.fi/stablecoinchains",
    ],
    [
      "defillama-dex",
      "DefiLlama DEX Volume",
      "https://api.llama.fi/overview/dexs/Solana",
    ],
    [
      "defillama-tvl-history",
      "DefiLlama TVL History",
      "https://api.llama.fi/v2/historicalChainTvl/Solana",
    ],
  ] as const;
  requests.forEach((request, index) => {
    if (request.status === "rejected") {
      sources.push(degradedSource(...sourceMeta[index], request.reason));
    }
  });

  const rpc = requests[0].status === "fulfilled" ? requests[0].value.data : [];
  const rpcData = resultMap(rpc);
  const epoch = rpcData.get(4) as
    | { epoch: number; slotIndex: number; slotsInEpoch: number }
    | undefined;
  const samples = ((rpcData.get(5) as PerformanceSample[] | undefined) ?? []).filter(
    (sample) => sample.samplePeriodSecs > 0,
  );
  const latestSample = samples[0];
  const sampleTps = samples.map(
    (sample) => sample.numTransactions / sample.samplePeriodSecs,
  );
  const voteAccounts = rpcData.get(6) as
    | {
        current: Array<{ activatedStake: number }>;
        delinquent: Array<{ activatedStake: number }>;
      }
    | undefined;
  const supply = rpcData.get(7) as
    | { value: { circulating: number } }
    | undefined;
  const version = rpcData.get(2) as { "solana-core"?: string } | undefined;

  const chains = requests[1].status === "fulfilled" ? requests[1].value.data : [];
  const priceCurrent =
    requests[2].status === "fulfilled"
      ? requests[2].value.data.coins["coingecko:solana"]
      : undefined;
  const priceHistory =
    requests[3].status === "fulfilled"
      ? (requests[3].value.data.coins["coingecko:solana"]?.prices ?? [])
      : [];
  const stablechains =
    requests[4].status === "fulfilled" ? requests[4].value.data : [];
  const dex = requests[5].status === "fulfilled" ? requests[5].value.data : null;
  const tvlHistoryRaw =
    requests[6].status === "fulfilled" ? requests[6].value.data : [];

  const currentValidators = voteAccounts?.current ?? [];
  const delinquentValidators = voteAccounts?.delinquent ?? [];
  const validatorTotal = currentValidators.length + delinquentValidators.length;
  const delinquentPercent = validatorTotal
    ? (delinquentValidators.length / validatorTotal) * 100
    : null;
  const slotTimeMs = latestSample
    ? (latestSample.samplePeriodSecs / latestSample.numSlots) * 1000
    : null;
  const solTvl = chains.find((chain) => chain.name === "Solana")?.tvl ?? null;
  const stablecoinSupply =
    stablechains.find((chain) => chain.name === "Solana")?.totalCirculatingUSD
      ?.peggedUSD ?? null;

  const priceTrend = priceHistory.map((point) => ({
    timestamp: point.timestamp,
    value: point.price,
  }));
  const dexTrend = (dex?.totalDataChart ?? []).slice(-30).map(([timestamp, value]) => ({
    timestamp,
    value,
  }));
  const tvlTrend = tvlHistoryRaw.slice(-30).map((point) => ({
    timestamp: point.date,
    value: point.tvl,
  }));
  const tpsTrend = samples
    .slice(0, 30)
    .reverse()
    .map((sample) => ({
      timestamp: now - sample.samplePeriodSecs,
      value: sample.numTransactions / sample.samplePeriodSecs,
    }));

  const alerts: Alert[] = [];
  if (delinquentPercent !== null && delinquentPercent > 2) {
    alerts.push({
      level: delinquentPercent > 5 ? "critical" : "warning",
      title: "Validator delinquency elevated",
      detail: `${delinquentPercent.toFixed(2)}% of vote accounts are delinquent.`,
    });
  }
  if (slotTimeMs !== null && slotTimeMs > 600) {
    alerts.push({
      level: slotTimeMs > 800 ? "critical" : "warning",
      title: "Slot production is slower than baseline",
      detail: `Latest observed slot time is ${slotTimeMs.toFixed(0)} ms.`,
    });
  }
  const tpsZ = zScore(sampleTps);
  if (Math.abs(tpsZ) >= 2) {
    alerts.push({
      level: Math.abs(tpsZ) >= 3 ? "critical" : "warning",
      title: tpsZ > 0 ? "Transaction throughput spike" : "Transaction throughput drop",
      detail: `Latest TPS is ${Math.abs(tpsZ).toFixed(1)} standard deviations from its recent mean.`,
    });
  }
  const degraded = sources.filter((source) => source.status === "degraded");
  if (degraded.length) {
    alerts.push({
      level: "info",
      title: "Partial source degradation",
      detail: `${degraded.length} data source${degraded.length === 1 ? " is" : "s are"} unavailable; healthy sources remain visible.`,
    });
  }
  if (!alerts.length) {
    alerts.push({
      level: "info",
      title: "No material anomalies detected",
      detail: "Network and market indicators are within their recent operating ranges.",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    network: {
      health: (rpcData.get(1) as string | undefined) ?? null,
      version: version?.["solana-core"] ?? null,
      slot: numberOrNull(rpcData.get(3)),
      epoch: epoch?.epoch ?? null,
      epochProgress: epoch
        ? (epoch.slotIndex / epoch.slotsInEpoch) * 100
        : null,
      tps: latestSample
        ? latestSample.numTransactions / latestSample.samplePeriodSecs
        : null,
      nonVoteTps: latestSample
        ? latestSample.numNonVoteTransactions / latestSample.samplePeriodSecs
        : null,
      averageTps: sampleTps.length
        ? sampleTps.reduce((sum, value) => sum + value, 0) / sampleTps.length
        : null,
      slotTimeMs,
      transactionCount: numberOrNull(rpcData.get(8)),
      circulatingSupply: supply?.value.circulating
        ? supply.value.circulating / 1_000_000_000
        : null,
    },
    validators: {
      active: currentValidators.length || null,
      delinquent: delinquentValidators.length || null,
      delinquentPercent,
      activeStakeSol: currentValidators.length
        ? currentValidators.reduce((sum, validator) => sum + validator.activatedStake, 0) /
          1_000_000_000
        : null,
    },
    economics: {
      solPrice: priceCurrent?.price ?? null,
      priceChange7d: pctChange(priceTrend[0]?.value, priceTrend.at(-1)?.value),
      tvl: solTvl,
      tvlChange7d: pctChange(tvlTrend.at(-8)?.value, tvlTrend.at(-1)?.value),
      stablecoinSupply,
      dexVolume24h: dex?.total24h ?? null,
      dexChange1d: dex?.change_1d ?? null,
      dexChange7d: dex?.change_7d ?? null,
    },
    trends: {
      tps: tpsTrend,
      solPrice: priceTrend,
      dexVolume: dexTrend,
      tvl: tvlTrend,
    },
    alerts,
    sources,
  };
}

export function snapshotToMarkdown(snapshot: PulseSnapshot) {
  const money = (value: number | null) =>
    value === null ? "Unavailable" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const metric = (value: number | null, digits = 0) =>
    value === null ? "Unavailable" : value.toLocaleString("en-US", { maximumFractionDigits: digits });

  return `# Solstice — Solana Ecosystem Pulse\n\nGenerated: ${snapshot.generatedAt}\n\n## Network\n\n| Metric | Value |\n| --- | ---: |\n| Health | ${snapshot.network.health ?? "Unavailable"} |\n| Slot | ${metric(snapshot.network.slot)} |\n| Epoch | ${metric(snapshot.network.epoch)} (${metric(snapshot.network.epochProgress, 1)}%) |\n| TPS | ${metric(snapshot.network.tps, 0)} |\n| Non-vote TPS | ${metric(snapshot.network.nonVoteTps, 0)} |\n| Slot time | ${metric(snapshot.network.slotTimeMs, 0)} ms |\n\n## Validators\n\n| Metric | Value |\n| --- | ---: |\n| Active | ${metric(snapshot.validators.active)} |\n| Delinquent | ${metric(snapshot.validators.delinquent)} |\n| Delinquent share | ${metric(snapshot.validators.delinquentPercent, 2)}% |\n| Active stake | ${metric(snapshot.validators.activeStakeSol, 0)} SOL |\n\n## Economics\n\n| Metric | Value |\n| --- | ---: |\n| SOL price | ${money(snapshot.economics.solPrice)} |\n| Solana TVL | ${money(snapshot.economics.tvl)} |\n| Stablecoin supply | ${money(snapshot.economics.stablecoinSupply)} |\n| DEX volume (24h) | ${money(snapshot.economics.dexVolume24h)} |\n\n## Signals\n\n${snapshot.alerts.map((alert) => `- **${alert.level.toUpperCase()} — ${alert.title}:** ${alert.detail}`).join("\n")}\n\n## Source health\n\n${snapshot.sources.map((source) => `- ${source.label}: ${source.status}${source.latencyMs === null ? "" : ` (${source.latencyMs} ms)`}`).join("\n")}\n`;
}
