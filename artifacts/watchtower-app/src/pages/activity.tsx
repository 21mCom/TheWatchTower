import { useState } from "react";
import { useListActivity, getListActivityQueryKey } from "@workspace/api-client-react";
import { formatBtc, truncateAddress, formatTimeAgo } from "@/lib/format";

export default function Activity() {
  const [filter, setFilter] = useState<"ALL" | "IN" | "OUT" | "MEMPOOL">("ALL");
  const { data: activityPage, isLoading } = useListActivity(undefined, { query: { queryKey: getListActivityQueryKey(), refetchInterval: 30000 }});

  let events = activityPage?.events || [];
  
  if (filter === "IN") events = events.filter(e => e.direction === "incoming");
  if (filter === "OUT") events = events.filter(e => e.direction === "outgoing");
  if (filter === "MEMPOOL") events = events.filter(e => e.status === "mempool");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontSize: 13, color: "var(--wt-text-muted)", letterSpacing: "0.1em", textTransform: "uppercase", margin: 0 }}>Alert History</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {["ALL", "IN", "OUT", "MEMPOOL"].map(f => (
            <button 
              key={f} 
              onClick={() => setFilter(f as any)}
              style={{ background: filter === f ? "#F7931A22" : "transparent", border: `1px solid ${filter === f ? "#F7931A" : "var(--wt-border)"}`, color: filter === f ? "#F7931A" : "var(--wt-text-muted)", fontFamily: "inherit", fontSize: 10, padding: "4px 10px", borderRadius: 3, cursor: "pointer", letterSpacing: "0.08em" }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {isLoading && <div style={{ padding: "20px", textAlign: "center", color: "var(--wt-text-muted)", fontSize: 12 }}>Loading activity...</div>}
        {!isLoading && events.length === 0 && (
          <div style={{ background: "var(--wt-card-bg)", border: "1px solid var(--wt-border)", borderRadius: 6, padding: "20px", textAlign: "center", color: "var(--wt-text-muted)", fontSize: 12 }}>No activity found.</div>
        )}
        {events.map(a => (
          <div key={a.id} style={{ background: "var(--wt-card-bg)", border: `1px solid ${a.direction === "incoming" ? "#14532D33" : "#7F1D1D33"}`, borderRadius: 6, padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: a.direction === "incoming" ? "#22C55E" : "#F87171", padding: "2px 8px", border: `1px solid ${a.direction === "incoming" ? "#22C55E44" : "#F8717144"}`, borderRadius: 3, letterSpacing: "0.1em" }}>
                {a.direction === "incoming" ? "▲ IN" : "▼ OUT"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: "var(--wt-text)" }}>{a.addressLabel || truncateAddress(a.address)}</span>
                {a.addressLabel && <span style={{ fontSize: 10, color: "var(--wt-text-dim)", marginLeft: 8 }}>{truncateAddress(a.address)}</span>}
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: a.direction === "incoming" ? "#22C55E" : "#F87171" }}>
                {a.direction === "incoming" ? "+" : "−"}{formatBtc(a.amountSats)}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 10, flexWrap: "wrap" }}>
              <span style={{ color: "var(--wt-text-dim)" }}>TXID:</span>
              <span style={{ color: "var(--wt-text-muted)", fontFamily: "inherit" }}>{a.txid}</span>
              <span style={{ marginLeft: "auto", color: a.status === "mempool" ? "#FBBF24" : "#22C55E", padding: "2px 6px", border: `1px solid ${a.status === "mempool" ? "#FBBF2444" : "#22C55E44"}`, borderRadius: 3, letterSpacing: "0.08em" }}>
                {a.status === "mempool" ? "⏳ MEMPOOL" : "✓ CONFIRMED"}
              </span>
              <span style={{ color: "var(--wt-text-dim)" }}>{formatTimeAgo(a.detectedAt)}</span>
              {(a.mempoolAlertedAt || a.confirmedAlertedAt) && (
                <span style={{ color: "#22C55E", padding: "2px 6px", border: "1px solid #22C55E33", borderRadius: 3 }}>XMPP SENT</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
