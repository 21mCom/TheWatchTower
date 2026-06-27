import { useState } from "react";
import { useListAddresses, useCreateAddress, useUpdateAddress, useDeleteAddress, getListAddressesQueryKey } from "@workspace/api-client-react";
import { formatBtc, truncateAddress, formatTimeAgo } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function Addresses() {
  const [addOpen, setAddOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  
  const { data: addresses, isLoading } = useListAddresses();
  const addressesData = addresses || [];
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createAddress = useCreateAddress();
  const updateAddress = useUpdateAddress();
  const deleteAddress = useDeleteAddress();

  const handleWatch = async () => {
    if (!label || !address) return;
    try {
      await createAddress.mutateAsync({ data: { label, address } });
      queryClient.invalidateQueries({ queryKey: getListAddressesQueryKey() });
      setAddOpen(false);
      setLabel("");
      setAddress("");
      toast({ title: "Address added" });
    } catch (err: any) {
      toast({ title: "Error adding address", description: err.message, variant: "destructive" });
    }
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

  return (
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
              <input 
                placeholder="e.g. Cold Storage — Main" 
                value={label}
                onChange={e => setLabel(e.target.value)}
                style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "8px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} 
              />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#2A4060", letterSpacing: "0.08em", marginBottom: 4 }}>BITCOIN ADDRESS</div>
              <input 
                placeholder="bc1q... or 1... or 3..." 
                value={address}
                onChange={e => setAddress(e.target.value)}
                style={{ background: "#080D14", border: "1px solid #1E2D40", borderRadius: 4, color: "#CBD5E1", fontFamily: "inherit", fontSize: 12, padding: "8px 10px", width: "100%", outline: "none", boxSizing: "border-box" }} 
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <button onClick={() => setAddOpen(false)} style={{ background: "transparent", border: "1px solid #1E2D40", color: "#4A6080", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer" }}>CANCEL</button>
              <button 
                onClick={handleWatch}
                disabled={createAddress.isPending}
                style={{ background: "#F7931A", border: "none", color: "#000", fontFamily: "inherit", fontSize: 11, padding: "6px 14px", borderRadius: 4, cursor: "pointer", fontWeight: 700, opacity: createAddress.isPending ? 0.7 : 1 }}
              >
                {createAddress.isPending ? "SAVING..." : "WATCH"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ background: "#0D1320", border: "1px solid #1E2D40", borderRadius: 6, overflow: "hidden" }}>
        {isLoading && <div style={{ padding: "20px", textAlign: "center", color: "#4A6080", fontSize: 12 }}>Loading...</div>}
        {!isLoading && addressesData.length === 0 && (
          <div style={{ padding: "20px", textAlign: "center", color: "#4A6080", fontSize: 12 }}>No addresses added yet. Click + Add Address to start watching.</div>
        )}
        {addressesData.map((a, i) => (
          <div key={a.id} style={{ padding: "14px 16px", borderBottom: i < addressesData.length - 1 ? "1px solid #111B28" : "none", display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#22C55E", flexShrink: 0, boxShadow: "0 0 5px #22C55E66" }} />
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
                  style={{ background: "#080D14", border: "1px solid #F7931A", borderRadius: 4, color: "#E2E8F0", fontSize: 12, padding: "4px 8px", width: "100%", outline: "none", marginBottom: 2, boxSizing: "border-box" }}
                />
              ) : (
                <div style={{ fontSize: 12, color: "#E2E8F0", marginBottom: 2 }}>{a.label}</div>
              )}
              <div style={{ fontSize: 10, color: "#2A4060", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.address}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "#4A6080" }}>{formatTimeAgo(a.createdAt)}</div>
            </div>
            <button onClick={() => setEditId(a.id)} style={{ background: "transparent", border: "1px solid #1E2D40", borderRadius: 3, color: "#4A6080", fontFamily: "inherit", fontSize: 10, padding: "3px 8px", cursor: "pointer" }}>EDIT</button>
            <button onClick={() => handleDelete(a.id)} style={{ background: "transparent", border: "1px solid #7F1D1D44", borderRadius: 3, color: "#F87171", fontFamily: "inherit", fontSize: 10, padding: "3px 8px", cursor: "pointer" }}>RM</button>
          </div>
        ))}
      </div>
    </div>
  );
}
