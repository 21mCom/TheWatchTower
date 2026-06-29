CREATE TABLE "watched_addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"scripthash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watched_addresses_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"electrum_host" text DEFAULT 'localhost' NOT NULL,
	"electrum_port" integer DEFAULT 50001 NOT NULL,
	"electrum_tls" boolean DEFAULT false NOT NULL,
	"electrum_allow_self_signed" boolean DEFAULT false NOT NULL,
	"confirmation_threshold" integer DEFAULT 1 NOT NULL,
	"xmpp_server" text DEFAULT '' NOT NULL,
	"xmpp_port" integer DEFAULT 5222 NOT NULL,
	"xmpp_jid" text DEFAULT '' NOT NULL,
	"xmpp_password" text DEFAULT '' NOT NULL,
	"xmpp_tls" boolean DEFAULT true NOT NULL,
	"recipient_jid" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_events" (
	"id" text PRIMARY KEY NOT NULL,
	"address_id" text NOT NULL,
	"txid" text NOT NULL,
	"direction" text NOT NULL,
	"amount_sats" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"block_height" integer,
	"mempool_alerted_at" timestamp with time zone,
	"confirmed_alerted_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "alert_events_address_id_txid_idx" ON "alert_events" USING btree ("address_id","txid");