import { useState } from "react";
import DirectionA from "./DirectionA";
import DirectionB from "./DirectionB";

type Choice = "A" | "B" | null;

export default function Comparison() {
  const [chosen, setChosen] = useState<Choice>(null);

  return (
    <div style={{ background: "#F0F2F4", minHeight: "100vh", display: "flex", flexDirection: "column", fontFamily: "'Inter', 'Helvetica Neue', sans-serif" }}>
      {/* Header */}
      <div style={{ background: "#FFFFFF", borderBottom: "1px solid #DDE1E6", padding: "18px 40px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#111827", letterSpacing: "-0.01em" }}>Choose a UI direction for The Watchtower</h1>
          <p style={{ margin: "3px 0 0 0", fontSize: 13, color: "#6B7280" }}>Click inside each preview to explore all screens — then pick the direction that feels right</p>
        </div>
        {chosen && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 14, color: "#374151", fontWeight: 500 }}>
              You selected: <strong style={{ color: chosen === "A" ? "#F7931A" : "#0D9488" }}>{chosen === "A" ? "Direction A — Ops Console" : "Direction B — Calm Minimal"}</strong>
            </span>
            <button
              onClick={() => setChosen(null)}
              style={{ background: "transparent", border: "1px solid #D1D5DB", color: "#6B7280", fontSize: 12, padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}
            >
              Change
            </button>
          </div>
        )}
      </div>

      {/* Two-panel comparison */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, overflow: "hidden" }}>
        {(["A", "B"] as const).map(dir => {
          const isChosen = chosen === dir;
          const isRejected = chosen !== null && chosen !== dir;
          const label = dir === "A" ? "Direction A — Ops Console" : "Direction B — Calm Minimal";
          const accent = dir === "A" ? "#F7931A" : "#0D9488";
          const accentLight = dir === "A" ? "#FFF7ED" : "#F0FDFA";
          const accentBorder = dir === "A" ? "#FDBA74" : "#99F6E4";

          return (
            <div
              key={dir}
              style={{
                display: "flex",
                flexDirection: "column",
                borderRight: dir === "A" ? "2px solid #DDE1E6" : "none",
                opacity: isRejected ? 0.4 : 1,
                transition: "opacity 0.3s",
                overflow: "hidden",
              }}
            >
              {/* Panel label bar */}
              <div style={{
                background: isChosen ? accentLight : "#FAFAFA",
                borderBottom: `2px solid ${isChosen ? accent : "#DDE1E6"}`,
                padding: "12px 24px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexShrink: 0,
                transition: "background 0.2s, border-color 0.2s",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: accent }} />
                  <span style={{ fontWeight: 600, fontSize: 14, color: "#1F2937" }}>{label}</span>
                  <span style={{ fontSize: 12, color: "#6B7280", marginLeft: 4 }}>
                    {dir === "A" ? "• Dark / ops / monospace" : "• Light / minimal / spacious"}
                  </span>
                </div>
                <button
                  onClick={() => setChosen(isChosen ? null : dir)}
                  style={{
                    background: isChosen ? accent : "transparent",
                    border: `1.5px solid ${isChosen ? accent : "#D1D5DB"}`,
                    color: isChosen ? "#FFFFFF" : "#374151",
                    fontSize: 13,
                    fontWeight: 600,
                    padding: "6px 18px",
                    borderRadius: 7,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 0.2s",
                    whiteSpace: "nowrap",
                  }}
                >
                  {isChosen ? "✓ Selected" : `Choose Direction ${dir}`}
                </button>
              </div>

              {/* Scaled component preview */}
              <div style={{ flex: 1, position: "relative", overflow: "hidden", background: dir === "A" ? "#0B0F17" : "#F8FAF9" }}>
                <div style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "200%",
                  height: "200%",
                  transform: "scale(0.5)",
                  transformOrigin: "top left",
                  pointerEvents: "none",
                  userSelect: "none",
                }}>
                  {dir === "A" ? <DirectionA /> : <DirectionB />}
                </div>
                {/* Transparent overlay to capture clicks for selection without navigating inside */}
                <div
                  style={{ position: "absolute", inset: 0, cursor: "default" }}
                  title="Click 'Choose' above to select this direction"
                />
              </div>

              {/* Bottom description */}
              <div style={{
                background: "#FFFFFF",
                borderTop: "1px solid #E5E7EB",
                padding: "12px 24px",
                fontSize: 12,
                color: "#6B7280",
                flexShrink: 0,
                lineHeight: 1.5,
              }}>
                {dir === "A"
                  ? "Dense monitoring console with real-time data view. Bitcoin-orange accent, compact data tables, monospace address/txid display, dark palette."
                  : "Clean, spacious dashboard with card-based layout. Teal accent, generous whitespace, clear typography — feels like a polished product."}
              </div>
            </div>
          );
        })}
      </div>

      {/* Selection banner */}
      {chosen && (
        <div style={{
          background: chosen === "A" ? "#FFF7ED" : "#F0FDFA",
          borderTop: `2px solid ${chosen === "A" ? "#F7931A" : "#0D9488"}`,
          padding: "14px 40px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 20 }}>✓</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>
              {chosen === "A" ? "Direction A — Ops Console" : "Direction B — Calm Minimal"} selected
            </div>
            <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>
              Let the team know your choice and they'll build the full app in this direction.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
