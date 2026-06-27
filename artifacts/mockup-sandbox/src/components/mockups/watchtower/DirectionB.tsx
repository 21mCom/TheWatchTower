import { useState } from "react";

type Screen = "dashboard" | "addresses" | "activity" | "settings";

const ADDRESSES = [
  { label: "Cold Storage — Main", address: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", balance: "2.48371", lastSeen: "12 minutes ago", status: "active", trend: "in", alerts: 3 },
  { label: "Lightning Channel Reserve", address: "bc1q9d3xa5gg45q2j39uyf2b8m9j9j7g5f8p6jkx7m", balance: "0.10000", lastSeen: "1h 44m ago", status: "quiet", trend: null, alerts: 0 },
  { label: "Exchange Withdraw — Kraken", address: "3FZbgi29cpjq2GjdwV8eyHuJJnkLtktZc5", balance: "0.00000", lastSeen: "6h 02m ago", status: "quiet", trend: "out", alerts: 1 },
  { label: "Savings — Hardware Wallet", address: "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h", balance: "5.00000", lastSeen: "3 days ago", status: "quiet", trend: null, alerts: 0 },
  { label: "DCA — Strike Auto", address: "bc1pxwkm4m7k5j9f2rqwg5n3v4c0d8e7h6j5k4l3m2", balance: "0.35221", lastSeen: "21h ago", status: "active", trend: "in", alerts: 7 },
  { label: "Multisig — Estate Plan", address: "bc1qn3n7q8rj5y6x4w3v2u1t0s9r8q7p6o5n4m3l2k", balance: "10.00000", lastSeen: "12 days ago", status: "quiet", trend: null, alerts: 0 },
  { label: "Mining Payout — F2Pool", address: "1BpEi6DfDAUFd153wiGrvkiKW1J1EcMPa4", balance: "0.07813", lastSeen: "4h 15m ago", status: "active", trend: "in", alerts: 2 },
];

const ACTIVITY = [
  { id: "a1", label: "Cold Storage — Main", type: "incoming", amount: "0.05000", txid: "3f7d2a8e...c4e8b1", time: "12 minutes ago", state: "mempool" },
  { id: "a2", label: "DCA — Strike Auto", type: "incoming", amount: "0.00221", txid: "8a1c3f2d...d5f920", time: "21 hours ago", state: "confirmed" },
  { id: "a3", label: "Exchange Withdraw — Kraken", type: "outgoing", amount: "0.10000", txid: "2d4e6c1a...a8b012", time: "6 hours ago", state: "confirmed" },
  { id: "a4", label: "Mining Payout — F2Pool", type: "incoming", amount: "0.07813", txid: "c9f1a3b7...e7d245", time: "4 hours ago", state: "confirmed" },
  { id: "a5", label: "Cold Storage — Main", type: "incoming", amount: "0.10000", txid: "1a2b3c4d...4d5e6f", time: "2 days ago", state: "confirmed" },
];

const TEAL = "#0D9488";
const TEAL_LIGHT = "#CCFBF1";
const TEAL_DIM = "#99F6E4";

export default function DirectionB() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [addOpen, setAddOpen] = useState(false);
  const [nodeStatus, setNodeStatus] = useState<"connected" | "disconnected">("connected");

  return (
    <div style={{ background: "#F8FAF9", color: "#1A2E2A", fontFamily: "'Inter', 'Helvetica Neue', sans-serif", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top Bar */}
      <div style={{ background: "#FFFFFF", borderBottom: "1px solid #E5EDEB", padding: "0 32px", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 28, height: 28, background: TEAL, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: "#fff", fontWeight: 700 }}>₿</div>
          <span style={{ fontWeight: 700, fontSize: 16, color: "#1A2E2A", letterSpacing: "-0.01em" }}>Watchtower</span>
        </div>
        <button
          onClick={() => setNodeStatus(s => s === "connected" ? "disconnected" : "connected")}
          style={{ display: "flex", alignItems: "center", gap: 8, background: "transparent", border: `1px solid ${nodeStatus === "connected" ? "#BBF7D0" : "#FECACA"}`, borderRadius: 20, padding: "5px 12px", cursor: "pointer" }}
        >
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: nodeStatus === "connected" ? "#22C55E" : "#EF4444" }} />
          <span style={{ fontSize: 12, color: nodeStatus === "connected" ? "#15803D" : "#DC2626", fontWeight: 500 }}>
            {nodeStatus === "connected" ? "Node connected" : "Node offline"}
          </span>
        </button>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar */}
        <div style={{ width: 220, background: "#FFFFFF", borderRight: "1px solid #E5EDEB", display: "flex", flexDirection: "column", padding: "28px 16px", flexShrink: 0 }}>
          {(["dashboard", "addresses", "activity", "settings"] as Screen[]).map(s => {
            const icons: Record<Screen, string> = { dashboard: "◆", addresses: "◎", activity: "◉", settings: "◈" };
            const labels: Record<Screen, string> = { dashboard: "Dashboard", addresses: "Addresses", activity: "Activity", settings: "Settings" };
            const active = screen === s;
            return (
              <button
                key={s}
                onClick={() => setScreen(s)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: active ? TEAL_LIGHT : "transparent",
                  border: "none",
                  borderRadius: 8,
                  padding: "10px 14px",
                  fontSize: 13,
                  color: active ? TEAL : "#64867E",
                  fontWeight: active ? 600 : 400,
                  cursor: "pointer",
                  width: "100%",
                  textAlign: "left",
                  marginBottom: 2,
                  transition: "all 0.15s",
                }}
              >
                <span style={{ fontSize: 11, opacity: 0.8 }}>{icons[s]}</span>
                {labels[s]}
              </button>
            );
          })}

          <div style={{ marginTop: "auto", background: "#F0FAF8", borderRadius: 10, padding: "16px", border: `1px solid ${TEAL_LIGHT}` }}>
            <div style={{ fontSize: 11, color: "#64867E", marginBottom: 4 }}>Watching</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: TEAL, lineHeight: 1 }}>7</div>
            <div style={{ fontSize: 11, color: "#64867E", marginTop: 2 }}>addresses</div>
          </div>
        </div>

        {/* Main Content */}
        <div style={{ flex: 1, overflow: "auto", padding: "32px 36px" }}>

          {/* DASHBOARD */}
          {screen === "dashboard" && (
            <div>
              <div style={{ marginBottom: 28 }}>
                <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A2E2A", margin: 0, letterSpacing: "-0.02em" }}>Overview</h1>
                <p style={{ fontSize: 13, color: "#64867E", margin: "4px 0 0 0" }}>7 addresses · last checked 12 seconds ago</p>
              </div>

              {/* Stats */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 32 }}>
                {[
                  { label: "Total balance", value: "18.01 BTC", sub: "≈ $1,188,660 USD", color: TEAL },
                  { label: "Alerts sent", value: "13", sub: "in the last 30 days", color: "#6366F1" },
                  { label: "Active addresses", value: "3", sub: "received or sent recently", color: "#F59E0B" },
                ].map(s => (
                  <div key={s.label} style={{ background: "#FFFFFF", borderRadius: 12, padding: "20px 22px", border: "1px solid #E5EDEB" }}>
                    <div style={{ fontSize: 12, color: "#64867E", marginBottom: 8 }}>{s.label}</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: s.color, letterSpacing: "-0.02em" }}>{s.value}</div>
                    <div style={{ fontSize: 12, color: "#9DB5AF", marginTop: 2 }}>{s.sub}</div>
                  </div>
                ))}
              </div>

              {/* Address List */}
              <div>
                <h2 style={{ fontSize: 14, fontWeight: 600, color: "#1A2E2A", margin: "0 0 14px 0", letterSpacing: "-0.01em" }}>Watched Addresses</h2>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {ADDRESSES.map((a, i) => (
                    <div key={i} style={{ background: "#FFFFFF", borderRadius: 10, padding: "16px 20px", border: "1px solid #E5EDEB", display: "flex", alignItems: "center", gap: 16, transition: "box-shadow 0.15s", cursor: "pointer" }}
                      onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 2px 12px rgba(13,148,136,0.08)")}
                      onMouseLeave={e => (e.currentTarget.style.boxShadow = "none")}
                    >
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: a.status === "active" ? "#22C55E" : "#D1D5DB", flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#1A2E2A" }}>{a.label}</div>
                        <div style={{ fontSize: 11, color: "#9DB5AF", marginTop: 2, fontFamily: "'JetBrains Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {a.address.slice(0, 28)}…
                        </div>
                      </div>
                      {a.trend && (
                        <div style={{ fontSize: 12, color: a.trend === "in" ? "#15803D" : "#DC2626", background: a.trend === "in" ? "#F0FDF4" : "#FEF2F2", padding: "3px 8px", borderRadius: 5, fontWeight: 500 }}>
                          {a.trend === "in" ? "↑ incoming" : "↓ outgoing"}
                        </div>
                      )}
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: TEAL }}>{a.balance} BTC</div>
                        <div style={{ fontSize: 11, color: "#9DB5AF" }}>{a.lastSeen}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ADDRESSES */}
          {screen === "addresses" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
                <div>
                  <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A2E2A", margin: 0, letterSpacing: "-0.02em" }}>Addresses</h1>
                  <p style={{ fontSize: 13, color: "#64867E", margin: "4px 0 0 0" }}>Add and manage Bitcoin addresses to watch</p>
                </div>
                <button onClick={() => setAddOpen(!addOpen)} style={{ background: TEAL, border: "none", color: "#fff", fontSize: 13, padding: "9px 18px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>
                  + Add address
                </button>
              </div>

              {addOpen && (
                <div style={{ background: "#FFFFFF", borderRadius: 12, padding: 24, marginBottom: 20, border: `1px solid ${TEAL_DIM}`, boxShadow: `0 0 0 3px ${TEAL_LIGHT}` }}>
                  <h3 style={{ margin: "0 0 18px 0", fontSize: 15, fontWeight: 600, color: "#1A2E2A" }}>Watch a new address</h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 500, color: "#1A2E2A", display: "block", marginBottom: 6 }}>Label</label>
                      <input placeholder="e.g. Cold Storage — Main" style={{ background: "#F8FAF9", border: "1px solid #D1D5DB", borderRadius: 7, color: "#1A2E2A", fontSize: 13, padding: "9px 12px", width: "100%", outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} readOnly />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 500, color: "#1A2E2A", display: "block", marginBottom: 6 }}>Bitcoin address</label>
                      <input placeholder="bc1q… or 1… or 3…" style={{ background: "#F8FAF9", border: "1px solid #D1D5DB", borderRadius: 7, color: "#1A2E2A", fontSize: 13, padding: "9px 12px", width: "100%", outline: "none", boxSizing: "border-box", fontFamily: "'JetBrains Mono', monospace" }} readOnly />
                    </div>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button onClick={() => setAddOpen(false)} style={{ background: "transparent", border: "1px solid #D1D5DB", color: "#64867E", fontSize: 13, padding: "8px 16px", borderRadius: 7, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                      <button style={{ background: TEAL, border: "none", color: "#fff", fontSize: 13, padding: "8px 16px", borderRadius: 7, cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>Start watching</button>
                    </div>
                  </div>
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {ADDRESSES.map((a, i) => (
                  <div key={i} style={{ background: "#FFFFFF", borderRadius: 10, padding: "16px 20px", border: "1px solid #E5EDEB", display: "flex", alignItems: "center", gap: 16 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: a.status === "active" ? "#22C55E" : "#D1D5DB", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#1A2E2A" }}>{a.label}</div>
                      <div style={{ fontSize: 11, color: "#9DB5AF", fontFamily: "'JetBrains Mono', monospace", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.address}</div>
                    </div>
                    <div style={{ textAlign: "right", marginRight: 12, flexShrink: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: TEAL }}>{a.balance} BTC</div>
                      <div style={{ fontSize: 11, color: "#9DB5AF" }}>{a.lastSeen}</div>
                    </div>
                    <button style={{ background: "#F8FAF9", border: "1px solid #E5EDEB", color: "#64867E", fontSize: 12, padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>Edit</button>
                    <button style={{ background: "#FEF2F2", border: "1px solid #FECACA", color: "#DC2626", fontSize: 12, padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>Remove</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ACTIVITY */}
          {screen === "activity" && (
            <div>
              <div style={{ marginBottom: 28 }}>
                <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A2E2A", margin: 0, letterSpacing: "-0.02em" }}>Alert History</h1>
                <p style={{ fontSize: 13, color: "#64867E", margin: "4px 0 0 0" }}>All detected movements and XMPP alerts</p>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {ACTIVITY.map(a => (
                  <div key={a.id} style={{ background: "#FFFFFF", borderRadius: 12, padding: "20px 24px", border: "1px solid #E5EDEB" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{
                          width: 34, height: 34, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14,
                          background: a.type === "incoming" ? "#F0FDF4" : "#FEF2F2",
                          color: a.type === "incoming" ? "#15803D" : "#DC2626",
                        }}>
                          {a.type === "incoming" ? "↑" : "↓"}
                        </div>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: "#1A2E2A" }}>{a.label}</div>
                          <div style={{ fontSize: 11, color: "#9DB5AF", marginTop: 2 }}>{a.type === "incoming" ? "Incoming transaction" : "Outgoing transaction"}</div>
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 18, fontWeight: 700, color: a.type === "incoming" ? "#15803D" : "#DC2626", letterSpacing: "-0.01em" }}>
                          {a.type === "incoming" ? "+" : "−"}{a.amount} BTC
                        </div>
                        <div style={{ fontSize: 11, color: "#9DB5AF", marginTop: 2 }}>{a.time}</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11, color: "#9DB5AF", fontFamily: "'JetBrains Mono', monospace" }}>txid: {a.txid}</span>
                      <span style={{ marginLeft: "auto" }} />
                      <span style={{
                        fontSize: 11, padding: "3px 8px", borderRadius: 5, fontWeight: 500,
                        background: a.state === "mempool" ? "#FFFBEB" : "#F0FDF4",
                        color: a.state === "mempool" ? "#D97706" : "#15803D",
                        border: `1px solid ${a.state === "mempool" ? "#FDE68A" : "#BBF7D0"}`,
                      }}>
                        {a.state === "mempool" ? "Pending (mempool)" : "Confirmed"}
                      </span>
                      <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, background: TEAL_LIGHT, color: TEAL, border: `1px solid ${TEAL_DIM}`, fontWeight: 500 }}>
                        XMPP sent
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SETTINGS */}
          {screen === "settings" && (
            <div>
              <div style={{ marginBottom: 28 }}>
                <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1A2E2A", margin: 0, letterSpacing: "-0.02em" }}>Settings</h1>
                <p style={{ fontSize: 13, color: "#64867E", margin: "4px 0 0 0" }}>Configure your node connection and XMPP account</p>
              </div>

              {/* Node */}
              <div style={{ background: "#FFFFFF", borderRadius: 12, padding: 24, marginBottom: 16, border: "1px solid #E5EDEB" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
                  <h2 style={{ fontSize: 15, fontWeight: 600, color: "#1A2E2A", margin: 0 }}>Node Connection</h2>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: nodeStatus === "connected" ? "#22C55E" : "#EF4444" }} />
                    <span style={{ fontSize: 12, color: nodeStatus === "connected" ? "#15803D" : "#DC2626", fontWeight: 500 }}>
                      {nodeStatus === "connected" ? "Block 840,212" : "Unreachable"}
                    </span>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  {[["Electrum host", "localhost"], ["Electrum port", "50001"], ["Protocol", "TCP"], ["Confirmation threshold", "1 block"]].map(([label, val]) => (
                    <div key={label}>
                      <label style={{ fontSize: 12, fontWeight: 500, color: "#1A2E2A", display: "block", marginBottom: 6 }}>{label}</label>
                      <input defaultValue={val} style={{ background: "#F8FAF9", border: "1px solid #E5EDEB", borderRadius: 7, color: "#1A2E2A", fontSize: 13, padding: "9px 12px", width: "100%", outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} readOnly />
                    </div>
                  ))}
                </div>
              </div>

              {/* XMPP */}
              <div style={{ background: "#FFFFFF", borderRadius: 12, padding: 24, marginBottom: 16, border: "1px solid #E5EDEB" }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, color: "#1A2E2A", margin: "0 0 18px 0" }}>XMPP Account</h2>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  {[["XMPP server", "jabber.example.com"], ["Your JID (sender)", "watchtower@jabber.example.com"], ["Password", ""], ["Recipient JID", "you@jabber.example.com"]].map(([label, val]) => (
                    <div key={label}>
                      <label style={{ fontSize: 12, fontWeight: 500, color: "#1A2E2A", display: "block", marginBottom: 6 }}>{label}</label>
                      <input defaultValue={val} type={label === "Password" ? "password" : "text"} placeholder={label === "Password" ? "••••••••••" : undefined} style={{ background: "#F8FAF9", border: "1px solid #E5EDEB", borderRadius: 7, color: "#1A2E2A", fontSize: 13, padding: "9px 12px", width: "100%", outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} readOnly />
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
                  <button style={{ background: "#F0FAF8", border: `1px solid ${TEAL_DIM}`, color: TEAL, fontSize: 13, padding: "9px 18px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>
                    Send test alert
                  </button>
                  <button style={{ background: TEAL, border: "none", color: "#fff", fontSize: 13, padding: "9px 18px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>
                    Save settings
                  </button>
                </div>
              </div>

              <p style={{ fontSize: 12, color: "#9DB5AF", lineHeight: 1.6 }}>
                Watchtower runs entirely on your Umbrel node. No address data leaves your device.
                All monitoring connects to your own Electrs or Fulcrum via the Electrum protocol.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
