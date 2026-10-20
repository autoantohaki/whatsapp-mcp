import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import QRCode from "qrcode";
import type { ChannelStatus, DiscoveredChat, MessagingChannel } from "./domain.ts";
import { extensionFor, mimeTypeFor } from "./mime.ts";
import type { MessageStore, StoredChat, StoredMessage } from "./store.ts";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const CATCH_UP_INTERVAL_MS = 2 * 60 * 1000;
const RECONNECT_DELAY_MS = 15 * 1000;

export interface WhatsAppServiceOptions {
  readonly channel: MessagingChannel;
  readonly store: MessageStore;
  readonly qrImagePath: string;
  /** Base folder for relative paths given by Claude (the repository root). */
  readonly workspaceRoot: string;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export interface PairingState {
  readonly state: ChannelStatus["state"];
  readonly detail?: string;
  readonly qr?: string;
  readonly qrImagePath?: string;
  readonly linkedAccount?: { readonly number: string; readonly name?: string };
}

/**
 * Owns the single WhatsApp connection on this computer. Every Claude session
 * talks to this one object (through the local HTTP service), so sessions never
 * compete for the WhatsApp Web login.
 */
export class WhatsAppService {
  private readonly channel: MessagingChannel;
  private readonly store: MessageStore;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly options: WhatsAppServiceOptions;
  private currentQr?: string;
  private catchUpTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopping = false;
  private catchingUp?: Promise<void>;

  constructor(options: WhatsAppServiceOptions) {
    this.options = options;
    this.channel = options.channel;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);

    this.channel.on("message", (message) => {
      this.store.saveMessage(message);
    });
    this.channel.on("qr", async ({ value }) => {
      this.currentQr = value;
      await QRCode.toFile(options.qrImagePath, value, { width: 420, margin: 2 });
      this.log("New pairing QR code ready");
    });
    this.channel.on("status", (status) => this.onStatus(status));
    this.channel.on("error", ({ error }) => this.log(`WhatsApp error: ${error.message}`));
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.catchUpTimer = setInterval(() => void this.catchUp(), CATCH_UP_INTERVAL_MS);
    this.catchUpTimer.unref();
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.catchUpTimer);
    clearTimeout(this.reconnectTimer);
    await this.channel.disconnect();
  }

  private async connect(): Promise<void> {
    try {
      await this.channel.connect();
    } catch (cause) {
      this.log(`Could not start WhatsApp: ${errorMessage(cause)}`);
      this.scheduleReconnect();
    }
  }

  private onStatus(status: ChannelStatus): void {
    this.log(`WhatsApp status: ${status.state}${status.detail ? ` (${status.detail})` : ""}`);
    if (status.state === "ready") {
      this.currentQr = undefined;
      void this.catchUp();
    }
    if (
      (status.state === "disconnected" && status.detail !== "requested") ||
      status.state === "failed"
    ) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref();
  }

  /** Restarts the WhatsApp connection (used when it is stuck). */
  async restart(): Promise<PairingState> {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    await this.channel.disconnect();
    void this.connect();
    await delay(3000);
    return this.pairing();
  }

  pairing(): PairingState {
    const diagnostics = this.channel.diagnostics();
    const status = diagnostics.status;
    const identity = diagnostics.linkedIdentity;
    return {
      state: status.state,
      ...(status.detail ? { detail: status.detail } : {}),
      ...(status.state === "awaiting_qr" && this.currentQr
        ? { qr: this.currentQr, qrImagePath: this.options.qrImagePath }
        : {}),
      ...(status.state === "ready" && identity
        ? {
            linkedAccount: {
              number: phoneOf(identity.externalId),
              ...(identity.displayName ? { name: identity.displayName } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Pulls recent messages for chats that changed while the service was off or
   * the live event stream missed something. Inserts are idempotent.
   */
  catchUp(): Promise<void> {
    if (this.catchingUp) return this.catchingUp;
    this.catchingUp = this.runCatchUp().finally(() => {
      this.catchingUp = undefined;
    });
    return this.catchingUp;
  }

  private async runCatchUp(): Promise<void> {
    if (this.channel.status().state !== "ready") return;
    try {
      const chats = await this.channel.searchChats({ limit: 40, includeGroups: true });
      for (const chat of chats) {
        this.store.saveChat(chat);
        const stored = this.store.latestMessageAt(chat.chatExternalId);
        if (chat.lastActivityAt && (!stored || chat.lastActivityAt > stored)) {
          await this.importHistory(chat.chatExternalId, 50);
        }
      }
    } catch (cause) {
      this.log(`Catch-up failed: ${errorMessage(cause)}`);
    }
  }

  private async importHistory(chatId: string, limit: number): Promise<number> {
    const messages = await this.channel.getRecentMessages({ chatExternalId: chatId, limit });
    let added = 0;
    for (const message of messages) if (this.store.saveMessage(message)) added += 1;
    return added;
  }

  private requireReady(): void {
    const state = this.channel.status().state;
    if (state !== "ready") {
      throw new Error(
        state === "awaiting_qr"
          ? "WhatsApp is not linked yet. Call whatsapp_status to get the QR code and ask the user to scan it."
          : `WhatsApp is not connected right now (state: ${state}). Call whatsapp_status; if it stays like this, call whatsapp_status with restart=true.`,
      );
    }
  }

  /**
   * Accepts a chat ID, a phone number in any common format, or a contact /
   * group name, and returns the WhatsApp chat ID.
   */
  async resolveChat(reference: string): Promise<string> {
    const ref = reference.trim();
    if (!ref) throw new Error("Say which chat: a name, a phone number, or a chat ID.");
    if (ref.includes("@")) return ref;
    const digits = ref.replace(/[\s()+\-.]/g, "");
    if (/^\d{8,15}$/.test(digits)) {
      this.requireReady();
      const id = await this.channel.resolvePhoneNumber(digits);
      if (!id) throw new Error(`The number ${ref} is not on WhatsApp. Check the country and area code.`);
      return id;
    }
    const matches = await this.findChats(ref);
    const exact = matches.filter((chat) => chat.name.toLocaleLowerCase() === ref.toLocaleLowerCase());
    const candidates = exact.length ? exact : matches;
    if (candidates.length === 1) return candidates[0]!.id;
    if (!candidates.length) {
      throw new Error(`No WhatsApp chat matches "${ref}". Try whatsapp_find_chat with part of the name, or use the phone number.`);
    }
    throw new Error(
      `"${ref}" matches several chats; use the chat ID of the right one:\n` +
        candidates.slice(0, 10).map((chat) => `- ${chat.name} (${chat.id})`).join("\n"),
    );
  }

  async findChats(text: string, limit = 15): Promise<StoredChat[]> {
    const byId = new Map<string, StoredChat>();
    if (this.channel.status().state === "ready") {
      const live = await this.channel.searchChats({ text, limit, includeGroups: true, includeArchived: true });
      for (const chat of live) {
        this.store.saveChat(chat);
        byId.set(chat.chatExternalId, liveChat(chat));
      }
    }
    for (const chat of this.store.findChats(text, limit)) if (!byId.has(chat.id)) byId.set(chat.id, chat);
    return [...byId.values()].slice(0, limit);
  }

  inbox(): Array<{ chat: StoredChat; newMessages: number; latest: StoredMessage }> {
    return this.store.inbox();
  }

  async read(input: { chat: string; limit?: number; before?: string; markRead?: boolean }) {
    const chatId = await this.resolveChat(input.chat);
    const limit = Math.min(200, Math.max(1, input.limit ?? 30));
    let warning: string | undefined;
    if (this.channel.status().state === "ready") {
      // Fill gaps from the phone when the archive does not have enough history yet.
      const wanted = input.before ? this.store.countMessages(chatId) + limit : limit;
      if (input.before || this.store.countMessages(chatId) < limit) {
        try {
          await this.importHistory(chatId, Math.min(500, wanted));
        } catch (cause) {
          warning = `Could not load older history from WhatsApp: ${errorMessage(cause)}`;
        }
      }
    } else {
      warning = "WhatsApp is not connected; showing only messages already saved on this computer.";
    }
    const messages = this.store.readMessages(chatId, limit, input.before);
    if (!input.before && input.markRead !== false) this.store.markChecked(chatId, this.now().toISOString());
    return {
      chat: this.store.getChat(chatId) ?? { id: chatId, name: chatId, kind: "unknown" },
      messages,
      ...(warning ? { warning } : {}),
    };
  }

  async search(input: { query: string; chat?: string; limit?: number }) {
    const chatId = input.chat ? await this.resolveChat(input.chat) : undefined;
    return this.store
      .search(input.query, { ...(chatId ? { chatId } : {}), limit: Math.min(100, input.limit ?? 30) })
      .map((message) => ({ ...message, chatName: this.store.getChat(message.chatId)?.name ?? message.chatId }));
  }

  async send(input: { chat: string; text: string; replyTo?: string }) {
    this.requireReady();
    const chatExternalId = await this.resolveChat(input.chat);
    const idempotencyKey = sendKey(chatExternalId, input.text, input.replyTo, this.now());
    const result = input.replyTo
      ? await this.channel.reply({ chatExternalId, text: input.text, idempotencyKey, replyToProviderMessageId: input.replyTo })
      : await this.channel.sendText({ chatExternalId, text: input.text, idempotencyKey });
    return { sent: true, messageId: result.providerMessageId, chat: chatExternalId, at: result.acceptedAt };
  }

  async sendFile(input: { chat: string; path: string; caption?: string }) {
    this.requireReady();
    const chatExternalId = await this.resolveChat(input.chat);
    const path = this.resolvePath(input.path);
    if (!existsSync(path)) throw new Error(`File not found: ${path}`);
    const size = statSync(path).size;
    if (size > MAX_FILE_BYTES) throw new Error(`File is too large to send (${Math.round(size / 1e6)} MB; limit 64 MB).`);
    const result = await this.channel.sendMedia({
      chatExternalId,
      mimeType: mimeTypeFor(path),
      base64: readFileSync(path).toString("base64"),
      filename: basename(path),
      ...(input.caption ? { caption: input.caption } : {}),
      idempotencyKey: sendKey(chatExternalId, `file:${path}:${size}:${input.caption ?? ""}`, undefined, this.now()),
    });
    return { sent: true, messageId: result.providerMessageId, chat: chatExternalId, file: path };
  }

  async downloadMedia(input: { messageId: string; folder: string }) {
    this.requireReady();
    const message = this.store.getMessage(input.messageId);
    const media = await this.channel.downloadMedia(input.messageId);
    const folder = this.resolvePath(input.folder);
    mkdirSync(folder, { recursive: true });
    const date = (message?.occurredAt ?? this.now().toISOString()).slice(0, 10);
    const original = media.filename ?? message?.mediaFilename;
    const name = original
      ? `${date} ${safeFileName(original)}`
      : `${date} ${message?.kind ?? "file"} ${input.messageId.slice(-6)}${extensionFor(media.mimeType)}`;
    const path = uniquePath(join(folder, name));
    writeFileSync(path, Buffer.from(media.base64, "base64"));
    if (message) this.store.setSavedFilePath(message.id, path);
    return { savedTo: path, mimeType: media.mimeType, bytes: statSync(path).size };
  }

  private resolvePath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.options.workspaceRoot, path);
  }
}

function liveChat(chat: DiscoveredChat): StoredChat {
  return {
    id: chat.chatExternalId,
    name: chat.displayName,
    kind: chat.kind,
    ...(chat.lastActivityAt ? { lastActivityAt: chat.lastActivityAt } : {}),
  };
}

/** Same chat + text within ten minutes is treated as a retry, never a second send. */
function sendKey(chat: string, text: string, replyTo: string | undefined, now: Date): string {
  const window = Math.floor(now.getTime() / (10 * 60 * 1000));
  return createHash("sha256").update(`${chat}\u0000${text}\u0000${replyTo ?? ""}\u0000${window}`).digest("hex");
}

function phoneOf(id: string): string {
  const number = id.split("@")[0] ?? id;
  return /^\d+$/.test(number) ? `+${number}` : number;
}

function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 150);
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const dot = path.lastIndexOf(".");
  const [stem, ext] = dot > path.lastIndexOf("/") && dot > path.lastIndexOf("\\") ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let index = 2; ; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
