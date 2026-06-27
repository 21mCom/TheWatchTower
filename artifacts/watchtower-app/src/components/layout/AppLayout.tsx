import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useGetNodeStatus } from "@workspace/api-client-react";
import { useTheme } from "@/lib/theme";
import logoSvg from "@/assets/logo.svg";

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      onClick={toggle}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "transparent",
        border: `1px solid ${isDark ? "#2A4060" : "#BDCADA"}`,
        borderRadius: 4,
        cursor: "pointer",
        padding: "3px 8px",
        transition: "all 0.15s",
        color: isDark ? "#4A6080" : "#5B6F87",
      }}
    >
      {isDark ? (
        /* Sun icon */
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5"/>
          <line x1="12" y1="1" x2="12" y2="3"/>
          <line x1="12" y1="21" x2="12" y2="23"/>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
          <line x1="1" y1="12" x2="3" y2="12"/>
          <line x1="21" y1="12" x2="23" y2="12"/>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
      ) : (
        /* Moon icon */
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      )}
      <span style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        {isDark ? "Light" : "Dark"}
      </span>
    </button>
  );
}

export function Topbar() {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [nodeStatus, setNodeStatus] = useState<"connected" | "disconnected">("disconnected");

  const { data: status } = useGetNodeStatus({
    query: { refetchInterval: 10000 }
  });

  useEffect(() => {
    if (status) {
      setNodeStatus(status.connected ? "connected" : "disconnected");
    }
  }, [status]);

  const bg = isDark ? "#0D1320" : "#EBF0F7";
  const borderColor = isDark ? "#1E2D40" : "#BDCADA";
  const mutedColor = isDark ? "#4A5568" : "#7A8FA6";

  return (
    <div style={{ background: bg, borderBottom: `1px solid ${borderColor}`, padding: "0 24px", height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, transition: "background 0.2s, border-color 0.2s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <img
          src={logoSvg}
          alt="The Watchtower"
          style={{ width: 36, height: 36, display: "block", color: isDark ? "#E2E8F0" : "#0D1520" }}
        />
        <span style={{ color: "#F7931A", fontWeight: 700, fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase" }}>The Watchtower</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: nodeStatus === "connected" ? "#22C55E" : "#EF4444", boxShadow: nodeStatus === "connected" ? "0 0 6px #22C55E88" : "0 0 6px #EF444488" }} />
          <span style={{ fontSize: 11, color: nodeStatus === "connected" ? "#22C55E" : "#EF4444", letterSpacing: "0.08em" }}>
            {nodeStatus === "connected" ? "NODE CONNECTED" : "NODE OFFLINE"}
          </span>
        </div>
        <span style={{ fontSize: 11, color: mutedColor, letterSpacing: "0.05em" }}>electrs</span>
        {status?.blockHeight && (
          <span style={{ fontSize: 11, color: mutedColor, letterSpacing: "0.05em" }}>Block {status.blockHeight}</span>
        )}
        <ThemeToggle />
      </div>
    </div>
  );
}

export function Sidebar() {
  const [location] = useLocation();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const bg = isDark ? "#0D1320" : "#E3EAF2";
  const borderColor = isDark ? "#1E2D40" : "#BDCADA";
  const activeBg = isDark ? "#142030" : "#D4DEF0";
  const inactiveColor = isDark ? "#4A6080" : "#7A8FA6";
  const versionColor = isDark ? "#2A4060" : "#9AAFC7";
  const bottomBorderColor = isDark ? "#1E2D40" : "#BDCADA";

  const links = [
    { href: "/", label: "⬡ Dashboard" },
    { href: "/addresses", label: "◈ Addresses" },
    { href: "/activity", label: "◉ Activity" },
    { href: "/settings", label: "⚙ Settings" },
  ];

  return (
    <div style={{ width: 180, background: bg, borderRight: `1px solid ${borderColor}`, display: "flex", flexDirection: "column", padding: "20px 0", flexShrink: 0, transition: "background 0.2s, border-color 0.2s" }}>
      {links.map((link) => {
        const isActive = location === link.href;
        return (
          <Link key={link.href} href={link.href} className="w-full">
            <div
              style={{
                background: isActive ? activeBg : "transparent",
                borderLeft: `3px solid ${isActive ? "#F7931A" : "transparent"}`,
                color: isActive ? "#F7931A" : inactiveColor,
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
      <div style={{ marginTop: "auto", padding: "16px 20px", borderTop: `1px solid ${bottomBorderColor}` }}>
        <div style={{ fontSize: 10, color: versionColor, letterSpacing: "0.08em" }}>WATCHTOWER</div>
        <div style={{ fontSize: 10, color: inactiveColor, marginTop: 2 }}>v0.2.0</div>
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
