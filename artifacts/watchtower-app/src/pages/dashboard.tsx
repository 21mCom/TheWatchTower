import { useListAddresses, useListActivity, getListActivityQueryKey } from "@workspace/api-client-react";
import { formatBtc, truncateAddress, formatTimeAgo } from "@/lib/format";

export default function Dashboard() {
  const { data: addresses } = useListAddresses();
  const { data: activityPage } = useListActivity(undefined, { query: { queryKey: getListActivityQueryKey(), refetchInterval: 30000 }});

  const addressesData = addresses || [];
  const events = activityPage?.events || [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontSize: 13, color: "var(--wt-text-muted)", letterSpacing: "0.1em", textTransform: "uppercase", margin: 0 }}>Monitor Overview</h1>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
        <div style={{ background: "var(--wt-card-bg)", border: "1px solid var(--wt-border)", borderRadius: 6, padding: "14px 16px" }}>
          <div style={{ fontSize: 10, color: "var(--wt-text-muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Watching</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#F7931A" }}>{addressesData.length}</div>
          <div style={{ fontSize: 10, color: "var(--wt-text-dim)", marginTop: 2 }}>addresses</div>
        </div>
        <div style={{ background: "var(--wt-card-bg)", border: "1px solid var(--wt-border)", borderRadius: 6, padding: "14px 16px" }}>
          <div style={{ fontSize: 10, color: "var(--wt-text-muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Recent Activity</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#22C55E" }}>{events.length}</div>
          <div style={{ fontSize: 10, color: "var(--wt-text-dim)", marginTop: 2 }}>recorded events</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        {/* Watched Addresses */}
        <div>
          <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Watched Addresses</div>
          <div style={{ background: "var(--wt-card-bg)", border: "1px solid var(--wt-border)", borderRadius: 6, overflow: "hidden" }}>
            {addressesData.length === 0 ? (
              <div style={{ padding: "20px", textAlign: "center", color: "var(--wt-text-muted)", fontSize: 12 }}>No addresses added yet.</div>
            ) : (
              addressesData.map((a, i) => (
                <div key={a.id} style={{ display: "flex", justifyContent: "space-between", padding: "10px 16px", borderBottom: i < addressesData.length - 1 ? "1px solid var(--wt-divider)" : "none" }}>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--wt-text)" }}>{a.label}</div>
                    <div style={{ fontSize: 10, color: "var(--wt-text-dim)" }}>{truncateAddress(a.address)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Alerts */}
        <div>
          <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Recent Activity</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {events.length === 0 ? (
              <div style={{ padding: "20px", textAlign: "center", color: "var(--wt-text-muted)", fontSize: 12, background: "var(--wt-card-bg)", border: "1px solid var(--wt-border)", borderRadius: 6 }}>No recent activity.</div>
            ) : (
              events.slice(0, 5).map(a => (
                <div key={a.id} style={{ background: "var(--wt-card-bg)", border: `1px solid ${a.direction === "incoming" ? "#14532D44" : "#7F1D1D44"}`, borderRadius: 5, padding: "8px 12px", display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 10, color: a.direction === "incoming" ? "#22C55E" : "#F87171", letterSpacing: "0.1em" }}>{a.direction === "incoming" ? "IN" : "OUT"}</span>
                  <span style={{ fontSize: 11, color: "var(--wt-text-secondary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.addressLabel || truncateAddress(a.address)}</span>
                  <span style={{ fontSize: 12, color: a.direction === "incoming" ? "#22C55E" : "#F87171", fontWeight: 600 }}>{a.direction === "incoming" ? "+" : "−"}{formatBtc(a.amountSats)}</span>
                  <span style={{ fontSize: 10, color: a.status === "mempool" ? "#FBBF24" : "#22C55E", padding: "2px 6px", border: `1px solid ${a.status === "mempool" ? "#FBBF2444" : "#22C55E44"}`, borderRadius: 3 }}>{a.status === "mempool" ? "MEMPOOL" : "CONF"}</span>
                  <span style={{ fontSize: 10, color: "var(--wt-text-dim)" }}>{formatTimeAgo(a.detectedAt)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
