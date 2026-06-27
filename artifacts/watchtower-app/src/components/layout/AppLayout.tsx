import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useGetNodeStatus } from "@workspace/api-client-react";

export function Topbar() {
  const [nodeStatus, setNodeStatus] = useState<"connected" | "disconnected">("connected");
  
  // Real poll every 10s
  const { data: status } = useGetNodeStatus({
    query: { refetchInterval: 10000 }
  });

  useEffect(() => {
    if (status) {
      setNodeStatus(status.connected ? "connected" : "disconnected");
    }
  }, [status]);

  return (
    <div style={{ background: "#0D1320", borderBottom: "1px solid #1E2D40", padding: "0 24px", height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 20, height: 20, background: "#F7931A", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#000" }}>₿</div>
        <span style={{ color: "#F7931A", fontWeight: 700, fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase" }}>The Watchtower</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: nodeStatus === "connected" ? "#22C55E" : "#EF4444", boxShadow: nodeStatus === "connected" ? "0 0 6px #22C55E88" : "0 0 6px #EF444488" }} />
          <span style={{ fontSize: 11, color: nodeStatus === "connected" ? "#22C55E" : "#EF4444", letterSpacing: "0.08em" }}>
            {nodeStatus === "connected" ? "NODE CONNECTED" : "NODE OFFLINE"}
          </span>
        </div>
        <span style={{ fontSize: 11, color: "#4A5568", letterSpacing: "0.05em" }}>electrs</span>
        {status?.blockHeight && (
          <span style={{ fontSize: 11, color: "#4A5568", letterSpacing: "0.05em" }}>Block {status.blockHeight}</span>
        )}
      </div>
    </div>
  );
}

export function Sidebar() {
  const [location] = useLocation();

  const links = [
    { href: "/", label: "⬡ Dashboard" },
    { href: "/addresses", label: "◈ Addresses" },
    { href: "/activity", label: "◉ Activity" },
    { href: "/settings", label: "⚙ Settings" },
  ];

  return (
    <div style={{ width: 180, background: "#0D1320", borderRight: "1px solid #1E2D40", display: "flex", flexDirection: "column", padding: "20px 0", flexShrink: 0 }}>
      {links.map((link) => {
        const isActive = location === link.href;
        return (
          <Link key={link.href} href={link.href} className="w-full">
            <div
              style={{
                background: isActive ? "#142030" : "transparent",
                borderLeft: `3px solid ${isActive ? "#F7931A" : "transparent"}`,
                color: isActive ? "#F7931A" : "#4A6080",
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
              {link.label}
            </div>
          </Link>
        );
      })}
      <div style={{ marginTop: "auto", padding: "16px 20px", borderTop: "1px solid #1E2D40" }}>
        <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em" }}>WATCHTOWER</div>
        <div style={{ fontSize: 10, color: "#4A6080", marginTop: 2 }}>v0.2.0</div>
      </div>
    </div>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Topbar />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <Sidebar />
        <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
