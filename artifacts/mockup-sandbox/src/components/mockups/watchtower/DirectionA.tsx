import { useState } from "react";

type Screen = "dashboard" | "addresses" | "activity" | "settings";

const ADDRESSES = [
  { label: "Cold Storage — Main", address: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", balance: "2.48371 BTC", lastSeen: "12 min ago", status: "active", alerts: 3, trend: "in" },
  { label: "Lightning Channel Reserve", address: "bc1q9d3xa5gg45q2j39uyf2b8m9j9j7g5f8p6jkx7m", balance: "0.10000 BTC", lastSeen: "1h 44m ago", status: "active", alerts: 0, trend: null },
  { label: "Exchange Withdraw — Kraken", address: "3FZbgi29cpjq2GjdwV8eyHuJJnkLtktZc5", balance: "0.00000 BTC", lastSeen: "6h 02m ago", status: "quiet", alerts: 1, trend: "out" },
  { label: "Savings — Hardware Wallet", address: "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h", balance: "5.00000 BTC", lastSeen: "3d 14h ago", status: "quiet", alerts: 0, trend: null },
  { label: "DCA — Strike Auto", address: "bc1pxwkm4m7k5j9f2rqwg5n3v4c0d8e7h6j5k4l3m2", balance: "0.35221 BTC", lastSeen: "21h ago", status: "active", alerts: 7, trend: "in" },
  { label: "Multisig — Estate Plan", address: "bc1qn3n7q8rj5y6x4w3v2u1t0s9r8q7p6o5n4m3l2k", balance: "10.00000 BTC", lastSeen: "12d ago", status: "quiet", alerts: 0, trend: null },
  { label: "Mining Payout — F2Pool", address: "1BpEi6DfDAUFd153wiGrvkiKW1J1EcMPa4", balance: "0.07813 BTC", lastSeen: "4h 15m ago", status: "active", alerts: 2, trend: "in" },
];

const ACTIVITY = [
  { id: "a1", label: "Cold Storage — Main", address: "bc1qxy2kgdygjrs...", type: "incoming", amount: "+0.05000 BTC", txid: "3f7d2a...c4e8b1", time: "12 min ago", state: "mempool", alert: "sent" },
  { id: "a2", label: "DCA — Strike Auto", address: "bc1pxwkm4m7k5j...", type: "incoming", amount: "+0.00221 BTC", txid: "8a1c3f...d5f920", time: "21h ago", state: "confirmed", alert: "sent" },
  { id: "a3", label: "Exchange Withdraw — Kraken", address: "3FZbgi29cpjq2G...", type: "outgoing", amount: "−0.10000 BTC", txid: "2d4e6c...a8b012", time: "6h 02m ago", state: "confirmed", alert: "sent" },
  { id: "a4", label: "Mining Payout — F2Pool", address: "1BpEi6DfDAUFd1...", type: "incoming", amount: "+0.07813 BTC", txid: "c9f1a3...e7d245", time: "4h 15m ago", state: "confirmed", alert: "sent" },
  { id: "a5", label: "Cold Storage — Main", address: "bc1qxy2kgdygjrs...", type: "incoming", amount: "+0.10000 BTC", txid: "1a2b3c...4d5e6f", time: "2d ago", state: "confirmed", alert: "sent" },
  { id: "a6", label: "DCA — Strike Auto", address: "bc1pxwkm4m7k5j...", type: "incoming", amount: "+0.00312 BTC", txid: "9e8d7c...6b5a43", time: "4d ago", state: "confirmed", alert: "sent" },
];

export default function DirectionA() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [addOpen, setAddOpen] = useState(false);
  const [nodeStatus, setNodeStatus] = useState<"connected" | "disconnected">("connected");

  return (
    <div style={{ background: "#0B0F17", color: "#E2E8F0", fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top Bar */}
      <div style={{ background: "#0D1320", borderBottom: "1px solid #1E2D40", padding: "0 24px", height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 20, height: 20, background: "#F7931A", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#000" }}>₿</div>
          <span style={{ color: "#F7931A", fontWeight: 700, fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase" }}>The Watchtower</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button
            onClick={() => setNodeStatus(s => s === "connected" ? "disconnected" : "connected")}
            style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
          >
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: nodeStatus === "connected" ? "#22C55E" : "#EF4444", boxShadow: nodeStatus === "connected" ? "0 0 6px #22C55E88" : "0 0 6px #EF444488" }} />
            <span style={{ fontSize: 11, color: nodeStatus === "connected" ? "#22C55E" : "#EF4444", letterSpacing: "0.08em" }}>
              {nodeStatus === "connected" ? "NODE CONNECTED" : "NODE OFFLINE"}
            </span>
          </button>
          <span style={{ fontSize: 11, color: "#4A5568", letterSpacing: "0.05em" }}>electrs:50001</span>
          <div style={{ fontSize: 11, color: "#4A5568", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ color: "#F7931A" }}>7</span>
            <span> alerts sent</span>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar Nav */}
        <div style={{ width: 180, background: "#0D1320", borderRight: "1px solid #1E2D40", display: "flex", flexDirection: "column", padding: "20px 0", flexShrink: 0 }}>
          {(["dashboard", "addresses", "activity", "settings"] as Screen[]).map(s => (
            <button
              key={s}
              onClick={() => setScreen(s)}
              style={{
                background: screen === s ? "#142030" : "transparent",
                border: "none",
                borderLeft: `3px solid ${screen === s ? "#F7931A" : "transparent"}`,
                color: screen === s ? "#F7931A" : "#4A6080",
                padding: "10px 20px",
                fontSize: 11,
                textAlign: "left",
                cursor: "pointer",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                fontFamily: "inherit",
                transition: "all 0.15s",
              }}
            >
              {s === "dashboard" ? "⬡ Dashboard" : s === "addresses" ? "◈ Addresses" : s === "activity" ? "◉ Activity" : "⚙ Settings"}
            </button>
          ))}
          <div style={{ marginTop: "auto", padding: "16px 20px", borderTop: "1px solid #1E2D40" }}>
            <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em" }}>WATCHING</div>
            <div style={{ fontSize: 20, color: "#E2E8F0", fontWeight: 700, marginTop: 2 }}>7</div>
            <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em" }}>ADDRESSES</div>
          </div>
        </div>

        {/* Main Content */}
        <div style={{ flex: 1, overflow: "auto", padding: 24 }}>

          {/* DASHBOARD */}
          {screen === "dashboard" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <h1 style={{ fontSize: 13, color: "#4A6080", letterSpacing: "0.1em", textTransform: "uppercase", margin: 0 }}>Monitor Overview</h1>
                <div style={{ fontSize: 11, color: "#2A4060" }}>Last sweep: <span style={{ color: "#22C55E" }}>12s ago</span></div>
              </div>

              {/* Stats Row */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
                {[
                  { label: "Watching", value: "7", sub: "addresses", color: "#F7931A" },
                  { label: "Total Balance", value: "18.01 BTC", sub: "≈ $1,188,660", color: "#22C55E" },
                  { label: "Alerts Sent", value: "13", sub: "last 30 days", color: "#60A5FA" },
                  { label: "Active Now", value: "3", sub: "with recent txs", color: "#A78BFA" },
                ].map(stat => (
                  <div key={stat.label} style={{ background: "#0D1320", border: "1px solid #1E2D40", borderRadius: 6, padding: "14px 16px" }}>
                    <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>{stat.label}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: stat.color }}>{stat.value}</div>
                    <div style={{ fontSize: 10, color: "#2A4060", marginTop: 2 }}>{stat.sub}</div>
                  </div>
                ))}
              </div>

              {/* Address Table */}
              <div style={{ background: "#0D1320", border: "1px solid #1E2D40", borderRadius: 6, overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 1fr 130px 100px 80px", gap: 0, padding: "8px 16px", borderBottom: "1px solid #1E2D40", fontSize: 10, color: "#2A4060", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  <div></div>
                  <div>Label</div>
                  <div>Address</div>
                  <div>Balance</div>
                  <div>Last Seen</div>
                  <div style={{ textAlign: "right" }}>Alerts</div>
                </div>
                {ADDRESSES.map((a, i) => (
                  <div
                    key={i}
                    style={{ display: "grid", gridTemplateColumns: "28px 1fr 1fr 130px 100px 80px", gap: 0, padding: "10px 16px", borderBottom: i < ADDRESSES.length - 1 ? "1px solid #111B28" : "none", alignItems: "center", cursor: "pointer", transition: "background 0.1s" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#0F1A28")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: a.status === "active" ? "#22C55E" : "#2A4060", boxShadow: a.status === "active" ? "0 0 5px #22C55E66" : "none" }} />
                    <div>
                      <div style={{ fontSize: 12, color: "#CBD5E1" }}>{a.label}</div>
                      {a.trend && (
                        <div style={{ fontSize: 10, color: a.trend === "in" ? "#22C55E" : "#F87171", marginTop: 1 }}>
                          {a.trend === "in" ? "▲ incoming" : "▼ outgoing"} · {a.alerts} alert{a.alerts !== 1 ? "s" : ""}
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: "#2A4060", fontFamily: "inherit" }}>{a.address.slice(0, 18)}…</div>
                    <div style={{ fontSize: 12, color: "#F7931A" }}>{a.balance}</div>
                    <div style={{ fontSize: 11, color: "#4A6080" }}>{a.lastSeen}</div>
                    <div style={{ textAlign: "right", fontSize: 12, color: a.alerts > 0 ? "#60A5FA" : "#2A4060" }}>
                      {a.alerts > 0 ? a.alerts : "—"}
                    </div>
                  </div>
                ))}
              </div>

              {/* Recent Alert Feed */}
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Recent Alerts</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {ACTIVITY.slice(0, 3).map(a => (
                    <div key={a.id} style={{ background: "#0D1320", border: `1px solid ${a.type === "incoming" ? "#14532D44" : "#7F1D1D44"}`, borderRadius: 5, padding: "8px 12px", display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontSize: 10, color: a.type === "incoming" ? "#22C55E" : "#F87171", letterSpacing: "0.1em" }}>{a.type === "incoming" ? "IN" : "OUT"}</span>
                      <span style={{ fontSize: 11, color: "#94A3B8", flex: 1 }}>{a.label}</span>
                      <span style={{ fontSize: 12, color: a.type === "incoming" ? "#22C55E" : "#F87171", fontWeight: 600 }}>{a.amount}</span>
                      <span style={{ fontSize: 10, color: a.state === "mempool" ? "#FBBF24" : "#22C55E", padding: "2px 6px", border: `1px solid ${a.state === "mempool" ? "#FBBF2444" : "#22C55E44"}`, borderRadius: 3 }}>{a.state === "mempool" ? "MEMPOOL" : "CONF"}</span>
                      <span style={{ fontSize: 10, color: "#2A4060" }}>{a.time}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ADDRESSES */}
          {screen === "addresses" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <h1 style={{ fontSize: 13, color: "#4A6080", letterSpacing: "0.1em", textTransform: "uppercase", margin: 0 }}>Watched Addresses</h1>
                <button
                  onClick={() => setAddOpen(!addOpen)}
                  style={{ background: "#F7931A", border: "none", color: "#000", fontSize: 11, fontFamily: "inherit", padding: "7px 14px", borderRadius: 4, cursor: "pointer", fontWeight: 700, letterSpacing: "0.08em" }}
                >
                  + ADD ADDRESS
                </button>
              </div>

              {addOpen && (
                <div style={{ background: "#0D1320", border: "1px solid #F7931A44", borderRadius: 6, padding: 20, marginBottom: 20 }}>
                  <div style={{ fontSize: 11, color: "#4A6080", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 14 }}>New Watched Address</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>LABEL</div>
                      <input placeholder="e.g. Cold Storage — Main" style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "8px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} readOnly />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>BITCOIN ADDRESS</div>
                      <input placeholder="bc1q... or 1... or 3..." style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "8px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} readOnly />
                    </div>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button onClick={() => setAddOpen(false)} style={{ background: "transparent", border: "1px solid #1E2D40", color: "#4A6080", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer" }}>CANCEL</button>
                      <button style={{ background: "#F7931A", border: "none", color: "#000", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer", fontWeight: 700 }}>WATCH</button>
                    </div>
                  </div>
                </div>
              )}

              <div style={{ background: "#0D1320", border: "1px solid #1E2D40", borderRadius: 6, overflow: "hidden" }}>
                {ADDRESSES.map((a, i) => (
                  <div key={i} style={{ padding: "14px 16px", borderBottom: i < ADDRESSES.length - 1 ? "1px solid #111B28" : "none", display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: a.status === "active" ? "#22C55E" : "#2A4060", flexShrink: 0, boxShadow: a.status === "active" ? "0 0 5px #22C55E66" : "none" }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: "#E2E8F0", marginBottom: 2 }}>{a.label}</div>
                      <div style={{ fontSize: 10, color: "#2A4060", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.address}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 12, color: "#F7931A" }}>{a.balance}</div>
                      <div style={{ fontSize: 10, color: "#4A6080" }}>{a.lastSeen}</div>
                    </div>
                    <button style={{ background: "transparent", border: "1px solid #1E2D40", borderRadius: 3, color: "#4A6080", fontFamily: "inherit", fontSize: 10, padding: "3px 8px", cursor: "pointer" }}>EDIT</button>
                    <button style={{ background: "transparent", border: "1px solid #7F1D1D44", borderRadius: 3, color: "#F87171", fontFamily: "inherit", fontSize: 10, padding: "3px 8px", cursor: "pointer" }}>RM</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ACTIVITY */}
          {screen === "activity" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <h1 style={{ fontSize: 13, color: "#4A6080", letterSpacing: "0.1em", textTransform: "uppercase", margin: 0 }}>Alert History</h1>
                <div style={{ display: "flex", gap: 8 }}>
                  {["ALL", "IN", "OUT", "MEMPOOL"].map(f => (
                    <button key={f} style={{ background: f === "ALL" ? "#F7931A22" : "transparent", border: `1px solid ${f === "ALL" ? "#F7931A" : "#1E2D40"}`, color: f === "ALL" ? "#F7931A" : "#4A6080", fontFamily: "inherit", fontSize: 10, padding: "4px 10px", borderRadius: 3, cursor: "pointer", letterSpacing: "0.08em" }}>{f}</button>
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {ACTIVITY.map(a => (
                  <div key={a.id} style={{ background: "#0D1320", border: `1px solid ${a.type === "incoming" ? "#14532D33" : "#7F1D1D33"}`, borderRadius: 6, padding: "14px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: a.type === "incoming" ? "#22C55E" : "#F87171", padding: "2px 8px", border: `1px solid ${a.type === "incoming" ? "#22C55E44" : "#F8717144"}`, borderRadius: 3, letterSpacing: "0.1em" }}>
                        {a.type === "incoming" ? "▲ IN" : "▼ OUT"}
                      </div>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 12, color: "#CBD5E1" }}>{a.label}</span>
                        <span style={{ fontSize: 10, color: "#2A4060", marginLeft: 8 }}>{a.address}</span>
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: a.type === "incoming" ? "#22C55E" : "#F87171" }}>{a.amount}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 10 }}>
                      <span style={{ color: "#2A4060" }}>TXID:</span>
                      <span style={{ color: "#4A6080", fontFamily: "inherit" }}>{a.txid}</span>
                      <span style={{ marginLeft: "auto", color: a.state === "mempool" ? "#FBBF24" : "#22C55E", padding: "2px 6px", border: `1px solid ${a.state === "mempool" ? "#FBBF2444" : "#22C55E44"}`, borderRadius: 3, letterSpacing: "0.08em" }}>
                        {a.state === "mempool" ? "⏳ MEMPOOL" : "✓ CONFIRMED"}
                      </span>
                      <span style={{ color: "#2A4060" }}>{a.time}</span>
                      <span style={{ color: "#22C55E", padding: "2px 6px", border: "1px solid #22C55E33", borderRadius: 3 }}>XMPP SENT</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SETTINGS */}
          {screen === "settings" && (
            <div>
              <h1 style={{ fontSize: 13, color: "#4A6080", letterSpacing: "0.1em", textTransform: "uppercase", margin: "0 0 20px 0" }}>Configuration</h1>

              {/* Node */}
              <div style={{ background: "#0D1320", border: "1px solid #1E2D40", borderRadius: 6, padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: "#F7931A", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14 }}>◈ Node Connection</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {[["ELECTRUM HOST", "localhost"], ["ELECTRUM PORT", "50001"], ["PROTOCOL", "TCP (cleartext)"], ["CONFIRMATION THRESHOLD", "1 block"]].map(([label, val]) => (
                    <div key={label}>
                      <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
                      <input defaultValue={val} style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "7px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} readOnly />
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: nodeStatus === "connected" ? "#22C55E" : "#EF4444", boxShadow: nodeStatus === "connected" ? "0 0 5px #22C55E88" : "none" }} />
                  <span style={{ fontSize: 11, color: nodeStatus === "connected" ? "#22C55E" : "#EF4444" }}>
                    {nodeStatus === "connected" ? "Connected — block 840,212" : "Connection failed"}
                  </span>
                </div>
              </div>

              {/* XMPP */}
              <div style={{ background: "#0D1320", border: "1px solid #1E2D40", borderRadius: 6, padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: "#F7931A", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14 }}>◉ XMPP Account</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {[["XMPP SERVER", "jabber.example.com"], ["XMPP JID (SENDER)", "watchtower@jabber.example.com"], ["PASSWORD", "••••••••••••"], ["RECIPIENT JID", "you@jabber.example.com"]].map(([label, val]) => (
                    <div key={label}>
                      <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
                      <input defaultValue={val} type={label === "PASSWORD" ? "password" : "text"} style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "7px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} readOnly />
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                  <button style={{ background: "#F7931A22", border: "1px solid #F7931A", color: "#F7931A", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer", letterSpacing: "0.08em" }}>
                    SEND TEST ALERT
                  </button>
                  <button style={{ background: "#F7931A", border: "none", color: "#000", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer", fontWeight: 700, letterSpacing: "0.08em" }}>
                    SAVE CONFIG
                  </button>
                </div>
              </div>

              <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.05em", lineHeight: 1.6 }}>
                The Watchtower runs entirely on your Umbrel node. No data leaves your device.<br />
                All monitoring uses your own Electrs/Fulcrum via the Electrum protocol.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
