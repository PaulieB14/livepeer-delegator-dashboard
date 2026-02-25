import { useState, useEffect, useRef } from "react";
import { AreaChart, Area, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, ScatterChart, Scatter, LineChart, Line } from "recharts";

const API_KEY = import.meta.env.VITE_GRAPH_API_KEY;
const LIVEPEER_SUBGRAPH_ID = import.meta.env.VITE_LIVEPEER_SUBGRAPH_ID;
const ENS_SUBGRAPH_ID = import.meta.env.VITE_ENS_SUBGRAPH_ID;
const graphUrl = (id) => `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/${id}`;

const QUERIES = {
  delegator: (id) => `{
    delegator(id: "${id}") {
      id
      bondedAmount
      fees
      withdrawnFees
      startRound
      delegate { id totalStake rewardCut feeShare active lastRewardRound { id } serviceURI thirtyDayVolumeETH ninetyDayVolumeETH }
      lastClaimRound { id }
    }
  }`,
  earnings: (id) => `{
    earningsClaimedEvents(where: { delegator: "${id}" }, orderBy: timestamp, orderDirection: asc, first: 100) {
      id timestamp startRound endRound { id } rewardTokens fees delegate { id }
    }
  }`,
  events: (id) => `{
    bondEvents(where: { delegator: "${id}" }, orderBy: timestamp, orderDirection: asc, first: 100) {
      id timestamp round { id } bondedAmount additionalAmount newDelegate { id } oldDelegate { id }
    }
    unbondEvents(where: { delegator: "${id}" }, orderBy: timestamp, orderDirection: asc, first: 100) {
      id timestamp round { id } amount delegate { id }
    }
    rebondEvents(where: { delegator: "${id}" }, orderBy: timestamp, orderDirection: asc, first: 100) {
      id timestamp round { id } amount delegate { id }
    }
    withdrawStakeEvents(where: { delegator: "${id}" }, orderBy: timestamp, orderDirection: asc, first: 100) {
      id timestamp round { id } amount
    }
    withdrawFeesEvents(where: { delegator: "${id}" }, orderBy: timestamp, orderDirection: asc, first: 100) {
      id timestamp round { id } amount
    }
  }`,
  transcoders: `{
    transcoders(where: { active: true }, first: 100, orderBy: totalStake, orderDirection: desc) {
      id active rewardCut feeShare totalStake
      thirtyDayVolumeETH ninetyDayVolumeETH totalVolumeETH
      lastRewardRound { id }
    }
  }`,
  protocol: `{
    protocol(id: "0") {
      inflation totalActiveStake totalSupply participationRate
      currentRound { id mintableTokens }
      lptPriceEth
    }
  }`,
};

async function gqlFetch(query, subgraphId = LIVEPEER_SUBGRAPH_ID) {
  const res = await fetch(graphUrl(subgraphId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function resolveENS(name) {
  const data = await gqlFetch(`{ domains(where: { name: "${name.toLowerCase()}" }) { resolvedAddress { id } } }`, ENS_SUBGRAPH_ID);
  const addr = data?.domains?.[0]?.resolvedAddress?.id;
  if (!addr) throw new Error(`Could not resolve ENS name "${name}". Make sure it's a valid .eth name.`);
  return addr;
}

async function batchResolveENS(addresses) {
  const names = {};
  try {
    const addrList = addresses.map((a) => `"${a.toLowerCase()}"`).join(",");
    const data = await gqlFetch(`{ domains(where: { resolvedAddress_in: [${addrList}] }, first: 1000) { name resolvedAddress { id } } }`, ENS_SUBGRAPH_ID);
    (data?.domains || []).forEach((d) => {
      if (d.name && d.resolvedAddress?.id) {
        const addr = d.resolvedAddress.id.toLowerCase();
        if (!names[addr] || d.name.length < names[addr].length) names[addr] = d.name;
      }
    });
  } catch (e) { /* ENS resolution is best-effort */ }
  return names;
}

function exportCSV(orchs, ensNames, simStake) {
  const headers = ["Orchestrator", "ENS Name", "Reward APY %", "30d ETH Fees", "ETH/LPT/yr", "Reward Cut %", "Fee Share %", "Total Stake", "Reward Calling", "Est LPT/yr", "Est ETH/yr"];
  const rows = orchs.map((o) => [
    o.id, ensNames[o.id] || "", o.rewardAPY.toFixed(2), o.eth30d.toFixed(4),
    o.ethYieldPerLPT.toFixed(6), (o.rewardCut / 10000).toFixed(2), (o.feeShare / 10000).toFixed(2),
    o.stake.toFixed(0), o.callingReward ? "Yes" : "No",
    (simStake * o.rewardAPY / 100).toFixed(2), (simStake * o.ethYieldPerLPT).toFixed(6),
  ]);
  const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "livepeer-orchestrators.csv"; a.click();
  URL.revokeObjectURL(url);
}

const fmtAddr = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
const fmtD = (ts) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtM = (ts) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
const fmtN = (n, d = 2) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

// ── Animated counter ──
function AnimNum({ value, decimals = 2, prefix = "", suffix = "" }) {
  const [display, setDisplay] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    const target = Number(value) || 0;
    const start = display;
    const dur = 1200;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min((now - t0) / dur, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      setDisplay(start + (target - start) * ease);
      if (p < 1) ref.current = requestAnimationFrame(tick);
    };
    ref.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(ref.current);
  }, [value]);
  return <span>{prefix}{fmtN(display, decimals)}{suffix}</span>;
}

// ── Glass card ──
const GlassCard = ({ children, style = {}, ...props }) => (
  <div style={{ background: "rgba(255,255,255,0.02)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 16, ...style }} {...props}>
    {children}
  </div>
);

// ── Chip tab ──
const ChipTab = ({ label, active, onClick, color = "#00e88c" }) => (
  <button onClick={onClick} style={{ padding: "6px 16px", borderRadius: 99, border: active ? `1px solid ${color}44` : "1px solid rgba(255,255,255,0.06)", background: active ? `${color}15` : "transparent", color: active ? color : "rgba(255,255,255,0.35)", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", cursor: "pointer", transition: "all 0.2s" }}>
    {label}
  </button>
);

// ── Tooltip ──
const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "rgba(6,6,14,0.95)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "10px 14px", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}>
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ fontSize: 12, fontWeight: 700, color: p.color || "#00e88c", fontFamily: "'Space Mono', monospace" }}>
          {p.name}: {typeof p.value === "number" ? p.value.toLocaleString("en-US", { maximumFractionDigits: 6 }) : p.value}
        </div>
      ))}
    </div>
  );
};

// ── Stat card ──
const StatCard = ({ label, children, sub, color = "#00e88c" }) => (
  <GlassCard style={{ padding: "20px 24px", flex: 1, minWidth: 180 }}>
    <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 800, color, fontFamily: "'Space Mono', monospace", letterSpacing: "-0.02em" }}>{children}</div>
    {sub && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 4 }}>{sub}</div>}
  </GlassCard>
);

// ════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════
export default function LivepeerDashboard() {
  const [wallet, setWallet] = useState("");
  const [inputVal, setInputVal] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("dash");
  const [metric, setMetric] = useState("lpt");
  const [show, setShow] = useState(false);
  const [orchData, setOrchData] = useState(null);
  const [orchLoading, setOrchLoading] = useState(false);
  const [orchFilter, setOrchFilter] = useState("working");
  const [orchSort, setOrchSort] = useState({ col: "rewardAPY", dir: "desc" });
  const [ensNames, setEnsNames] = useState({});
  const [protocolData, setProtocolData] = useState(null);
  const [simStake, setSimStake] = useState(0);
  const [simCustom, setSimCustom] = useState(false);

  // ── URL param auto-load ──
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const addr = params.get("address") || params.get("wallet");
    if (addr) { setInputVal(addr); loadDelegator(addr); }
  }, []);

  // ── Load data ──
  async function loadDelegator(address) {
    const input = address.trim();
    if (!input) return;
    setLoading(true);
    setError("");
    setData(null);
    setOrchData(null);
    try {
      let addr;
      if (input.endsWith(".eth")) {
        addr = await resolveENS(input);
      } else {
        addr = input.toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(addr)) {
          throw new Error("Please enter a valid Ethereum address (0x...) or ENS name (.eth)");
        }
      }
      const [delData, earnData, evtData] = await Promise.all([
        gqlFetch(QUERIES.delegator(addr)),
        gqlFetch(QUERIES.earnings(addr)),
        gqlFetch(QUERIES.events(addr)),
      ]);

      if (!delData.delegator) throw new Error("No delegator found at this address. Make sure the wallet has delegated LPT on Livepeer (Arbitrum).");

      const del = delData.delegator;
      const claims = (earnData.earningsClaimedEvents || []).map((c) => {
        const startR = Number(c.startRound);
        const endR = Number(c.endRound.id);
        const rounds = Math.max(endR - startR + 1, 1);
        return {
          r: `${startR}–${endR}`,
          lpt: Number(c.rewardTokens),
          eth: Number(c.fees),
          ts: Number(c.timestamp),
          rounds,
          delegate: c.delegate?.id,
        };
      });

      // Build events timeline
      const events = [];
      (evtData.bondEvents || []).forEach((e) => {
        const isRebond = Number(e.additionalAmount) === 0 && e.oldDelegate;
        events.push({
          t: isRebond ? "redelegate" : "bond",
          ts: Number(e.timestamp),
          round: Number(e.round.id),
          desc: isRebond
            ? `Moved delegation to ${fmtAddr(e.newDelegate.id)}`
            : `Bonded ${fmtN(Number(e.additionalAmount))} LPT`,
          val: `${fmtN(Number(e.additionalAmount))} LPT`,
          to: fmtAddr(e.newDelegate.id),
        });
      });
      (evtData.unbondEvents || []).forEach((e) => {
        events.push({ t: "unbond", ts: Number(e.timestamp), round: Number(e.round.id), desc: `Unbonded ${fmtN(Number(e.amount))} LPT`, val: `${fmtN(Number(e.amount))} LPT` });
      });
      (evtData.rebondEvents || []).forEach((e) => {
        events.push({ t: "rebond", ts: Number(e.timestamp), round: Number(e.round.id), desc: `Rebonded ${fmtN(Number(e.amount))} LPT`, val: `${fmtN(Number(e.amount))} LPT` });
      });
      (evtData.withdrawStakeEvents || []).forEach((e) => {
        events.push({ t: "withdraw", ts: Number(e.timestamp), round: Number(e.round.id), desc: `Withdrew ${fmtN(Number(e.amount))} LPT stake`, val: `${fmtN(Number(e.amount))} LPT` });
      });
      (evtData.withdrawFeesEvents || []).forEach((e) => {
        events.push({ t: "withdrawFees", ts: Number(e.timestamp), round: Number(e.round.id), desc: `Withdrew ${fmtN(Number(e.amount), 6)} ETH fees`, val: `${fmtN(Number(e.amount), 6)} ETH` });
      });
      claims.forEach((c) => {
        events.push({ t: "claim", ts: c.ts, round: 0, desc: `Claimed ${fmtN(c.lpt)} LPT + ${fmtN(c.eth, 6)} ETH (${c.r})`, val: `${fmtN(c.lpt)} LPT` });
      });
      events.sort((a, b) => a.ts - b.ts);

      setData({
        address: addr,
        delegator: del,
        claims,
        events,
        bondedAmount: Number(del.bondedAmount),
        totalFees: Number(del.fees),
        withdrawnFees: Number(del.withdrawnFees),
        delegate: del.delegate,
        earned: claims.reduce((s, c) => s + c.lpt, 0),
        totalETH: claims.reduce((s, c) => s + c.eth, 0),
        totalRounds: claims.reduce((s, c) => s + c.rounds, 0),
      });
      setWallet(addr);
      setTab("dash");
      setShow(false);
      setSimStake(Number(del.bondedAmount));
      setSimCustom(false);
      // Sync URL for sharing
      const url = new URL(window.location);
      url.searchParams.set("address", addr);
      window.history.replaceState({}, "", url);
      setTimeout(() => setShow(true), 50);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Load orchestrator comparison data ──
  async function loadOrchestrators() {
    if (orchData) return;
    setOrchLoading(true);
    try {
      const [tData, pData] = await Promise.all([
        gqlFetch(QUERIES.transcoders),
        gqlFetch(QUERIES.protocol),
      ]);
      const protocol = pData.protocol;
      const mintable = Number(protocol.currentRound.mintableTokens);
      const totalActive = Number(protocol.totalActiveStake);
      const currentRoundId = protocol.currentRound.id;

      setProtocolData({
        inflation: Number(protocol.inflation),
        totalActiveStake: totalActive,
        totalSupply: Number(protocol.totalSupply),
        participationRate: Number(protocol.participationRate),
        currentRound: currentRoundId,
        lptPriceEth: Number(protocol.lptPriceEth),
      });

      const orchs = tData.transcoders.map((t) => {
        const stake = Number(t.totalStake);
        const rewardCut = Number(t.rewardCut);
        const feeShare = Number(t.feeShare);
        const eth30d = Number(t.thirtyDayVolumeETH);
        const eth90d = Number(t.ninetyDayVolumeETH);

        // Reward APY: per-round delegator yield, annualized
        const baseYield = totalActive > 0 ? mintable / totalActive : 0;
        const delegatorYield = baseYield * (1 - rewardCut / 1000000);
        const rewardAPY = delegatorYield * 365 * 100;

        // ETH yield: delegator share of 30d fees, per LPT staked, annualized
        const delegatorFees30d = eth30d * (feeShare / 1000000);
        const ethYieldPerLPT = stake > 0 ? (delegatorFees30d / stake) * 12 : 0;

        return {
          id: t.id,
          rewardCut,
          feeShare,
          stake,
          eth30d,
          eth90d,
          totalETH: Number(t.totalVolumeETH),
          rewardAPY,
          ethYieldPerLPT,
          delegatorFees30d,
          isWorking: eth30d > 0,
          lastRewardRound: t.lastRewardRound?.id,
          callingReward: t.lastRewardRound?.id === currentRoundId,
          sparkline: null,
        };
      });
      setOrchData(orchs);

      // Fetch ENS names in background (best-effort)
      const addresses = orchs.map((o) => o.id);
      batchResolveENS(addresses).then((names) => setEnsNames(names));

      // Fetch sparkline data in background for working orchestrators
      const workingIds = orchs.filter((o) => o.isWorking).map((o) => `"${o.id}"`);
      if (workingIds.length > 0) {
        const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
        const dayStart = Math.floor(thirtyDaysAgo / 86400);
        gqlFetch(`{
          transcoderDays(where: { transcoder_in: [${workingIds.join(",")}], date_gte: ${dayStart} }, first: 1000, orderBy: date, orderDirection: asc) {
            transcoder { id }
            date
            volumeETH
          }
        }`).then((sparkData) => {
          const byOrch = {};
          (sparkData?.transcoderDays || []).forEach((d) => {
            const id = d.transcoder.id;
            if (!byOrch[id]) byOrch[id] = [];
            byOrch[id].push({ d: Number(d.date), v: Number(d.volumeETH) });
          });
          setOrchData((prev) => prev ? prev.map((o) => ({
            ...o,
            sparkline: byOrch[o.id] || null,
          })) : prev);
        }).catch(() => {});
      }
    } catch (err) {
      console.error("Failed to load orchestrators:", err);
    } finally {
      setOrchLoading(false);
    }
  }

  useEffect(() => {
    if (tab === "compare" && data && !orchData && !orchLoading) {
      loadOrchestrators();
    }
  }, [tab, data]);

  const fadeStyle = (delay = 0) => ({
    opacity: show ? 1 : 0,
    transform: show ? "translateY(0)" : "translateY(16px)",
    transition: `opacity 0.6s ease ${delay}ms, transform 0.6s ease ${delay}ms`,
  });

  // ── Derived data ──
  const claims = data?.claims || [];
  const earned = data?.earned || 0;
  const totalETH = data?.totalETH || 0;
  const totalRounds = data?.totalRounds || 0;
  const bondedAmount = data?.bondedAmount || 0;
  const principal = bondedAmount - earned;
  const roi = bondedAmount > 0 ? ((earned / Math.max(principal, 1)) * 100) : 0;
  const del = data?.delegate;

  let cumData = [];
  if (claims.length) {
    let cl = 0, ce = 0;
    cumData = claims.map((c) => {
      cl += c.lpt;
      ce += c.eth;
      return { date: fmtM(c.ts), lpt: +cl.toFixed(2), eth: +ce.toFixed(5), claimLPT: c.lpt, claimETH: c.eth };
    });
  }

  // ── Compare tab derived data ──
  const currentOrchId = data?.delegate?.id?.toLowerCase();
  const effectiveStake = simCustom ? simStake : bondedAmount;
  const filteredOrchs = (orchData || [])
    .filter((o) => orchFilter === "all" || o.isWorking)
    .sort((a, b) => {
      const mult = orchSort.dir === "desc" ? -1 : 1;
      return (a[orchSort.col] - b[orchSort.col]) * mult;
    });
  const currentOrchRank = filteredOrchs.findIndex((o) => o.id === currentOrchId) + 1;
  const workingCount = (orchData || []).filter((o) => o.isWorking).length;
  const orchDisplay = (id) => ensNames[id] || fmtAddr(id);

  const evtColors = { bond: "#00e88c", claim: "#64a0ff", unbond: "#ff5c5c", rebond: "#ffb84d", redelegate: "#c77dff", withdraw: "#ff5c5c", withdrawFees: "#c77dff" };

  // ════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════
  return (
    <div style={{ minHeight: "100vh", background: "#06060e", color: "#fff", fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", position: "relative", overflow: "hidden" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />

      {/* Ambient glow */}
      <div style={{ position: "fixed", top: "-30%", left: "-10%", width: "60%", height: "60%", background: "radial-gradient(circle, rgba(0,232,140,0.04) 0%, transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "fixed", bottom: "-20%", right: "-10%", width: "50%", height: "50%", background: "radial-gradient(circle, rgba(100,160,255,0.03) 0%, transparent 70%)", pointerEvents: "none" }} />

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "32px 20px", position: "relative", zIndex: 1 }}>
        {/* Header */}
        <div style={{ marginBottom: 32, textAlign: "center" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.2)", textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 8 }}>Livepeer Network</div>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, background: "linear-gradient(135deg, #00e88c 0%, #64a0ff 50%, #c77dff 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            Delegator Dashboard
          </h1>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", marginTop: 6 }}>
            Powered by <a href="https://thegraph.com" target="_blank" rel="noopener" style={{ color: "#6f4cff", textDecoration: "none" }}>The Graph</a>
          </div>
        </div>

        {/* Wallet input */}
        <GlassCard style={{ padding: "20px 24px", marginBottom: 28 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="text"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadDelegator(inputVal)}
              placeholder="Enter wallet address (0x...) or ENS name (.eth)"
              style={{
                flex: 1, minWidth: 240, padding: "12px 16px", borderRadius: 10,
                background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                color: "#fff", fontSize: 13, fontFamily: "'Space Mono', monospace",
                outline: "none", transition: "border-color 0.2s",
              }}
              onFocus={(e) => (e.target.style.borderColor = "rgba(0,232,140,0.3)")}
              onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.08)")}
            />
            <button
              onClick={() => loadDelegator(inputVal)}
              disabled={loading}
              style={{
                padding: "12px 28px", borderRadius: 10, border: "none",
                background: loading ? "rgba(0,232,140,0.2)" : "linear-gradient(135deg, #00e88c, #00c878)",
                color: "#06060e", fontSize: 13, fontWeight: 800, cursor: loading ? "wait" : "pointer",
                transition: "all 0.2s", letterSpacing: "0.02em",
              }}
            >
              {loading ? "Loading…" : "Load Dashboard"}
            </button>
          </div>
          {error && (
            <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(255,92,92,0.08)", border: "1px solid rgba(255,92,92,0.15)", borderRadius: 8, color: "#ff5c5c", fontSize: 12 }}>
              {error}
            </div>
          )}
          {wallet && !loading && (
            <div style={{ marginTop: 10, fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
              Showing: <span style={{ fontFamily: "'Space Mono', monospace", color: "rgba(255,255,255,0.5)" }}>{wallet}</span>
            </div>
          )}
        </GlassCard>

        {/* No data state */}
        {!data && !loading && !error && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "rgba(255,255,255,0.2)" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🎬</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Enter a wallet address to get started</div>
            <div style={{ fontSize: 12 }}>View earnings, claims history, and delegation stats for any Livepeer delegator</div>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "rgba(255,255,255,0.3)" }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Querying the Livepeer subgraph…</div>
            <div style={{ marginTop: 16, width: 40, height: 40, border: "3px solid rgba(0,232,140,0.15)", borderTopColor: "#00e88c", borderRadius: "50%", margin: "16px auto", animation: "spin 0.8s linear infinite" }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* Dashboard content */}
        {data && !loading && (
          <>
            {/* Tab bar */}
            <div style={{ display: "flex", gap: 6, marginBottom: 24, ...fadeStyle(0) }}>
              {[["dash", "Dashboard"], ["earn", "Earnings"], ["hist", "History"], ["compare", "Compare"]].map(([k, l]) => (
                <ChipTab key={k} label={l} active={tab === k} onClick={() => setTab(k)} />
              ))}
            </div>

            {/* ═══ DASHBOARD TAB ═══ */}
            {tab === "dash" && (
              <>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16, ...fadeStyle(50) }}>
                  <StatCard label="Bonded Amount">
                    <AnimNum value={bondedAmount} suffix=" LPT" />
                  </StatCard>
                  <StatCard label="Lifetime LPT Earned" sub={`${claims.length} claims across ${totalRounds} rounds`}>
                    <AnimNum value={earned} suffix=" LPT" />
                  </StatCard>
                  <StatCard label="Lifetime ETH Earned" color="#c77dff" sub={`${fmtN(data.withdrawnFees, 6)} withdrawn`}>
                    <AnimNum value={totalETH} decimals={4} suffix=" ETH" />
                  </StatCard>
                </div>

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16, ...fadeStyle(150) }}>
                  <GlassCard style={{ padding: "20px 24px", flex: 1, minWidth: 200, display: "flex", alignItems: "center", gap: 20 }}>
                    <PieChart width={80} height={80}>
                      <Pie data={[{ v: earned }, { v: Math.max(principal, 0) }]} dataKey="v" cx={40} cy={40} innerRadius={25} outerRadius={38} startAngle={90} endAngle={-270} strokeWidth={0}>
                        <Cell fill="#00e88c" />
                        <Cell fill="rgba(255,255,255,0.06)" />
                      </Pie>
                    </PieChart>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Reward ROI</div>
                      <div style={{ fontSize: 28, fontWeight: 800, color: "#00e88c", fontFamily: "'Space Mono', monospace" }}>{roi.toFixed(0)}%</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>rewards / principal</div>
                    </div>
                  </GlassCard>

                  <GlassCard style={{ padding: "20px 24px", flex: 1, minWidth: 200, display: "flex", alignItems: "center", gap: 20 }}>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Avg LPT / Round</div>
                      <div style={{ fontSize: 28, fontWeight: 800, color: "#ffb84d", fontFamily: "'Space Mono', monospace" }}>
                        {totalRounds > 0 ? (earned / totalRounds).toFixed(2) : "—"}
                      </div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>≈ daily earning rate</div>
                    </div>
                  </GlassCard>
                </div>

                {/* Orchestrator info */}
                {del && (
                  <GlassCard style={{ padding: "20px 24px", ...fadeStyle(250) }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Current Orchestrator</div>
                    <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginBottom: 2 }}>Address</div>
                        <div style={{ fontSize: 12, fontFamily: "'Space Mono', monospace", color: "rgba(255,255,255,0.6)" }}>{fmtAddr(del.id)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginBottom: 2 }}>Status</div>
                        <div style={{ fontSize: 12, color: del.active ? "#00e88c" : "#ff5c5c" }}>{del.active ? "● Active" : "○ Inactive"}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginBottom: 2 }}>Reward Cut</div>
                        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>{(Number(del.rewardCut) / 10000).toFixed(2)}%</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginBottom: 2 }}>Fee Share</div>
                        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>{(Number(del.feeShare) / 10000).toFixed(2)}%</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginBottom: 2 }}>Total Stake</div>
                        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>{fmtN(Number(del.totalStake))} LPT</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginBottom: 2 }}>30d Fees</div>
                        <div style={{ fontSize: 12, color: "#c77dff" }}>{fmtN(Number(del.thirtyDayVolumeETH), 4)} ETH</div>
                      </div>
                    </div>
                  </GlassCard>
                )}

                {/* Cumulative chart */}
                {cumData.length > 0 && (
                  <GlassCard style={{ padding: "24px 28px", marginTop: 16, ...fadeStyle(350) }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>Cumulative Rewards</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={cumData}>
                        <defs>
                          <linearGradient id="gA" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#00e88c" stopOpacity={0.2} />
                            <stop offset="100%" stopColor="#00e88c" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="date" tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9, fontFamily: "Space Mono" }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9, fontFamily: "Space Mono" }} axisLine={false} tickLine={false} width={50} />
                        <Tooltip content={<TT />} />
                        <Area type="monotone" dataKey="lpt" name="Total LPT" stroke="#00e88c" strokeWidth={2.5} fill="url(#gA)" dot={{ r: 3, fill: "#00e88c", stroke: "#06060e", strokeWidth: 2 }} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </GlassCard>
                )}
              </>
            )}

            {/* ═══ EARNINGS TAB ═══ */}
            {tab === "earn" && (
              <>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16, ...fadeStyle(50) }}>
                  <ChipTab label="LPT Rewards" active={metric === "lpt"} onClick={() => setMetric("lpt")} />
                  <ChipTab label="ETH Fees" active={metric === "eth"} onClick={() => setMetric("eth")} color="#c77dff" />
                  <ChipTab label="Daily Rate" active={metric === "daily"} onClick={() => setMetric("daily")} color="#ffb84d" />
                  <ChipTab label="Growth" active={metric === "cum"} onClick={() => setMetric("cum")} color="#64a0ff" />
                </div>

                <GlassCard style={{ ...fadeStyle(150), padding: "24px 28px", marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>
                    {metric === "cum" ? "Cumulative Growth" : metric === "lpt" ? "LPT Earned Per Claim" : metric === "daily" ? "LPT Earned Per Round (Daily Rate)" : "ETH Fees Per Claim"}
                  </div>
                  <ResponsiveContainer width="100%" height={260}>
                    {metric === "cum" ? (
                      <AreaChart data={cumData}>
                        <defs>
                          <linearGradient id="gB" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#64a0ff" stopOpacity={0.25} />
                            <stop offset="100%" stopColor="#64a0ff" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="date" tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9, fontFamily: "Space Mono" }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9, fontFamily: "Space Mono" }} axisLine={false} tickLine={false} width={50} />
                        <Tooltip content={<TT />} />
                        <Area type="monotone" dataKey="lpt" name="LPT" stroke="#64a0ff" strokeWidth={2.5} fill="url(#gB)" dot={{ r: 3, fill: "#64a0ff", stroke: "#06060e", strokeWidth: 2 }} />
                      </AreaChart>
                    ) : metric === "daily" ? (
                      <BarChart data={claims.map((c) => ({ date: fmtM(c.ts), lpt: +(c.lpt / c.rounds).toFixed(2), rounds: c.rounds }))} barCategoryGap="20%">
                        <XAxis dataKey="date" tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9, fontFamily: "Space Mono" }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9, fontFamily: "Space Mono" }} axisLine={false} tickLine={false} width={50} />
                        <Tooltip content={<TT />} />
                        <Bar dataKey="lpt" name="LPT/Round" radius={[6, 6, 0, 0]}>
                          {claims.map((_, i) => (
                            <Cell key={i} fill={`rgba(255,184,77,${0.4 + (i / claims.length) * 0.5})`} />
                          ))}
                        </Bar>
                      </BarChart>
                    ) : (
                      <BarChart data={claims.map((c) => ({ date: fmtM(c.ts), lpt: +c.lpt.toFixed(2), eth: +c.eth.toFixed(5) }))} barCategoryGap="20%">
                        <XAxis dataKey="date" tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9, fontFamily: "Space Mono" }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9, fontFamily: "Space Mono" }} axisLine={false} tickLine={false} width={50} />
                        <Tooltip content={<TT />} />
                        <Bar dataKey={metric} name={metric === "lpt" ? "LPT" : "ETH Fees"} radius={[6, 6, 0, 0]}>
                          {claims.map((_, i) => (
                            <Cell key={i} fill={metric === "lpt" ? `rgba(0,232,140,${0.4 + (i / claims.length) * 0.5})` : `rgba(199,125,255,${0.4 + (i / claims.length) * 0.5})`} />
                          ))}
                        </Bar>
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                </GlassCard>

                {/* Claims table */}
                <GlassCard style={{ ...fadeStyle(250), padding: "24px 28px" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>
                    Claim History — {claims.length} claims
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Space Mono', monospace", fontSize: 12 }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                          {["Rounds", "LPT Earned", "LPT/Round", "ETH Fees", "ETH/Round", "Date"].map((h) => (
                            <th key={h} style={{ padding: "8px 12px", textAlign: h === "Rounds" || h === "Date" ? "left" : "right", color: "rgba(255,255,255,0.3)", fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[...claims].reverse().map((c, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.025)", transition: "background 0.2s", cursor: "default" }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(0,232,140,0.03)")}
                              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                            <td style={{ padding: "12px", color: "rgba(255,255,255,0.5)" }}>{c.r}</td>
                            <td style={{ padding: "12px", textAlign: "right", color: "#00e88c", fontWeight: 700 }}>+{c.lpt.toFixed(2)}</td>
                            <td style={{ padding: "12px", textAlign: "right", color: "rgba(0,232,140,0.5)", fontSize: 11 }}>{(c.lpt / c.rounds).toFixed(2)}</td>
                            <td style={{ padding: "12px", textAlign: "right", color: "rgba(199,125,255,0.7)" }}>+{c.eth.toFixed(5)}</td>
                            <td style={{ padding: "12px", textAlign: "right", color: "rgba(199,125,255,0.4)", fontSize: 11 }}>{(c.eth / c.rounds).toFixed(6)}</td>
                            <td style={{ padding: "12px", color: "rgba(255,255,255,0.3)" }}>{fmtD(c.ts)}</td>
                          </tr>
                        ))}
                        <tr style={{ borderTop: "2px solid rgba(0,232,140,0.15)" }}>
                          <td style={{ padding: "14px 12px", fontWeight: 800, color: "rgba(255,255,255,0.7)" }}>TOTAL</td>
                          <td style={{ padding: "14px 12px", textAlign: "right", fontWeight: 800, color: "#00e88c", fontSize: 13 }}>{fmtN(earned)}</td>
                          <td style={{ padding: "14px 12px", textAlign: "right", fontWeight: 700, color: "rgba(0,232,140,0.6)", fontSize: 11 }}>avg {totalRounds > 0 ? (earned / totalRounds).toFixed(2) : "—"}</td>
                          <td style={{ padding: "14px 12px", textAlign: "right", fontWeight: 800, color: "#c77dff", fontSize: 13 }}>{totalETH.toFixed(5)}</td>
                          <td style={{ padding: "14px 12px", textAlign: "right", fontWeight: 700, color: "rgba(199,125,255,0.5)", fontSize: 11 }}>avg {totalRounds > 0 ? (totalETH / totalRounds).toFixed(6) : "—"}</td>
                          <td />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </GlassCard>
              </>
            )}

            {/* ═══ HISTORY TAB ═══ */}
            {tab === "hist" && (
              <GlassCard style={{ ...fadeStyle(50), padding: "24px 28px" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 20 }}>
                  Event Timeline — {data.events.length} events
                </div>
                {data.events.slice().reverse().map((evt, i) => (
                  <div key={i} style={{ display: "flex", gap: 16, marginBottom: 0, padding: "14px 0", borderBottom: "1px solid rgba(255,255,255,0.025)" }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: evtColors[evt.t] || "#555", marginTop: 4, flexShrink: 0, boxShadow: `0 0 8px ${evtColors[evt.t] || "#555"}44` }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: evtColors[evt.t] || "#555", background: `${evtColors[evt.t] || "#555"}15`, padding: "2px 8px", borderRadius: 4 }}>
                          {evt.t}
                        </span>
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", fontFamily: "'Space Mono', monospace" }}>{fmtD(evt.ts)}</span>
                      </div>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 4 }}>{evt.desc}</div>
                    </div>
                  </div>
                ))}
              </GlassCard>
            )}

            {/* ═══ COMPARE TAB ═══ */}
            {tab === "compare" && (
              <>
                {orchLoading && (
                  <div style={{ textAlign: "center", padding: "60px 20px", color: "rgba(255,255,255,0.3)" }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>Loading all active orchestrators…</div>
                    <div style={{ marginTop: 16, width: 40, height: 40, border: "3px solid rgba(100,160,255,0.15)", borderTopColor: "#64a0ff", borderRadius: "50%", margin: "16px auto", animation: "spin 0.8s linear infinite" }} />
                  </div>
                )}

                {orchData && (
                  <>
                    {/* Protocol stats banner */}
                    {protocolData && (
                      <GlassCard style={{ padding: "16px 24px", marginBottom: 12, ...fadeStyle(0) }}>
                        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", justifyContent: "center" }}>
                          {[
                            { label: "Round", value: `#${protocolData.currentRound}`, color: "rgba(255,255,255,0.6)" },
                            { label: "Inflation", value: `${(protocolData.inflation / 10000000).toFixed(4)}%/round`, color: "#ffb84d" },
                            { label: "Participation", value: `${(protocolData.participationRate * 100).toFixed(1)}%`, color: "#00e88c" },
                            { label: "Total Active Stake", value: `${fmtN(protocolData.totalActiveStake, 0)} LPT`, color: "#64a0ff" },
                            { label: "LPT/ETH", value: fmtN(protocolData.lptPriceEth, 6), color: "#c77dff" },
                          ].map((s) => (
                            <div key={s.label} style={{ textAlign: "center" }}>
                              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{s.label}</div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: s.color, fontFamily: "'Space Mono', monospace", marginTop: 2 }}>{s.value}</div>
                            </div>
                          ))}
                        </div>
                      </GlassCard>
                    )}

                    {/* Summary callout */}
                    <GlassCard style={{ padding: "20px 24px", marginBottom: 16, ...fadeStyle(50) }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Your Orchestrator</div>
                          <div style={{ fontSize: 14, fontFamily: "'Space Mono', monospace", color: "rgba(255,255,255,0.6)" }}>
                            {orchDisplay(currentOrchId || "")}
                            {currentOrchRank > 0 && (
                              <span style={{ marginLeft: 12, fontSize: 12, color: "#00e88c", fontWeight: 700 }}>
                                Rank #{currentOrchRank} of {filteredOrchs.length} {orchFilter === "working" ? "working" : "active"}
                              </span>
                            )}
                          </div>
                          {/* Share URL */}
                          {wallet && (
                            <button
                              onClick={() => { navigator.clipboard.writeText(window.location.href); }}
                              style={{ marginTop: 6, padding: "3px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.08)", background: "transparent", color: "rgba(255,255,255,0.3)", fontSize: 9, cursor: "pointer", fontWeight: 600, letterSpacing: "0.04em" }}
                            >
                              Copy share link
                            </button>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 16 }}>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>Working</div>
                            <div style={{ fontSize: 18, fontWeight: 800, color: "#00e88c", fontFamily: "'Space Mono', monospace" }}>{workingCount}</div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>Total Active</div>
                            <div style={{ fontSize: 18, fontWeight: 800, color: "rgba(255,255,255,0.4)", fontFamily: "'Space Mono', monospace" }}>{orchData.length}</div>
                          </div>
                        </div>
                      </div>
                    </GlassCard>

                    {/* Filter chips + simulator + CSV export */}
                    <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap", alignItems: "center", ...fadeStyle(100) }}>
                      <ChipTab label={`Working (${workingCount})`} active={orchFilter === "working"} onClick={() => setOrchFilter("working")} color="#00e88c" />
                      <ChipTab label={`All Active (${orchData.length})`} active={orchFilter === "all"} onClick={() => setOrchFilter("all")} color="#64a0ff" />
                      <div style={{ flex: 1 }} />
                      {/* Simulator */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Simulate:</span>
                        <input
                          type="number"
                          value={simCustom ? simStake : bondedAmount}
                          onChange={(e) => { setSimStake(Number(e.target.value) || 0); setSimCustom(true); }}
                          onFocus={() => { if (!simCustom) { setSimStake(bondedAmount); setSimCustom(true); } }}
                          style={{
                            width: 90, padding: "4px 8px", borderRadius: 6,
                            background: "rgba(255,255,255,0.04)", border: simCustom ? "1px solid rgba(255,184,77,0.3)" : "1px solid rgba(255,255,255,0.08)",
                            color: simCustom ? "#ffb84d" : "rgba(255,255,255,0.5)", fontSize: 11, fontFamily: "'Space Mono', monospace",
                            outline: "none", textAlign: "right",
                          }}
                        />
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>LPT</span>
                        {simCustom && (
                          <button onClick={() => { setSimCustom(false); setSimStake(bondedAmount); }} style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid rgba(255,255,255,0.08)", background: "transparent", color: "rgba(255,255,255,0.3)", fontSize: 9, cursor: "pointer" }}>
                            Reset
                          </button>
                        )}
                      </div>
                      {/* CSV Export */}
                      <button
                        onClick={() => exportCSV(filteredOrchs, ensNames, effectiveStake)}
                        style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.08)", background: "transparent", color: "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: 700, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase" }}
                      >
                        Export CSV
                      </button>
                    </div>

                    {/* Scatter plot: APY vs ETH yield */}
                    <GlassCard style={{ padding: "24px 28px", marginBottom: 16, ...fadeStyle(150) }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>
                        Reward APY vs ETH Yield
                      </div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", marginBottom: 16 }}>
                        Top-right = best of both worlds. Green dot = your orchestrator.
                      </div>
                      <ResponsiveContainer width="100%" height={300}>
                        <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
                          <XAxis
                            type="number" dataKey="rewardAPY" name="Reward APY"
                            unit="%"
                            tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9, fontFamily: "Space Mono" }}
                            axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                            tickLine={false}
                            label={{ value: "Reward APY %", position: "insideBottom", offset: -5, style: { fill: "rgba(255,255,255,0.2)", fontSize: 10 } }}
                          />
                          <YAxis
                            type="number" dataKey="ethYieldPerLPT" name="ETH/LPT/yr"
                            tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 9, fontFamily: "Space Mono" }}
                            axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                            tickLine={false}
                            width={60}
                            tickFormatter={(v) => v.toFixed(4)}
                            label={{ value: "ETH / LPT / yr", angle: -90, position: "insideLeft", offset: 5, style: { fill: "rgba(255,255,255,0.2)", fontSize: 10 } }}
                          />
                          <Tooltip
                            content={({ active, payload }) => {
                              if (!active || !payload?.length) return null;
                              const d = payload[0]?.payload;
                              if (!d) return null;
                              const isCurrent = d.id === currentOrchId;
                              const stk = effectiveStake;
                              return (
                                <div style={{ background: "rgba(6,6,14,0.95)", border: `1px solid ${isCurrent ? "rgba(0,232,140,0.3)" : "rgba(255,255,255,0.08)"}`, borderRadius: 10, padding: "12px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.5)", maxWidth: 280 }}>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: isCurrent ? "#00e88c" : "#64a0ff", marginBottom: 2, fontFamily: "'Space Mono', monospace" }}>
                                    {orchDisplay(d.id)} {isCurrent ? " (yours)" : ""}
                                  </div>
                                  {ensNames[d.id] && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", marginBottom: 6, fontFamily: "'Space Mono', monospace" }}>{fmtAddr(d.id)}</div>}
                                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.8 }}>
                                    <div>Reward APY: <span style={{ color: "#fff", fontWeight: 700 }}>{d.rewardAPY.toFixed(2)}%</span></div>
                                    <div>ETH/LPT/yr: <span style={{ color: "#c77dff", fontWeight: 700 }}>{d.ethYieldPerLPT.toFixed(6)}</span></div>
                                    <div>Reward Cut: {(d.rewardCut / 10000).toFixed(2)}% · Fee Share: {(d.feeShare / 10000).toFixed(2)}%</div>
                                    <div>Stake: {fmtN(d.stake)} LPT · 30d Fees: {fmtN(d.eth30d, 4)} ETH</div>
                                    <div>Calling reward: <span style={{ color: d.callingReward ? "#00e88c" : "#ff5c5c" }}>{d.callingReward ? "Yes" : "No"}</span></div>
                                    {stk > 0 && (
                                      <>
                                        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", marginTop: 6, paddingTop: 6, fontSize: 10, color: "rgba(255,255,255,0.3)" }}>With {fmtN(stk)} LPT{simCustom ? " (simulated)" : ""}:</div>
                                        <div>Est. LPT/yr: <span style={{ color: "#00e88c" }}>{fmtN(stk * d.rewardAPY / 100)}</span></div>
                                        <div>Est. ETH/yr: <span style={{ color: "#c77dff" }}>{(stk * d.ethYieldPerLPT).toFixed(6)}</span></div>
                                      </>
                                    )}
                                  </div>
                                </div>
                              );
                            }}
                          />
                          <Scatter
                            data={filteredOrchs}
                            shape={(props) => {
                              const { cx, cy, payload } = props;
                              const isCurrent = payload.id === currentOrchId;
                              return (
                                <circle
                                  cx={cx} cy={cy}
                                  r={isCurrent ? 8 : 4}
                                  fill={isCurrent ? "#00e88c" : "#64a0ff"}
                                  fillOpacity={isCurrent ? 1 : 0.5}
                                  stroke={isCurrent ? "#00e88c" : "none"}
                                  strokeWidth={isCurrent ? 2 : 0}
                                  style={{ cursor: "pointer", filter: isCurrent ? "drop-shadow(0 0 6px rgba(0,232,140,0.5))" : "none" }}
                                />
                              );
                            }}
                          />
                        </ScatterChart>
                      </ResponsiveContainer>
                    </GlassCard>

                    {/* Leaderboard table */}
                    <GlassCard style={{ padding: "24px 28px", ...fadeStyle(250) }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>
                        Orchestrator Leaderboard — {filteredOrchs.length} orchestrators
                        {simCustom && <span style={{ color: "#ffb84d", marginLeft: 8 }}>· Simulating {fmtN(simStake, 0)} LPT</span>}
                      </div>
                      <div style={{ overflowX: "auto", maxHeight: 600, overflowY: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Space Mono', monospace", fontSize: 11 }}>
                          <thead style={{ position: "sticky", top: 0, zIndex: 2, background: "rgba(6,6,14,0.98)", backdropFilter: "blur(8px)" }}>
                            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                              {[
                                { col: "rank", label: "#", align: "center" },
                                { col: "id", label: "Orchestrator", align: "left" },
                                { col: "rewardAPY", label: "Reward APY", align: "right" },
                                { col: "eth30d", label: "30d ETH Fees", align: "right" },
                                { col: "ethYieldPerLPT", label: "ETH/LPT/yr", align: "right" },
                                { col: "rewardCut", label: "Reward Cut", align: "right" },
                                { col: "feeShare", label: "Fee Share", align: "right" },
                                { col: "stake", label: "Total Stake", align: "right" },
                                { col: "sparkline", label: "30d Trend", align: "center" },
                                ...(effectiveStake > 0 ? [
                                  { col: "estLPT", label: "Est. LPT/yr", align: "right" },
                                  { col: "estETH", label: "Est. ETH/yr", align: "right" },
                                ] : []),
                              ].map((h) => {
                                const sortable = !["rank", "id", "estLPT", "estETH", "sparkline"].includes(h.col);
                                return (
                                  <th
                                    key={h.col}
                                    onClick={() => sortable && setOrchSort((s) => ({ col: h.col, dir: s.col === h.col && s.dir === "desc" ? "asc" : "desc" }))}
                                    style={{
                                      padding: "8px 10px", textAlign: h.align,
                                      color: orchSort.col === h.col ? "#64a0ff" : "rgba(255,255,255,0.3)",
                                      fontWeight: 600, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em",
                                      cursor: sortable ? "pointer" : "default",
                                      whiteSpace: "nowrap", userSelect: "none",
                                    }}
                                  >
                                    {h.label}{orchSort.col === h.col ? (orchSort.dir === "desc" ? " ↓" : " ↑") : ""}
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody>
                            {filteredOrchs.map((o, i) => {
                              const isCurrent = o.id === currentOrchId;
                              const rowBg = isCurrent ? "rgba(0,232,140,0.06)" : "transparent";
                              const hoverBg = isCurrent ? "rgba(0,232,140,0.1)" : "rgba(100,160,255,0.03)";
                              return (
                                <tr
                                  key={o.id}
                                  style={{ borderBottom: "1px solid rgba(255,255,255,0.025)", background: rowBg, transition: "background 0.2s" }}
                                  onMouseEnter={(e) => (e.currentTarget.style.background = hoverBg)}
                                  onMouseLeave={(e) => (e.currentTarget.style.background = rowBg)}
                                >
                                  <td style={{ padding: "12px 10px", textAlign: "center", color: "rgba(255,255,255,0.3)", fontSize: 10 }}>{i + 1}</td>
                                  <td style={{ padding: "12px 10px", whiteSpace: "nowrap" }}>
                                    <span style={{ color: isCurrent ? "#00e88c" : ensNames[o.id] ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.5)" }}>{orchDisplay(o.id)}</span>
                                    {isCurrent && <span style={{ marginLeft: 8, fontSize: 8, fontWeight: 700, color: "#00e88c", background: "rgba(0,232,140,0.15)", padding: "2px 6px", borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>yours</span>}
                                    {!o.isWorking && <span style={{ marginLeft: 6, fontSize: 8, color: "rgba(255,255,255,0.2)" }}>idle</span>}
                                    {/* Reward calling indicator */}
                                    <span style={{ marginLeft: 6, fontSize: 7, color: o.callingReward ? "#00e88c" : "#ff5c5c", verticalAlign: "middle" }} title={o.callingReward ? "Calling reward this round" : "Not calling reward"}>
                                      {o.callingReward ? "●" : "○"}
                                    </span>
                                  </td>
                                  <td style={{ padding: "12px 10px", textAlign: "right", color: "#00e88c", fontWeight: 700 }}>{o.rewardAPY.toFixed(2)}%</td>
                                  <td style={{ padding: "12px 10px", textAlign: "right", color: o.eth30d > 0 ? "#c77dff" : "rgba(255,255,255,0.15)" }}>{o.eth30d > 0 ? fmtN(o.eth30d, 4) : "0"}</td>
                                  <td style={{ padding: "12px 10px", textAlign: "right", color: o.ethYieldPerLPT > 0 ? "rgba(199,125,255,0.7)" : "rgba(255,255,255,0.15)", fontSize: 10 }}>{o.ethYieldPerLPT > 0 ? o.ethYieldPerLPT.toFixed(6) : "—"}</td>
                                  <td style={{ padding: "12px 10px", textAlign: "right", color: "rgba(255,255,255,0.4)" }}>{(o.rewardCut / 10000).toFixed(2)}%</td>
                                  <td style={{ padding: "12px 10px", textAlign: "right", color: "rgba(255,255,255,0.4)" }}>{(o.feeShare / 10000).toFixed(2)}%</td>
                                  <td style={{ padding: "12px 10px", textAlign: "right", color: "rgba(255,255,255,0.4)" }}>{fmtN(o.stake, 0)}</td>
                                  {/* Sparkline */}
                                  <td style={{ padding: "4px 6px", textAlign: "center" }}>
                                    {o.sparkline && o.sparkline.length > 1 ? (
                                      <LineChart width={70} height={28} data={o.sparkline}>
                                        <Line type="monotone" dataKey="v" stroke={o.sparkline[o.sparkline.length - 1].v >= o.sparkline[0].v ? "#00e88c" : "#ff5c5c"} strokeWidth={1.5} dot={false} />
                                      </LineChart>
                                    ) : (
                                      <span style={{ fontSize: 9, color: "rgba(255,255,255,0.1)" }}>—</span>
                                    )}
                                  </td>
                                  {effectiveStake > 0 && (
                                    <>
                                      <td style={{ padding: "12px 10px", textAlign: "right", color: simCustom ? "rgba(255,184,77,0.7)" : "rgba(0,232,140,0.6)", fontWeight: 600 }}>{fmtN(effectiveStake * o.rewardAPY / 100)}</td>
                                      <td style={{ padding: "12px 10px", textAlign: "right", color: o.ethYieldPerLPT > 0 ? (simCustom ? "rgba(255,184,77,0.6)" : "rgba(199,125,255,0.6)") : "rgba(255,255,255,0.1)", fontWeight: 600 }}>{o.ethYieldPerLPT > 0 ? (effectiveStake * o.ethYieldPerLPT).toFixed(6) : "—"}</td>
                                    </>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </GlassCard>
                  </>
                )}
              </>
            )}

            {/* Footer */}
            <div style={{ textAlign: "center", padding: "28px 0 12px", fontSize: 10, color: "rgba(255,255,255,0.15)", ...fadeStyle(400) }}>
              Data from Livepeer Subgraph via The Graph · Built by{" "}
              <a href="https://github.com/PaulieB14" target="_blank" rel="noopener" style={{ color: "rgba(0,232,140,0.4)", textDecoration: "none" }}>PaulieB14</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
