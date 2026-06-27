import { useState, useEffect } from "react";
import { useGetSettings, useUpdateSettings, useSendTestAlert, useGetNodeStatus, getGetSettingsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function Settings() {
  const { data: settings, isLoading } = useGetSettings();
  const { data: nodeStatus } = useGetNodeStatus({ query: { refetchInterval: 10000 }});
  
  const updateSettings = useUpdateSettings();
  const sendTestAlert = useSendTestAlert();
  const queryClient = useQueryClient();
  const { toast } = useToast();

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
    recipientJid: ""
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
        xmppPassword: "", // Don't populate password
        xmppTls: settings.xmppTls,
        recipientJid: settings.recipientJid
      }));
    }
  }, [settings]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : (type === 'number' ? Number(value) : value)
    }));
  };

  const handleSave = async () => {
    try {
      const payload = { ...formData };
      if (!payload.xmppPassword) {
        delete (payload as any).xmppPassword;
      }
      await updateSettings.mutateAsync({ data: payload });
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

  const showSelfSignedWarning = formData.electrumTls && formData.electrumAllowSelfSigned;

  if (isLoading) return <div style={{ padding: 24, color: "#4A6080" }}>Loading settings...</div>;

  return (
    <div>
      <h1 style={{ fontSize: 13, color: "#4A6080", letterSpacing: "0.1em", textTransform: "uppercase", margin: "0 0 20px 0" }}>Configuration</h1>

      {/* Node Connection */}
      <div style={{ background: "#0D1320", border: "1px solid #1E2D40", borderRadius: 6, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "#F7931A", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14 }}>◈ Node Connection</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>ELECTRUM HOST</div>
            <input name="electrumHost" value={formData.electrumHost} onChange={handleChange} style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "7px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>ELECTRUM PORT</div>
            <input type="number" name="electrumPort" value={formData.electrumPort} onChange={handleChange} style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "7px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>CONFIRMATION THRESHOLD</div>
            <input type="number" name="confirmationThreshold" value={formData.confirmationThreshold} onChange={handleChange} style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "7px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 18 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" name="electrumTls" checked={formData.electrumTls} onChange={handleChange} />
              <span style={{ fontSize: 11, color: "#CBD5E1" }}>Use TLS (SSL)</span>
            </label>
            {formData.electrumTls && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" name="electrumAllowSelfSigned" checked={formData.electrumAllowSelfSigned} onChange={handleChange} />
                <span style={{ fontSize: 11, color: "#CBD5E1" }}>Allow self-signed certificate</span>
              </label>
            )}
          </div>
        </div>

        {/* Amber warning when self-signed mode is active */}
        {showSelfSignedWarning && (
          <div style={{ marginTop: 12, background: "#2A1A00", border: "1px solid #F7931A55", borderRadius: 4, padding: "8px 12px", display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ color: "#F7931A", fontSize: 13, flexShrink: 0, marginTop: 1 }}>⚠</span>
            <span style={{ fontSize: 11, color: "#D4A04A", lineHeight: 1.5 }}>
              <strong style={{ color: "#F7931A" }}>Certificate verification is disabled.</strong>{" "}
              Your Electrum connection cannot detect man-in-the-middle attacks. Only enable this if your Electrs/Fulcrum server uses a self-signed certificate on your local network.
            </span>
          </div>
        )}

        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: nodeStatus?.connected ? "#22C55E" : "#EF4444", boxShadow: nodeStatus?.connected ? "0 0 5px #22C55E88" : "none" }} />
          <span style={{ fontSize: 11, color: nodeStatus?.connected ? "#22C55E" : "#EF4444" }}>
            {nodeStatus?.connected ? `Connected — block ${nodeStatus.blockHeight || "..."}` : (nodeStatus?.message || "Connection failed")}
          </span>
        </div>
      </div>

      {/* XMPP Settings */}
      <div style={{ background: "#0D1320", border: "1px solid #1E2D40", borderRadius: 6, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "#F7931A", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14 }}>◉ XMPP Account</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>XMPP SERVER</div>
            <input name="xmppServer" value={formData.xmppServer} onChange={handleChange} style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "7px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>XMPP PORT</div>
            <input type="number" name="xmppPort" value={formData.xmppPort} onChange={handleChange} style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "7px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>XMPP JID (SENDER)</div>
            <input name="xmppJid" value={formData.xmppJid} onChange={handleChange} placeholder="watchtower@example.com" style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "7px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>PASSWORD</div>
            <input type="password" name="xmppPassword" value={formData.xmppPassword} onChange={handleChange} placeholder="••••••••••••" style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "7px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>RECIPIENT JID</div>
            <input name="recipientJid" value={formData.recipientJid} onChange={handleChange} placeholder="you@example.com" style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "7px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 18 }}>
            <input type="checkbox" name="xmppTls" checked={formData.xmppTls} onChange={handleChange} />
            <span style={{ fontSize: 11, color: "#CBD5E1" }}>Use TLS</span>
          </div>
        </div>
        <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
          <button 
            onClick={handleTestAlert}
            disabled={sendTestAlert.isPending}
            style={{ background: "#F7931A22", border: "1px solid #F7931A", color: "#F7931A", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer", letterSpacing: "0.08em", opacity: sendTestAlert.isPending ? 0.7 : 1 }}
          >
            {sendTestAlert.isPending ? "SENDING..." : "SEND TEST ALERT"}
          </button>
          <button 
            onClick={handleSave}
            disabled={updateSettings.isPending}
            style={{ background: "#F7931A", border: "none", color: "#000", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer", fontWeight: 700, letterSpacing: "0.08em", opacity: updateSettings.isPending ? 0.7 : 1 }}
          >
            {updateSettings.isPending ? "SAVING..." : "SAVE CONFIG"}
          </button>
        </div>
      </div>

      <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.05em", lineHeight: 1.6 }}>
        The Watchtower runs entirely on your Umbrel node. No data leaves your device.<br />
        All monitoring uses your own Electrs/Fulcrum via the Electrum protocol.
      </div>
    </div>
  );
}
