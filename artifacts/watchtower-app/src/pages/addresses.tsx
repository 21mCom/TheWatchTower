import { useState, useEffect } from "react";
import { useListAddresses, useCreateAddress, useUpdateAddress, useDeleteAddress, useGetSettings, getListAddressesQueryKey } from "@workspace/api-client-react";
import { formatTimeAgo } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

const inputStyle: React.CSSProperties = {
  background: "var(--wt-input-bg)",
  border: "1px solid var(--wt-border)",
  borderRadius: 4,
  color: "var(--wt-text)",
  fontFamily: "inherit",
  fontSize: 12,
  padding: "8px 10px",
  width: "100%",
  outline: "none",
  boxSizing: "border-box",
};

function parseBulkAddresses(raw: string): string[] {
  return [...new Set(
    raw.split(/[\n,]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
  )];
}

export default function Addresses() {
  const [addOpen, setAddOpen] = useState(false);
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [editId, setEditId] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const [watchMode, setWatchMode] = useState<"future" | "all">("future");

  const { data: addresses, isLoading } = useListAddresses();
  const addressesData = addresses || [];

  const { data: settings } = useGetSettings();

  // Initialise the per-address choice from the global default each time the add
  // form is opened, so it reflects the current setting but can be overridden.
  useEffect(() => {
    if (settings && addOpen) {
      setWatchMode(settings.futureOnlyDefault ? "future" : "all");
    }
  }, [settings, addOpen]);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createAddress = useCreateAddress();
  const updateAddress = useUpdateAddress();
  const deleteAddress = useDeleteAddress();

  const parsedBulk = parseBulkAddresses(bulkText);

  function resetForm() {
    setLabel("");
    setAddress("");
    setBulkText("");
    setBulkProgress(null);
    setAddOpen(false);
  }

  const handleWatch = async () => {
    if (!label || !address) return;
    try {
      await createAddress.mutateAsync({ data: { label, address, watchMode } });
      queryClient.invalidateQueries({ queryKey: getListAddressesQueryKey() });
      resetForm();
      toast({ title: "Address added" });
    } catch (err: any) {
      toast({ title: "Error adding address", description: err.message, variant: "destructive" });
    }
  };

  const handleBulkWatch = async () => {
    if (!label || parsedBulk.length === 0) return;

    let added = 0;
    let duplicates = 0;
    let invalid = 0;

    for (let i = 0; i < parsedBulk.length; i++) {
      const addr = parsedBulk[i]!;
      setBulkProgress(`Adding ${i + 1} of ${parsedBulk.length}…`);
      try {
        await createAddress.mutateAsync({ data: { label, address: addr, watchMode } });
        added++;
      } catch (err: any) {
        const msg: string = err?.message ?? "";
        if (msg.toLowerCase().includes("already") || err?.status === 409) {
          duplicates++;
        } else {
          invalid++;
        }
      }
    }

    queryClient.invalidateQueries({ queryKey: getListAddressesQueryKey() });
    resetForm();

    const parts: string[] = [];
    if (added > 0) parts.push(`${added} added`);
    if (duplicates > 0) parts.push(`${duplicates} duplicate${duplicates > 1 ? "s" : ""} skipped`);
    if (invalid > 0) parts.push(`${invalid} invalid skipped`);

    toast({
      title: added > 0 ? "Bulk import complete" : "Nothing imported",
      description: parts.join(", "),
      variant: added > 0 ? "default" : "destructive",
    });
  };

  const handleUpdate = async (id: string, newLabel: string, currentAddress: string) => {
    try {
      await updateAddress.mutateAsync({ id, data: { label: newLabel, address: currentAddress } });
      queryClient.invalidateQueries({ queryKey: getListAddressesQueryKey() });
      setEditId(null);
      toast({ title: "Address updated" });
    } catch (err: any) {
      toast({ title: "Error updating address", description: err.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to remove this address?")) return;
    try {
      await deleteAddress.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListAddressesQueryKey() });
      toast({ title: "Address removed" });
    } catch (err: any) {
      toast({ title: "Error removing address", description: err.message, variant: "destructive" });
    }
  };

  const isBusy = !!bulkProgress || createAddress.isPending;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontSize: 13, color: "var(--wt-text-muted)", letterSpacing: "0.1em", textTransform: "uppercase", margin: 0 }}>Watched Addresses</h1>
        <button
          onClick={() => { setAddOpen(!addOpen); setMode("single"); }}
          style={{ background: "var(--wt-brand)", border: "none", color: "#000", fontSize: 11, fontFamily: "inherit", padding: "7px 14px", borderRadius: 4, cursor: "pointer", fontWeight: 700, letterSpacing: "0.08em" }}
        >
          + ADD ADDRESS
        </button>
      </div>

      {addOpen && (
        <div style={{ background: "var(--wt-card-bg)", border: "1px solid color-mix(in srgb, var(--wt-brand) 27%, transparent)", borderRadius: 6, padding: 20, marginBottom: 20 }}>
          {/* Mode toggle */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: "var(--wt-text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
              {mode === "single" ? "New Watched Address" : "Bulk Import"}
            </div>
            <div style={{ display: "flex", gap: 0, border: "1px solid var(--wt-border)", borderRadius: 4, overflow: "hidden" }}>
              {(["single", "bulk"] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    background: mode === m ? "color-mix(in srgb, var(--wt-brand) 13%, transparent)" : "transparent",
                    border: "none",
                    borderRight: m === "single" ? "1px solid var(--wt-border)" : "none",
                    color: mode === m ? "var(--wt-brand)" : "var(--wt-text-muted)",
                    fontFamily: "inherit",
                    fontSize: 10,
                    padding: "4px 12px",
                    cursor: "pointer",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  {m === "single" ? "Single" : "Bulk"}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Shared label field */}
            <div>
              <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 4 }}>
                LABEL{mode === "bulk" ? " (applied to all)" : ""}
              </div>
              <input
                placeholder="e.g. Cold Storage — Main"
                value={label}
                onChange={e => setLabel(e.target.value)}
                style={inputStyle}
                disabled={isBusy}
              />
            </div>

            {mode === "single" ? (
              <div>
                <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 4 }}>BITCOIN ADDRESS</div>
                <input
                  placeholder="bc1q... or 1... or 3..."
                  value={address}
                  onChange={e => setAddress(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") handleWatch(); }}
                  style={inputStyle}
                  disabled={isBusy}
                />
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 4 }}>
                  BITCOIN ADDRESSES — one per line
                </div>
                <textarea
                  placeholder={"bc1qxxx...\nbc1qyyy...\n1ABC..."}
                  value={bulkText}
                  onChange={e => setBulkText(e.target.value)}
                  rows={6}
                  style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }}
                  disabled={isBusy}
                />
                {parsedBulk.length > 0 && (
                  <div style={{ fontSize: 10, color: "var(--wt-text-muted)", marginTop: 4 }}>
                    {parsedBulk.length} address{parsedBulk.length !== 1 ? "es" : ""} detected
                  </div>
                )}
                {bulkProgress && (
                  <div style={{ fontSize: 10, color: "var(--wt-brand)", marginTop: 4 }}>{bulkProgress}</div>
                )}
              </div>
            )}

            {/* Watch mode override */}
            <div>
              <div style={{ fontSize: 10, color: "var(--wt-text-dim)", letterSpacing: "0.08em", marginBottom: 4 }}>
                MONITORING MODE
              </div>
              <div style={{ display: "flex", gap: 0, border: "1px solid var(--wt-border)", borderRadius: 4, overflow: "hidden", width: "fit-content" }}>
                {([
                  { value: "future" as const, label: "Future only" },
                  { value: "all" as const, label: "Import full history" },
                ]).map((opt, idx) => (
                  <button
                    key={opt.value}
                    onClick={() => setWatchMode(opt.value)}
                    disabled={isBusy}
                    style={{
                      background: watchMode === opt.value ? "color-mix(in srgb, var(--wt-brand) 13%, transparent)" : "transparent",
                      border: "none",
                      borderRight: idx === 0 ? "1px solid var(--wt-border)" : "none",
                      color: watchMode === opt.value ? "var(--wt-brand)" : "var(--wt-text-muted)",
                      fontFamily: "inherit",
                      fontSize: 10,
                      padding: "5px 12px",
                      cursor: "pointer",
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10, color: "var(--wt-text-dim)", lineHeight: 1.5, marginTop: 6 }}>
                {watchMode === "future"
                  ? "Existing history is recorded silently — you'll only be alerted on transactions from now on."
                  : "Every past transaction will be imported and alerted on."}
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <button
                onClick={resetForm}
                disabled={isBusy}
                style={{ background: "transparent", border: "1px solid var(--wt-border)", color: "var(--wt-text-muted)", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer" }}
              >
                CANCEL
              </button>
              <button
                onClick={mode === "single" ? handleWatch : handleBulkWatch}
                disabled={isBusy || (mode === "single" ? (!label || !address) : (!label || parsedBulk.length === 0))}
                style={{ background: "var(--wt-brand)", border: "none", color: "#000", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer", fontWeight: 700, opacity: isBusy ? 0.7 : 1 }}
              >
                {isBusy
                  ? (bulkProgress ?? "SAVING…")
                  : mode === "single"
                    ? "WATCH"
                    : `WATCH ${parsedBulk.length > 0 ? parsedBulk.length : ""} ADDRESS${parsedBulk.length !== 1 ? "ES" : ""}`}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ background: "var(--wt-card-bg)", border: "1px solid var(--wt-border)", borderRadius: 6, overflow: "hidden" }}>
        {isLoading && <div style={{ padding: "20px", textAlign: "center", color: "var(--wt-text-muted)", fontSize: 12 }}>Loading...</div>}
        {!isLoading && addressesData.length === 0 && (
          <div style={{ padding: "20px", textAlign: "center", color: "var(--wt-text-muted)", fontSize: 12 }}>No addresses added yet. Click + Add Address to start watching.</div>
        )}
        {addressesData.map((a, i) => (
          <div key={a.id} style={{ padding: "14px 16px", borderBottom: i < addressesData.length - 1 ? "1px solid var(--wt-divider)" : "none", display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--wt-status-ok)", flexShrink: 0, boxShadow: "0 0 5px color-mix(in srgb, var(--wt-status-ok) 40%, transparent)" }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {editId === a.id ? (
                <input
                  defaultValue={a.label}
                  onKeyDown={e => {
                    if (e.key === "Enter") handleUpdate(a.id, e.currentTarget.value, a.address);
                    if (e.key === "Escape") setEditId(null);
                  }}
                  onBlur={e => handleUpdate(a.id, e.target.value, a.address)}
                  autoFocus
                  style={{ ...inputStyle, border: "1px solid var(--wt-brand)", marginBottom: 2 }}
                />
              ) : (
                <div style={{ fontSize: 12, color: "var(--wt-text)", marginBottom: 2 }}>{a.label}</div>
              )}
              <div style={{ fontSize: 10, color: "var(--wt-text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.address}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "var(--wt-text-muted)" }}>{formatTimeAgo(a.createdAt)}</div>
            </div>
            <button onClick={() => setEditId(a.id)} style={{ background: "transparent", border: "1px solid var(--wt-border)", borderRadius: 3, color: "var(--wt-text-muted)", fontFamily: "inherit", fontSize: 10, padding: "3px 8px", cursor: "pointer" }}>EDIT</button>
            <button onClick={() => handleDelete(a.id)} style={{ background: "transparent", border: "1px solid #7F1D1D44", borderRadius: 3, color: "var(--wt-status-out)", fontFamily: "inherit", fontSize: 10, padding: "3px 8px", cursor: "pointer" }}>RM</button>
          </div>
        ))}
      </div>
    </div>
  );
}
