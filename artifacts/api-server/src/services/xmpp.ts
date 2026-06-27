import { client, xml } from "@xmpp/client";

export interface XmppConfig {
  server: string;
  port: number;
  jid: string;
  password: string;
  tls: boolean;
  recipientJid: string;
}

export class XmppService {
  private xmppClient: ReturnType<typeof client> | null = null;
  private _connected = false;
  private config: XmppConfig | null = null;

  configure(config: XmppConfig) {
    this.disconnect();
    this.config = config;
  }

  async connect(): Promise<void> {
    if (!this.config) throw new Error("XMPP not configured");
    const { server, port, jid, password, tls: useTls } = this.config;

    const scheme = useTls ? "xmpps" : "xmpp";
    const service = `${scheme}://${server}:${port}`;
    const domain = jid.split("@")[1] ?? server;
    const username = jid.split("@")[0]!;

    this.xmppClient = client({ service, domain, username, password });

    this.xmppClient.on("online", () => {
      this._connected = true;
    });
    this.xmppClient.on("offline", () => {
      this._connected = false;
    });
    this.xmppClient.on("error", (err: Error) => {
      console.error("[xmpp] error", err.message);
    });

    await this.xmppClient.start();
  }

  async sendAlert(body: string): Promise<void> {
    if (!this.config) throw new Error("XMPP not configured");
    if (!this.xmppClient || !this._connected) {
      throw new Error("XMPP not connected");
    }
    const to = this.config.recipientJid;
    await this.xmppClient.send(
      xml("message", { to, type: "chat" }, xml("body", {}, body)),
    );
  }

  isConnected(): boolean {
    return this._connected;
  }

  isConfigured(): boolean {
    return !!(
      this.config?.jid &&
      this.config?.password &&
      this.config?.server &&
      this.config?.recipientJid
    );
  }

  disconnect() {
    if (this.xmppClient) {
      this.xmppClient.stop().catch(() => {});
      this.xmppClient = null;
    }
    this._connected = false;
    this.config = null;
  }
}
