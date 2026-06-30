import { useState, useEffect, useRef } from "react";
import { useGetSettings, useUpdateSettings, useSendTestAlert, useGetNodeStatus, getGetSettingsQueryKey, getGetNodeStatusQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

const DEFAULT_TEMPLATE =
  "[{direction}] {label}\nAmount: {amount_btc} ({amount_sats} sats)\nAddress: {address}\nTxid: {txid}\nStatus: {status}";

const TOKENS: { token: string; label: string; example: string }[] = [
  { token: "{label}",         label: "Label",          example: "Cold Storage" },
  { token: "{address}",       label: "Address",        example: "bc1qxyz…" },
  { token: "{txid}",          label: "Txid",           example: "a1b2c3…" },
  { token: "{direction}",     label: "Direction",      example: "INCOMING" },
  { token: "{amount_btc}",    label: "Amount (BTC)",   example: "+0.00500000 BTC" },
  { token: "{amount_sats}",   label: "Amount (sats)",  example: "500,000 sats" },
  { token: "{status}",        label: "Status",         example: "confirmed (block 850000, 1/1 confirmations)" },
  { token: "{block}",         label: "Block",          example: "850000" },
  { token: "{confirmations}", label: "Confirmations",  example: "1/1" },
];

const SAMPLE: Record<string, string> = {
  "{label}":         "Cold Storage",
  "{address}":       "bc1qxyz…",
  "{txid}":          "a1b2c3d4…",
  "{direction}":     "INCOMING",
  "{amount_btc}":    "+0.00500000 BTC",
  "{amount_sats}":   "500,000",
  "{status}":        "confirmed (block 850000, 1/1 confirmations)",
  "{block}":         "850000",
  "{confirmations}": "1/1",
};

function renderPreview(template: string): string {
  return TOKENS.reduce((t, tok) => t.replaceAll(tok.token, SAMPLE[tok.token] ?? tok.token), template);
}

const inputStyle: React.CSSProperties = {
  background: "var(--wt-input-bg)",
  border: "1px solid var(--wt-border)",
  borderRadius: 4,
  color: "var(--wt-text)",
  fontFamily: "inherit",
  fontSize: 12,
  padding: "7px 10px",
  width: "100%",
  outline: "none",
  boxSizing: "border-box",
};

export default function Settings() {
  const { data: settings, isLoading } = useGetSettings();
  const { data: nodeStatus } = useGetNodeStatus({ query: { queryKey: getGetNodeStatusQueryKey(), refetchInterval: 10000 }});

  const updateSettings = useUpdateSettings();
  const sendTestAlert = useSendTestAlert();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const templateRef = useRef<HTMLTextAreaElement>(null);

  const [formData, setFormData] = useState({
    electrumHost: "",
    electrumPort: 50001,
    electrumTls: false,
    electrumAllowSelfSigned: false,
    confirmationThreshold: 1,
    xmppServer: "",
    xmppPort: 5222,
    xmppJid: "",
    xmppPassword: "",
    xmppTls: true,
    recipientJid: "",
    alertTemplate: DEFAULT_TEMPLATE,
  });

  useEffect(() => {
    if (settings) {
      setFormData(prev => ({
        ...prev,
        electrumHost: settings.electrumHost,
        electrumPort: settings.electrumPort,
        electrumTls: settings.electrumTls,
        electrumAllowSelfSigned: settings.electrumAllowSelfSigned,
        confirmationThreshold: settings.confirmationThreshold,
        xmppServer: settings.xmppServer,
        xmppPort: settings.xmppPort,
        xmppJid: settings.xmppJid,
        xmppPassword: "",
        xmppTls: settings.xmppTls,
        recipientJid: settings.recipientJid,
        alertTemplate: settings.alertTemplate ?? DEFAULT_TEMPLATE,
      }));
    }
  }, [settings]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const target = e.target as HTMLInputElement;
    const { name, value, type } = target;
    const checked = type === "checkbox" ? target.checked : undefined;
    setFormData(prev => ({
      ...prev,
      [name]: type === "checkbox" ? checked : (type === "number" ? Number(value) : value),
    }));
  };

  const handleSave = async () => {
    try {
      const payload = { ...formData } as Record<string, unknown>;
      if (!payload.xmppPassword) delete payload.xmppPassword;
      await updateSettings.mutateAsync({ data: payload as Parameters<typeof updateSettings.mutateAsync>[0]["data"] });
      queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      toast({ title: "Settings saved successfully" });
    } catch (err: any) {
      toast({ title: "Error saving settings", description: err.message, variant: "destructive" });
    }
  };

  const handleTestAlert = async () => {
    try {
      const res = await sendTestAlert.mutateAsync();
      if (res.success) {
        toast({ title: "Test alert sent", description: res.message });
      } else {
        toast({ title: "Test alert failed", description: res.message, variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Error sending test alert", description: err.message, variant: "destructive" });
    }
  };

  const insertToken = (token: string) => {
    const el = templateRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const next = before + token + after;
    setFormData(prev => ({ ...prev, alertTemplate: next }));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const showSelfSignedWarning = formData.electrumTls && formData.electrumAllowSelfSigned;

  if (isLoading) return <div style={{ padding: 24, color: "var(--wt-text-muted)" }}>Loading settings...</div>;

  return (
    <div>
      <h1 style={{ fontSize: 13, color: "var(--wt-text-muted)", letterSpacing: "0.1em", textTransform: "uppercase", margin: "0 0 20px 0" }}>Configuration</h1>

      {/* Node Connection */}
      <div style={{ background: "var(--wt-card-bg)", border: "1px solid var(--wt-border)", borderRadius: 6, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "var(--wt-brand)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14 }}>◈ Node Connection</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 4 }}>ELECTRUM HOST</div>
            <input name="electrumHost" value={formData.electrumHost} onChange={handleChange} style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 4 }}>ELECTRUM PORT</div>
            <input type="number" name="electrumPort" value={formData.electrumPort} onChange={handleChange} style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 4 }}>CONFIRMATION THRESHOLD</div>
            <input type="number" name="confirmationThreshold" value={formData.confirmationThreshold} onChange={handleChange} style={inputStyle} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 18 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" name="electrumTls" checked={formData.electrumTls} onChange={handleChange} />
              <span style={{ fontSize: 11, color: "var(--wt-text)" }}>Use TLS (SSL)</span>
            </label>
            {formData.electrumTls && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" name="electrumAllowSelfSigned" checked={formData.electrumAllowSelfSigned} onChange={handleChange} />
                <span style={{ fontSize: 11, color: "var(--wt-text)" }}>Allow self-signed certificate</span>
              </label>
            )}
          </div>
        </div>

        {showSelfSignedWarning && (
          <div style={{ marginTop: 12, background: "color-mix(in srgb, var(--wt-brand) 12%, var(--wt-card-bg))", border: "1px solid color-mix(in srgb, var(--wt-brand) 33%, transparent)", borderRadius: 4, padding: "8px 12px", display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ color: "var(--wt-brand)", fontSize: 13, flexShrink: 0, marginTop: 1 }}>⚠</span>
            <span style={{ fontSize: 11, color: "var(--wt-text-secondary)", lineHeight: 1.5 }}>
              <strong style={{ color: "var(--wt-brand)" }}>Certificate verification is disabled.</strong>{" "}
              Your Electrum connection cannot detect man-in-the-middle attacks. Only enable this if your Electrs/Fulcrum server uses a self-signed certificate on your local network.
            </span>
          </div>
        )}

        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: nodeStatus?.connected ? "var(--wt-status-ok)" : "var(--wt-status-error)", boxShadow: nodeStatus?.connected ? "0 0 5px color-mix(in srgb, var(--wt-status-ok) 53%, transparent)" : "none" }} />
          <span style={{ fontSize: 11, color: nodeStatus?.connected ? "var(--wt-status-ok)" : "var(--wt-status-error)" }}>
            {nodeStatus?.connected ? `Connected — block ${nodeStatus.blockHeight || "..."}` : (nodeStatus?.message || "Connection failed")}
          </span>
          <button
            onClick={handleSave}
            disabled={updateSettings.isPending}
            style={{ marginLeft: "auto", background: "var(--wt-brand)", border: "none", color: "#000", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer", fontWeight: 700, letterSpacing: "0.08em", opacity: updateSettings.isPending ? 0.7 : 1 }}
          >
            {updateSettings.isPending ? "SAVING..." : "SAVE CONFIG"}
          </button>
        </div>
      </div>

      {/* XMPP Settings */}
      <div style={{ background: "var(--wt-card-bg)", border: "1px solid var(--wt-border)", borderRadius: 6, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "var(--wt-brand)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14 }}>◉ XMPP Account</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 4 }}>XMPP SERVER</div>
            <input name="xmppServer" value={formData.xmppServer} onChange={handleChange} style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 4 }}>XMPP PORT</div>
            <input type="number" name="xmppPort" value={formData.xmppPort} onChange={handleChange} style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 4 }}>XMPP JID (SENDER)</div>
            <input name="xmppJid" value={formData.xmppJid} onChange={handleChange} placeholder="watchtower@example.com" style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 4 }}>PASSWORD</div>
            <input type="password" name="xmppPassword" value={formData.xmppPassword} onChange={handleChange} placeholder="••••••••••••" style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 4 }}>RECIPIENT JID</div>
            <input name="recipientJid" value={formData.recipientJid} onChange={handleChange} placeholder="you@example.com" style={inputStyle} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 18 }}>
            <input type="checkbox" name="xmppTls" checked={formData.xmppTls} onChange={handleChange} />
            <span style={{ fontSize: 11, color: "var(--wt-text)" }}>Use TLS</span>
          </div>
        </div>
        <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
          <button
            onClick={handleTestAlert}
            disabled={sendTestAlert.isPending}
            style={{ background: "color-mix(in srgb, var(--wt-brand) 13%, transparent)", border: "1px solid var(--wt-brand)", color: "var(--wt-brand)", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer", letterSpacing: "0.08em", opacity: sendTestAlert.isPending ? 0.7 : 1 }}
          >
            {sendTestAlert.isPending ? "SENDING..." : "SEND TEST ALERT"}
          </button>
          <button
            onClick={handleSave}
            disabled={updateSettings.isPending}
            style={{ background: "var(--wt-brand)", border: "none", color: "#000", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer", fontWeight: 700, letterSpacing: "0.08em", opacity: updateSettings.isPending ? 0.7 : 1 }}
          >
            {updateSettings.isPending ? "SAVING..." : "SAVE CONFIG"}
          </button>
        </div>
      </div>

      {/* Alert Message Template */}
      <div style={{ background: "var(--wt-card-bg)", border: "1px solid var(--wt-border)", borderRadius: 6, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "var(--wt-brand)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>✉ Alert Message Template</div>
        <div style={{ fontSize: 10, color: "var(--wt-text-dim)", lineHeight: 1.5, marginBottom: 14 }}>
          Customise the XMPP message sent on each transaction alert. Click a token to insert it at the cursor, or type it directly.
        </div>

        {/* Token chips */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {TOKENS.map(t => (
            <button
              key={t.token}
              onClick={() => insertToken(t.token)}
              title={`Example: ${t.example}`}
              style={{
                background: "var(--wt-chip-bg)",
                border: "1px solid var(--wt-chip-border)",
                borderRadius: 3,
                color: "var(--wt-brand)",
                fontFamily: "monospace",
                fontSize: 10,
                padding: "3px 8px",
                cursor: "pointer",
                letterSpacing: "0.02em",
              }}
            >
              {t.token}
            </button>
          ))}
          <button
            onClick={() => setFormData(prev => ({ ...prev, alertTemplate: DEFAULT_TEMPLATE }))}
            title="Restore default template"
            style={{
              background: "transparent",
              border: "1px solid var(--wt-text-dim)",
              borderRadius: 3,
              color: "var(--wt-text-muted)",
              fontFamily: "inherit",
              fontSize: 10,
              padding: "3px 8px",
              cursor: "pointer",
              marginLeft: "auto",
            }}
          >
            RESET DEFAULT
          </button>
        </div>

        {/* Template textarea */}
        <textarea
          ref={templateRef}
          name="alertTemplate"
          value={formData.alertTemplate}
          onChange={handleChange}
          rows={6}
          spellCheck={false}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.7, fontFamily: "monospace", fontSize: 11 }}
        />

        {/* Live preview */}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>PREVIEW (sample data)</div>
          <pre style={{
            background: "var(--wt-preview-bg)",
            border: "1px solid var(--wt-preview-border)",
            borderRadius: 4,
            color: "var(--wt-preview-text)",
            fontFamily: "monospace",
            fontSize: 11,
            lineHeight: 1.7,
            margin: 0,
            padding: "10px 14px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}>
            {renderPreview(formData.alertTemplate) || <span style={{ color: "var(--wt-text-dim)" }}>(empty template)</span>}
          </pre>
        </div>

        <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={handleSave}
            disabled={updateSettings.isPending}
            style={{ background: "var(--wt-brand)", border: "none", color: "#000", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer", fontWeight: 700, letterSpacing: "0.08em", opacity: updateSettings.isPending ? 0.7 : 1 }}
          >
            {updateSettings.isPending ? "SAVING..." : "SAVE CONFIG"}
          </button>
        </div>
      </div>

      <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.05em", lineHeight: 1.6 }}>
        The Watchtower runs entirely on your Umbrel node. No data leaves your device.<br />
        All monitoring uses your own Electrs/Fulcrum via the Electrum protocol.
      </div>
    </div>
  );
}
