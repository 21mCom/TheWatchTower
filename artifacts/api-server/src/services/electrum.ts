import net from "net";
import tls from "tls";
import { EventEmitter } from "events";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export type ScripthashNotificationHandler = (scripthash: string, status: string | null) => void;

export interface HistoryEntry {
  tx_hash: string;
  height: number;
}

export class ElectrumClient extends EventEmitter {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private subscriptions = new Set<string>();
  private notificationHandler: ScripthashNotificationHandler | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private _blockHeight: number | null = null;
  private destroyed = false;

  constructor(
    private host: string,
    private port: number,
    private useTls: boolean,
    private reconnectDelayMs: number = 10_000,
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.destroyed) throw new Error("Client has been destroyed");

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
          // Even on initial failure, schedule reconnect
          if (!this.destroyed) {
            this.reconnectTimer = setTimeout(() => this.reconnect(), this.reconnectDelayMs);
          }
        } else {
          resolve();
        }
      };

      const createSocket = (): net.Socket | tls.TLSSocket => {
        if (this.useTls) {
          return tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false });
        }
        return net.connect({ host: this.host, port: this.port });
      };

      const sock = createSocket();
      this.socket = sock;

      // Attach all lifecycle handlers immediately before any event can fire
      sock.on("connect", () => {
        this._connected = true;
        this.buffer = "";
        this.emit("connected");
        settle(); // resolve the connect() promise
      });

      sock.on("secureConnect", () => {
        // For TLS, 'secureConnect' fires instead of 'connect'
        if (!this._connected) {
          this._connected = true;
          this.buffer = "";
          this.emit("connected");
          settle();
        }
      });

      sock.on("data", (data: Buffer) => this.onData(data.toString()));

      sock.on("close", () => {
        this._connected = false;
        this.socket = null;
        // Reject all pending requests
        for (const req of this.pending.values()) {
          req.reject(new Error("Connection closed"));
        }
        this.pending.clear();
        this.emit("disconnected");
        // Schedule reconnect (even if we never successfully connected)
        if (!this.destroyed) {
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.reconnect(), this.reconnectDelayMs);
        }
      });

      sock.on("error", (err: Error) => {
        // Only propagate if there are listeners — unhandled error events crash Node.js
        if (this.listenerCount("error") > 0) {
          this.emit("error", err);
        }
        settle(err); // reject the connect() promise if still pending
        // 'close' fires after 'error'; the close handler schedules the reconnect
      });
    });
  }

  private onData(data: string) {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: unknown[];
          result?: unknown;
          error?: { message?: string };
        };
        this.handleMessage(msg);
      } catch {
        // ignore malformed
      }
    }
  }

  private handleMessage(msg: {
    id?: number;
    method?: string;
    params?: unknown[];
    result?: unknown;
    error?: { message?: string };
  }) {
    if (msg.id != null) {
      const req = this.pending.get(msg.id);
      if (req) {
        this.pending.delete(msg.id);
        if (msg.error) {
          req.reject(new Error(msg.error.message ?? String(msg.error)));
        } else {
          req.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method === "blockchain.scripthash.subscribe" && Array.isArray(msg.params)) {
      const [scripthash, status] = msg.params as [string, string | null];
      this.notificationHandler?.(scripthash, status);
    } else if (msg.method === "blockchain.headers.subscribe" && Array.isArray(msg.params)) {
      const header = msg.params[0] as { height?: number };
      if (header?.height != null) {
        this._blockHeight = header.height;
        this.emit("blockHeight", this._blockHeight);
      }
    }
  }

  private async reconnect() {
    if (this.destroyed) return;
    this.reconnectTimer = null;
    try {
      await this.connect();
      // Restore header subscription
      await this.rpc("blockchain.headers.subscribe", []).then((r) => {
        const result = r as { height?: number };
        if (result?.height != null) this._blockHeight = result.height;
      }).catch(() => {});

      // Re-subscribe all tracked scripthashes and trigger catch-up
      for (const sh of this.subscriptions) {
        const status = await this.rpc("blockchain.scripthash.subscribe", [sh]).catch(() => null);
        // Emit as a notification so the monitor can catch up
        if (status !== undefined) {
          this.notificationHandler?.(sh, status as string | null);
        }
      }
      this.emit("reconnected");
    } catch {
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.reconnect(), this.reconnectDelayMs);
      }
    }
  }

  private rpc(method: string, params: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this._connected) {
        reject(new Error("Not connected"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ id, method, params }) + "\n";
      this.socket.write(msg);
    });
  }

  setNotificationHandler(handler: ScripthashNotificationHandler) {
    this.notificationHandler = handler;
  }

  async ping(): Promise<void> {
    await this.rpc("server.ping", []);
  }

  async subscribeHeaders(): Promise<{ height: number }> {
    const result = await this.rpc("blockchain.headers.subscribe", []) as { height: number };
    if (result?.height != null) this._blockHeight = result.height;
    return result;
  }

  /**
   * Subscribe to a scripthash and return the current status string.
   * null means no history. Any non-null value means there is history —
   * callers should fetch it immediately to catch up on missed transactions.
   */
  async subscribeScripthash(scripthash: string): Promise<string | null> {
    this.subscriptions.add(scripthash);
    return this.rpc("blockchain.scripthash.subscribe", [scripthash]) as Promise<string | null>;
  }

  removeScripthash(scripthash: string) {
    this.subscriptions.delete(scripthash);
  }

  async getHistory(scripthash: string): Promise<HistoryEntry[]> {
    return this.rpc("blockchain.scripthash.get_history", [scripthash]) as Promise<HistoryEntry[]>;
  }

  async getTransaction(txid: string): Promise<string> {
    return this.rpc("blockchain.transaction.get", [txid, false]) as Promise<string>;
  }

  get connected(): boolean {
    return this._connected;
  }

  get blockHeight(): number | null {
    return this._blockHeight;
  }

  /** Number of scripthashes currently tracked for re-subscription. Exposed for testing. */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const req of this.pending.values()) {
      req.reject(new Error("Client destroyed"));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = null;
    this._connected = false;
  }
}
