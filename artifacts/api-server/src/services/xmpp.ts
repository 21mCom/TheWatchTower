import { client, xml } from "@xmpp/client";

export interface XmppConfig {
  /**
   * Explicit server host. When empty, the endpoint is discovered via SRV
   * records from the JID's domain (the standard way to configure hosted XMPP).
   */
  server: string;
  port: number;
  jid: string;
  password: string;
  tls: boolean;
  recipientJid: string;
}

/** Classification of a connection failure so callers can report a specific reason. */
export type XmppErrorKind = "auth" | "host-not-found" | "tls" | "timeout" | "other";

export interface XmppConnectionError {
  kind: XmppErrorKind;
  message: string;
}

/** Error thrown by connect() carrying the classified failure reason. */
export class XmppConnectError extends Error {
  kind: XmppErrorKind;
  constructor(info: XmppConnectionError) {
    super(info.message);
    this.name = "XmppConnectError";
    this.kind = info.kind;
  }
}

export class XmppService {
  private xmppClient: ReturnType<typeof client> | null = null;
  private _connected = false;
  private config: XmppConfig | null = null;
  private lastError: XmppConnectionError | null = null;

  // Auto-reconnect state — mirrors the ElectrumClient approach: a single
  // idempotent scheduler drives all retries so failures can never stack
  // overlapping timers.
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private connecting = false;
  private wasOnline = false;

  private readonly reconnectDelayMs = process.env.XMPP_RECONNECT_DELAY_MS
    ? parseInt(process.env.XMPP_RECONNECT_DELAY_MS, 10)
    : 10_000;
  private readonly connectTimeoutMs = process.env.XMPP_CONNECT_TIMEOUT_MS
    ? parseInt(process.env.XMPP_CONNECT_TIMEOUT_MS, 10)
    : 15_000;

  configure(config: XmppConfig) {
    this.disconnect();
    this.config = config;
    this.lastError = null;
    this.stopped = false;
  }

  /**
   * Attempt a connection. Resolves once online. On failure it records the
   * classified reason, schedules an automatic retry (except for permanent auth
   * failures, which cannot recover without a settings change), and throws an
   * XmppConnectError so callers (e.g. the test-alert route) can report why.
   */
  async connect(): Promise<void> {
    if (!this.config) throw new Error("XMPP not configured");
    this.stopped = false;
    // Cancel any pending scheduled retry — we are attempting right now.
    this.clearReconnectTimer();

    if (this.connecting) {
      throw new Error("An XMPP connection attempt is already in progress.");
    }
    this.connecting = true;
    try {
      await this.doConnect();
      this.clearReconnectTimer();
    } catch (err) {
      const info = err instanceof XmppConnectError ? { kind: err.kind, message: err.message } : this.classify(err);
      this.lastError = info;
      // Retry transient failures automatically. Auth failures are permanent
      // until the credentials change (which reconfigures us anyway), so we do
      // not hammer the server retrying them.
      if (info.kind !== "auth") this.scheduleReconnect();
      throw err instanceof XmppConnectError ? err : new XmppConnectError(info);
    } finally {
      this.connecting = false;
    }
  }

  private async doConnect(): Promise<void> {
    if (!this.config) throw new Error("XMPP not configured");
    const { server, port, jid, password, tls: useTls } = this.config;

    const domain = jid.split("@")[1] ?? server;
    const username = jid.split("@")[0]!;

    // Explicit host/port takes precedence and maps the TLS flag coherently:
    //   TLS on  -> direct-TLS ("xmpps" scheme, typically port 443)
    //   TLS off -> STARTTLS   ("xmpp"  scheme, typically port 5222)
    // When no host is given, pass the bare JID domain so @xmpp/resolve performs
    // an SRV lookup (xmpps-client + xmpp-client) and picks the right endpoint.
    const hasExplicitHost = !!server && server.trim().length > 0;
    const service = hasExplicitHost
      ? `${useTls ? "xmpps" : "xmpp"}://${server}:${port}`
      : domain;

    const xmppClient = this.createClient({ service, domain, username, password });
    // We manage reconnection ourselves via a single idempotent scheduler, so
    // disable the library's built-in reconnect to avoid overlapping retry loops.
    // (`reconnect` exists at runtime but is not on the exported client type.)
    (xmppClient as unknown as { reconnect?: { stop: () => void } }).reconnect?.stop();
    this.xmppClient = xmppClient;

    xmppClient.on("online", () => {
      this._connected = true;
      this.wasOnline = true;
      this.lastError = null;
    });
    xmppClient.on("offline", () => {
      this._connected = false;
      // Only a drop of a previously-established session should trigger a retry
      // here; failed initial connects are handled by connect()/scheduleReconnect.
      if (this.wasOnline && !this.stopped) {
        this.wasOnline = false;
        this.scheduleReconnect();
      }
    });
    // An unhandled 'error' event would crash the process; capture it instead.
    xmppClient.on("error", (err: Error) => {
      this.lastError = this.classify(err);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new XmppConnectError({
          kind: "timeout",
          message: `Connection timed out after ${this.connectTimeoutMs}ms — check the server host and port.`,
        }));
      }, this.connectTimeoutMs);
    });

    try {
      await Promise.race([xmppClient.start(), timeout]);
      this._connected = true;
      this.wasOnline = true;
      this.lastError = null;
    } catch (err) {
      const info = err instanceof XmppConnectError ? { kind: err.kind, message: err.message } : this.classify(err);
      this.lastError = info;
      // Tear down the failed client so it can't linger or emit late events.
      if (this.xmppClient === xmppClient) {
        this.xmppClient = null;
        this._connected = false;
      }
      this.wasOnline = false;
      try {
        await xmppClient.stop();
      } catch {
        // ignore teardown errors
      }
      throw new XmppConnectError(info);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Creates the underlying @xmpp/client. Extracted into an overridable method so
   * tests can inject a fake client (e.g. one whose start() never resolves) to
   * exercise the connect-timeout path without a real network.
   */
  protected createClient(options: {
    service: string;
    domain: string;
    username: string;
    password: string;
  }): ReturnType<typeof client> {
    return client(options);
  }

  /** Translate a raw connection error into a specific, user-facing reason. */
  private classify(err: unknown): XmppConnectionError {
    const anyErr = err as { name?: string; condition?: string; code?: string; message?: string } | undefined;
    const name = anyErr?.name ?? "";
    const condition = anyErr?.condition ?? "";
    const code = anyErr?.code ?? "";
    const message = String(anyErr?.message ?? err ?? "");
    const haystack = `${name} ${condition} ${code} ${message}`;

    if (name === "SASLError" || /not-authorized|SASL|authentication|invalid credentials|bad[- ]?auth/i.test(haystack)) {
      return { kind: "auth", message: "Authentication failed — check the JID and password." };
    }
    if (/timed out|timeout|ETIMEDOUT/i.test(haystack)) {
      return { kind: "timeout", message: `Connection timed out after ${this.connectTimeoutMs}ms — check the server host and port.` };
    }
    if (/CERT|_SSL|\bTLS\b|handshake|self[- ]?signed|unable to (?:get|verify)|DEPTH_ZERO|ERR_TLS|WRONG_VERSION/i.test(haystack)) {
      return { kind: "tls", message: `TLS/handshake error — check the port and the “Use TLS” setting. (${message})` };
    }
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET|getaddrinfo|No compatible transport|Couldn't connect|No endpoints/i.test(haystack)) {
      return { kind: "host-not-found", message: "Could not reach the XMPP server — check the server host and port (or leave the host blank to auto-discover)." };
    }
    return { kind: "other", message: message || "Unknown XMPP connection error." };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    if (!this.config) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectOnce();
    }, this.reconnectDelayMs);
  }

  private async reconnectOnce() {
    if (this.stopped || !this.config) return;
    try {
      await this.connect();
    } catch {
      // connect() already recorded lastError and scheduled the next retry
      // (unless the failure was a permanent auth error).
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Ensure there is a live connection, attempting one (and surfacing the
   * classified failure reason) if we are not currently connected.
   */
  async ensureConnected(): Promise<void> {
    if (this._connected && this.xmppClient) return;
    await this.connect();
  }

  /** Internal transport — sends a raw message body over the XMPP connection. */
  private async _send(body: string): Promise<void> {
    if (!this.config) throw new Error("XMPP not configured");
    if (!this.xmppClient || !this._connected) {
      throw new Error("XMPP not connected");
    }
    const to = this.config.recipientJid;
    await this.xmppClient.send(
      xml("message", { to, type: "chat" }, xml("body", {}, body)),
    );
  }

  /** Send a transaction alert. Tests may mock this method to observe transaction-level sends. */
  async sendAlert(body: string): Promise<void> {
    return this._send(body);
  }

  /**
   * Send a connection-status notification (node up/down).
   * Calls _send directly so tests that mock sendAlert (transaction alerts only)
   * do not intercept connection-level noise.
   */
  async sendConnectionAlert(body: string): Promise<void> {
    return this._send(body);
  }

  isConnected(): boolean {
    return this._connected;
  }

  isConfigured(): boolean {
    // The server host is optional (blank = SRV auto-discovery), so it is not required here.
    return !!(this.config?.jid && this.config?.password && this.config?.recipientJid);
  }

  /** The most recent classified connection failure, or null if none/connected. */
  getLastError(): XmppConnectionError | null {
    return this.lastError;
  }

  disconnect() {
    this.stopped = true;
    this.clearReconnectTimer();
    if (this.xmppClient) {
      this.xmppClient.stop().catch(() => {});
      this.xmppClient = null;
    }
    this._connected = false;
    this.wasOnline = false;
    this.config = null;
  }
}
