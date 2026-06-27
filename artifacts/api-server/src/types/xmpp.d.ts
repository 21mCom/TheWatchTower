declare module "@xmpp/client" {
  import { EventEmitter } from "events";

  export interface XmlElement {
    name: string;
    attrs: Record<string, string>;
    children: XmlElement[];
    text(): string;
    toString(): string;
    getChild(name: string): XmlElement | undefined;
    getChildText(name: string): string | undefined;
  }

  export function xml(name: string, attrs?: Record<string, string>, ...children: (XmlElement | string)[]): XmlElement;

  export interface XmppClient extends EventEmitter {
    start(): Promise<string>;
    stop(): Promise<void>;
    send(stanza: XmlElement): Promise<void>;
    status: string;
  }

  export interface ClientOptions {
    service: string;
    domain: string;
    username: string;
    password: string;
  }

  export function client(options: ClientOptions): XmppClient;
}

declare module "@xmpp/xml" {
  export function xml(name: string, attrs?: Record<string, string>, ...children: unknown[]): unknown;
}
