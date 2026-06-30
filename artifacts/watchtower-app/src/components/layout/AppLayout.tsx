import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useGetNodeStatus, getGetNodeStatusQueryKey } from "@workspace/api-client-react";
import { useTheme } from "@/lib/theme";
import logoSvg from "@/assets/logo-shield.png";

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
        border: `1px solid var(--wt-toggle-border)`,
        borderRadius: 4,
        cursor: "pointer",
        padding: "3px 8px",
        transition: "all 0.15s",
        color: "var(--wt-text-muted)",
      }}
    >
      {isDark ? (
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
  const [nodeStatus, setNodeStatus] = useState<"connected" | "disconnected">("disconnected");

  const { data: status } = useGetNodeStatus({
    query: { queryKey: getGetNodeStatusQueryKey(), refetchInterval: 10000 }
  });

  useEffect(() => {
    if (status) {
      setNodeStatus(status.connected ? "connected" : "disconnected");
    }
  }, [status]);

  const bg = "var(--wt-topbar-bg)";
  const borderColor = "var(--wt-border)";
  const mutedColor = "var(--wt-status-muted)";

  return (
    <div style={{ background: bg, borderBottom: `1px solid ${borderColor}`, padding: "0 24px", height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, transition: "background 0.2s, border-color 0.2s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 20, height: 20, background: "var(--wt-brand)", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#000" }}>₿</div>
        <span style={{ color: "var(--wt-brand)", fontWeight: 700, fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase" }}>The Watchtower</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: nodeStatus === "connected" ? "var(--wt-status-ok)" : "var(--wt-status-error)", boxShadow: nodeStatus === "connected" ? "0 0 6px color-mix(in srgb, var(--wt-status-ok) 53%, transparent)" : "0 0 6px color-mix(in srgb, var(--wt-status-error) 53%, transparent)" }} />
          <span style={{ fontSize: 11, color: nodeStatus === "connected" ? "var(--wt-status-ok)" : "var(--wt-status-error)", letterSpacing: "0.08em" }}>
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

  const bg = "var(--wt-sidebar-bg)";
  const borderColor = "var(--wt-border)";
  const activeBg = "var(--wt-nav-active-bg)";
  const inactiveColor = "var(--wt-nav-inactive)";
  const versionColor = "var(--wt-text-dim)";

  const links = [
    { href: "/", label: "⬡ Dashboard" },
    { href: "/addresses", label: "◈ Addresses" },
    { href: "/activity", label: "◉ Activity" },
    { href: "/settings", label: "⚙ Settings" },
  ];

  return (
    <div style={{ width: 180, background: bg, borderRight: `1px solid ${borderColor}`, display: "flex", flexDirection: "column", paddingTop: 20, flexShrink: 0, transition: "background 0.2s, border-color 0.2s" }}>
      {links.map((link) => {
        const isActive = location === link.href;
        return (
          <Link key={link.href} href={link.href} className="w-full">
            <div
              style={{
                background: isActive ? activeBg : "transparent",
                borderLeft: `3px solid ${isActive ? "var(--wt-brand)" : "transparent"}`,
                color: isActive ? "var(--wt-brand)" : inactiveColor,
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

      {/* Logo above version label */}
      <div style={{ marginTop: "auto", padding: "12px 20px 8px" }}>
        <img
          src={logoSvg}
          alt="The Watchtower"
          style={{ display: "block", width: "100%", height: "auto" }}
        />
      </div>

      {/* Version label */}
      <div style={{ padding: "6px 20px 16px", borderTop: `1px solid ${borderColor}` }}>
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
