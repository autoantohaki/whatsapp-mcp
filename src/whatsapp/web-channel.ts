import type {
  ChannelDiagnosticCounters,
  ChannelDiagnostics,
  ChannelEventHandler,
  ChannelEventName,
  ChannelStatus,
  DeliveryState,
  DiscoveredChat,
  DownloadedMedia,
  MessagingChannel,
  MessageKind,
  NormalizedMessage,
  RecentMessagesQuery,
  ReplyCommand,
  SearchChatsQuery,
  SendResult,
  SendMediaCommand,
  SendTextCommand,
  Unsubscribe,
} from "../domain.ts";
import { assertSendCommand, assertSendMediaCommand } from "../domain.ts";
import { ChannelEventBus } from "./event-bus.ts";

export interface WhatsAppMessageIdLike {
  readonly _serialized: string;
}

export interface WhatsAppMessageLike {
  readonly id: WhatsAppMessageIdLike;
  readonly from: string;
  readonly to: string;
  readonly author?: string;
  readonly fromMe: boolean;
  readonly body: string;
  readonly type: string;
  readonly timestamp: number;
  readonly hasMedia?: boolean;
  readonly hasQuotedMsg?: boolean;
  readonly _data?: {
    readonly mimetype?: string;
    readonly filename?: string;
    readonly size?: number;
  };
  getQuotedMessage?(): Promise<WhatsAppMessageLike>;
  downloadMedia?(): Promise<
    { mimetype: string; data: string; filename?: string | null } | undefined
  >;
  reply(text: string): Promise<WhatsAppMessageLike>;
}

export interface WhatsAppChatSummaryLike {
  readonly id?: WhatsAppMessageIdLike;
  readonly name?: string;
  readonly isGroup?: boolean;
  readonly archived?: boolean;
  readonly unreadCount?: number;
  readonly timestamp?: number;
}

export interface WhatsAppChatLike extends WhatsAppChatSummaryLike {
  fetchMessages(options: { limit: number }): Promise<WhatsAppMessageLike[]>;
}

export interface WhatsAppClientLike {
  readonly info?: {
    readonly wid?: WhatsAppMessageIdLike;
    readonly pushname?: string;
    readonly platform?: string;
  };
  on(event: string, handler: (...args: any[]) => void): unknown;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  sendMessage(
    chatId: string,
    content: unknown,
    options?: { readonly sendSeen?: boolean; readonly linkPreview?: boolean; readonly caption?: string },
  ): Promise<WhatsAppMessageLike | undefined>;
  getMessageById(id: string): Promise<WhatsAppMessageLike | undefined>;
  getChatById(id: string): Promise<WhatsAppChatLike>;
  getChats?(): Promise<WhatsAppChatLike[]>;
  getNumberId?(number: string): Promise<WhatsAppMessageIdLike | null>;
  getState?(): Promise<string>;
  getWWebVersion?(): Promise<string>;
  readonly pupPage?: {
    evaluate<T>(pageFunction: (...args: any[]) => T | Promise<T>, ...args: any[]): Promise<T>;
  };
}

export interface WhatsAppClientFactoryOptions {
  readonly authDataPath: string;
  readonly clientId: string;
  readonly headless: boolean;
  readonly executablePath?: string;
  readonly browserArgs: readonly string[];
}

export type WhatsAppClientFactory = (
  options: WhatsAppClientFactoryOptions,
) => Promise<WhatsAppClientLike>;

export interface WhatsAppWebChannelOptions {
  readonly authDataPath?: string;
  readonly clientId?: string;
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly browserArgs?: readonly string[];
  readonly maxRememberedMessageIds?: number;
  readonly clientFactory?: WhatsAppClientFactory;
  readonly now?: () => Date;
}

const defaultClientFactory: WhatsAppClientFactory = async (options) => {
  // whatsapp-web.js is CommonJS. Node's ESM bridge exposes only part of its
  // surface as synthetic named exports, so LocalAuth must come from default.
  const namespace = await import("whatsapp-web.js");
  const module = namespace.default ?? namespace;
  const client = new module.Client({
    authStrategy: new module.LocalAuth({
      dataPath: options.authDataPath,
      clientId: options.clientId,
    }),
    puppeteer: {
      headless: options.headless,
      ...(options.executablePath
        ? { executablePath: options.executablePath }
        : {}),
      args: [...options.browserArgs],
    },
  });
  return client as unknown as WhatsAppClientLike;
};

/**
 * Event-driven whatsapp-web.js adapter. The adapter never asks a model to
 * inspect or operate WhatsApp's DOM. Tests inject a client factory, keeping QR
 * sessions and Chromium out of ordinary CI runs.
 */
export class WhatsAppWebChannel implements MessagingChannel {
  private readonly events = new ChannelEventBus();
  private readonly now: () => Date;
  private readonly options: Required<
    Pick<
      WhatsAppWebChannelOptions,
      | "authDataPath"
      | "clientId"
      | "headless"
      | "maxRememberedMessageIds"
      | "browserArgs"
    >
  > &
    Pick<WhatsAppWebChannelOptions, "executablePath">;
  private readonly clientFactory: WhatsAppClientFactory;
  private currentStatus: ChannelStatus;
  private client?: WhatsAppClientLike;
  private connectPromise?: Promise<void>;
  private disconnectPromise?: Promise<void>;
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageOrder: string[] = [];
  private readonly sendsByKey = new Map<string, SendResult>();
  private readonly sendKeyOrder: string[] = [];
  private readonly inFlightSends = new Map<string, Promise<SendResult>>();
  private readonly pendingAgentMessages = new Map<
    string,
    Array<{ consumed: boolean }>
  >();
  private readonly agentMessageIds = new Set<string>();
  private readonly agentMessageOrder: string[] = [];
  private counters: ChannelDiagnosticCounters = emptyCounters();
  private linkedIdentity?: ChannelDiagnostics["linkedIdentity"];
  private providerState?: string;
  private webVersion?: string;
  private lastRawEvent?: ChannelDiagnostics["lastRawEvent"];
  private lastRawMessage?: ChannelDiagnostics["lastRawMessage"];
  private lastEmittedMessage?: ChannelDiagnostics["lastEmittedMessage"];
  private lastError?: ChannelDiagnostics["lastError"];

  constructor(options: WhatsAppWebChannelOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.options = {
      authDataPath: options.authDataPath ?? ".data/whatsapp-auth",
      clientId: options.clientId ?? "companion",
      headless: options.headless ?? true,
      maxRememberedMessageIds: Math.max(
        1,
        options.maxRememberedMessageIds ?? 10_000,
      ),
      browserArgs: options.browserArgs ?? [],
      ...(options.executablePath
        ? { executablePath: options.executablePath }
        : {}),
    };
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.currentStatus = {
      state: "idle",
      changedAt: this.now().toISOString(),
    };
  }

  status(): ChannelStatus {
    return this.currentStatus;
  }

  diagnostics(): ChannelDiagnostics {
    return {
      status: this.currentStatus,
      ...(this.linkedIdentity ? { linkedIdentity: this.linkedIdentity } : {}),
      ...(this.providerState ? { providerState: this.providerState } : {}),
      ...(this.webVersion ? { webVersion: this.webVersion } : {}),
      ...(this.lastRawEvent ? { lastRawEvent: this.lastRawEvent } : {}),
      ...(this.lastRawMessage ? { lastRawMessage: this.lastRawMessage } : {}),
      ...(this.lastEmittedMessage
        ? { lastEmittedMessage: this.lastEmittedMessage }
        : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      counters: { ...this.counters },
    };
  }

  on<K extends ChannelEventName>(
    event: K,
    handler: ChannelEventHandler<K>,
  ): Unsubscribe {
    return this.events.on(event, handler);
  }

  connect(): Promise<void> {
    if (this.currentStatus.state === "ready") return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.initialize().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  disconnect(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    this.disconnectPromise = this.destroy().finally(() => {
      this.disconnectPromise = undefined;
    });
    return this.disconnectPromise;
  }

  async sendText(command: SendTextCommand): Promise<SendResult> {
    assertSendCommand(command);
    const previous = this.sendsByKey.get(command.idempotencyKey);
    if (previous) return previous;
    const inFlight = this.inFlightSends.get(command.idempotencyKey);
    if (inFlight) return inFlight;

    const operation = this.sendTextOnce(command)
      .catch((cause) => {
        this.recordError(cause);
        throw cause;
      })
      .finally(() => {
        this.inFlightSends.delete(command.idempotencyKey);
      });
    this.inFlightSends.set(command.idempotencyKey, operation);
    return operation;
  }

  async sendMedia(command: SendMediaCommand): Promise<SendResult> {
    assertSendMediaCommand(command);
    const previous=this.sendsByKey.get(command.idempotencyKey);if(previous)return previous;
    const inFlight=this.inFlightSends.get(command.idempotencyKey);if(inFlight)return inFlight;
    const operation=this.sendMediaOnce(command).catch(cause=>{this.recordError(cause);throw cause;}).finally(()=>this.inFlightSends.delete(command.idempotencyKey));
    this.inFlightSends.set(command.idempotencyKey,operation);return operation;
  }

  private async sendMediaOnce(command:SendMediaCommand):Promise<SendResult>{
    const client=this.requireReadyClient();const namespace=await import('whatsapp-web.js');const module=namespace.default??namespace;
    const Media=(module as unknown as {MessageMedia:new(mimetype:string,data:string,filename?:string)=>unknown}).MessageMedia;
    if(!Media)throw new Error('WhatsApp media support is unavailable');
    const message=await client.sendMessage(command.chatExternalId,new Media(command.mimeType,command.base64,command.filename),{sendSeen:false,linkPreview:false,...(command.caption?{caption:command.caption}:{})});
    if(!message)throw new Error('WhatsApp did not expose a delivery receipt after media dispatch.');
    const result=this.toSendResult(message,command.chatExternalId);this.rememberAgentMessageId(result.providerMessageId);this.rememberSend(command.idempotencyKey,result);return result;
  }

  async reply(command: ReplyCommand): Promise<SendResult> {
    assertSendCommand(command);
    if (!command.replyToProviderMessageId.trim()) {
      throw new Error("replyToProviderMessageId is required");
    }
    const previous = this.sendsByKey.get(command.idempotencyKey);
    if (previous) return previous;
    const inFlight = this.inFlightSends.get(command.idempotencyKey);
    if (inFlight) return inFlight;

    const operation = this.replyOnce(command)
      .catch((cause) => {
        this.recordError(cause);
        throw cause;
      })
      .finally(() => {
        this.inFlightSends.delete(command.idempotencyKey);
      });
    this.inFlightSends.set(command.idempotencyKey, operation);
    return operation;
  }

  private async sendTextOnce(command: SendTextCommand): Promise<SendResult> {
    const client = this.requireReadyClient();
    const signature = sendSignature(command.chatExternalId, command.text);
    const reservation = this.reservePending(signature);
    try {
      const existingIds = await matchingOutboundIds(
        client,
        command.chatExternalId,
        command.text,
      );
      let message: WhatsAppMessageLike | undefined;
      let sendError: unknown;
      try {
        message = await client.sendMessage(
          command.chatExternalId,
          command.text,
          // The current WhatsApp Web build intermittently throws opaque module
          // errors while marking group chats as seen or resolving link previews.
          // Neither side effect is required to deliver a plain-text message.
          { sendSeen: false, linkPreview: false },
        );
      } catch (cause) {
        // Some WhatsApp Web revisions throw after addAndSendMsgToChat has
        // already accepted the message. Recover the newly-created provider
        // message before reporting failure, otherwise a retry duplicates it.
        sendError = cause;
      }
      message ??= await findNewOutboundMessage(
        client,
        command.chatExternalId,
        command.text,
        existingIds,
      );
      if (!message) {
        if (sendError) throw sendError;
        throw new Error("WhatsApp did not expose a delivery receipt after dispatch.");
      }
      const result = this.toSendResult(message, command.chatExternalId);
      this.rememberAgentMessageId(result.providerMessageId);
      this.rememberSend(command.idempotencyKey, result);
      return result;
    } finally {
      // message_create is normally emitted before sendMessage resolves. Any
      // unused marker is removed here so later owner messages cannot inherit it.
      this.releasePending(signature, reservation);
    }
  }

  private async replyOnce(command: ReplyCommand): Promise<SendResult> {
    const client = this.requireReadyClient();
    const source = await client.getMessageById(command.replyToProviderMessageId);
    if (!source) {
      throw new Error(
        `WhatsApp message ${command.replyToProviderMessageId} was not found`,
      );
    }
    const sourceChatId = chatIdOf(source);
    if (sourceChatId !== command.chatExternalId) {
      throw new Error(
        `Reply target belongs to ${sourceChatId}, not ${command.chatExternalId}`,
      );
    }

    const signature = sendSignature(command.chatExternalId, command.text);
    const reservation = this.reservePending(signature);
    try {
      const message = await source.reply(command.text);
      const result = this.toSendResult(message, command.chatExternalId);
      this.rememberAgentMessageId(result.providerMessageId);
      this.rememberSend(command.idempotencyKey, result);
      return result;
    } finally {
      this.releasePending(signature, reservation);
    }
  }

  async getRecentMessages(
    query: RecentMessagesQuery,
  ): Promise<NormalizedMessage[]> {
    const client = this.requireReadyClient();
    const limit = Math.min(500, Math.max(1, query.limit ?? 50));
    this.increment("historyFetches");
    try {
      let messages: WhatsAppMessageLike[];
      try {
        const chat = await client.getChatById(query.chatExternalId);
        messages = await chat.fetchMessages({ limit });
      } catch (primaryError) {
        if (!client.pupPage) throw primaryError;
        messages = await fetchLightweightMessages(client, query.chatExternalId, limit);
      }
      const normalized = await Promise.all(
        messages.map((message) =>
          this.normalizeMessage(
            message,
            this.agentMessageIds.has(message.id._serialized),
          ),
        ),
      );
      return normalized.sort((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt),
      );
    } catch (cause) {
      this.recordError(cause);
      throw asError(cause);
    }
  }

  async resolvePhoneNumber(digits: string): Promise<string | undefined> {
    const client = this.requireReadyClient();
    // WhatsApp's own lookup is needed because some numbers (for example older
    // Brazilian mobiles without the extra 9) are registered under another ID.
    if (!client.getNumberId) return `${digits}@c.us`;
    try {
      const id = await client.getNumberId(digits);
      return id?._serialized || undefined;
    } catch (cause) {
      this.recordError(cause);
      throw asError(cause);
    }
  }

  async downloadMedia(providerMessageId: string): Promise<DownloadedMedia> {
    const client = this.requireReadyClient();
    try {
      const message = await client.getMessageById(providerMessageId);
      if (!message) {
        throw new Error(`WhatsApp message ${providerMessageId} was not found`);
      }
      if (!message.hasMedia || !message.downloadMedia) {
        throw new Error(`WhatsApp message ${providerMessageId} has no attachment`);
      }
      const media = await message.downloadMedia();
      if (!media?.data) {
        throw new Error(
          "WhatsApp could not download this attachment (it may have expired on the phone)",
        );
      }
      return {
        mimeType: media.mimetype,
        base64: media.data,
        ...(media.filename ? { filename: media.filename } : {}),
      };
    } catch (cause) {
      this.recordError(cause);
      throw asError(cause);
    }
  }

  async searchChats(query: SearchChatsQuery = {}): Promise<DiscoveredChat[]> {
    const client = this.requireReadyClient();
    if (!client.getChats) {
      throw new Error("WhatsApp chat discovery is unavailable");
    }
    this.increment("chatSearches");
    try {
      // The upstream getChats() expands every group's metadata. Some WhatsApp
      // Web revisions reject that expansion even though the session and event
      // stream are healthy. Lightweight discovery needs only cached metadata.
      const chats = client.pupPage
        ? await fetchLightweightChats(client)
        : await client.getChats();
      const text = query.text?.trim().toLocaleLowerCase() ?? "";
      const limit = Math.min(200, Math.max(1, query.limit ?? 50));
      return chats
        .map(normalizeChat)
        .filter((chat) => Boolean(chat.chatExternalId))
        .filter((chat) => query.includeGroups !== false || chat.kind !== "group")
        .filter((chat) => query.includeArchived === true || !chat.archived)
        .filter(
          (chat) =>
            !text ||
            chat.displayName.toLocaleLowerCase().includes(text) ||
            chat.chatExternalId.toLocaleLowerCase().includes(text),
        )
        .sort(compareChats)
        .slice(0, limit);
    } catch (cause) {
      this.recordError(cause);
      throw asError(cause);
    }
  }

  private rememberSend(key: string, result: SendResult): void {
    if (!this.sendsByKey.has(key)) this.sendKeyOrder.push(key);
    this.sendsByKey.set(key, result);
    while (this.sendKeyOrder.length > this.options.maxRememberedMessageIds) {
      const oldest = this.sendKeyOrder.shift();
      if (oldest) this.sendsByKey.delete(oldest);
    }
  }

  private async initialize(): Promise<void> {
    await this.setStatus("initializing");
    this.providerState = "INITIALIZING";
    try {
      const previousClient = this.client;
      this.client = undefined;
      if (previousClient) await previousClient.destroy();
      const client = await this.clientFactory(this.options);
      this.client = client;
      this.bindClientEvents(client);
      await client.initialize();
    } catch (cause) {
      const error = asError(cause);
      this.recordError(error);
      await this.setStatus("failed", error.message);
      await this.events.emit("error", {
        error,
        occurredAt: this.now().toISOString(),
      });
      throw error;
    }
  }

  private async destroy(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      try {
        await client.destroy();
      } catch (cause) {
        const error = asError(cause);
        this.recordError(error);
        await this.events.emit("error", {
          error,
          occurredAt: this.now().toISOString(),
        });
      }
    }
    this.connectPromise = undefined;
    this.providerState = "DISCONNECTED";
    await this.setStatus("disconnected", "requested");
  }

  private bindClientEvents(client: WhatsAppClientLike): void {
    client.on("qr", (qr: string) => {
      this.recordRawEvent("qr");
      void this.runEvent(async () => {
        await this.setStatus("awaiting_qr");
        await this.events.emit("qr", {
          value: qr,
          emittedAt: this.now().toISOString(),
        });
      });
    });
    client.on("authenticated", () => {
      this.recordRawEvent("authenticated");
      void this.runEvent(() => this.setStatus("authenticated"));
    });
    client.on("ready", () => {
      this.recordRawEvent("ready");
      void this.runEvent(async () => {
        await this.captureProviderMetadata(client);
        await this.setStatus("ready");
      });
    });
    client.on("auth_failure", (detail: string) => {
      this.recordRawEvent("auth_failure");
      this.recordError(detail);
      this.providerState = "AUTHENTICATION_FAILED";
      void this.runEvent(() => this.setStatus("authentication_failed", detail));
    });
    client.on("disconnected", (reason: unknown) => {
      this.recordRawEvent("disconnected");
      this.providerState = "DISCONNECTED";
      void this.runEvent(() =>
        this.setStatus("disconnected", String(reason ?? "unknown")),
      );
    });
    client.on("change_state", (state: unknown) => {
      this.recordRawEvent("change_state");
      this.providerState = String(state ?? "UNKNOWN");
    });
    client.on("message", (message: WhatsAppMessageLike) => {
      this.recordRawMessage("message", message);
      void this.runEvent(() => this.acceptMessage(message));
    });
    client.on("message_create", (message: WhatsAppMessageLike) => {
      this.recordRawMessage("message_create", message);
      void this.runEvent(() => this.acceptMessage(message));
    });
    client.on(
      "message_ack",
      (message: WhatsAppMessageLike, acknowledgement: number) => {
        this.recordRawEvent("message_ack");
        this.increment("acknowledgements");
        void this.runEvent(async () => {
          await this.events.emit("acknowledgement", {
            providerMessageId: message.id._serialized,
            chatExternalId: chatIdOf(message),
            state: deliveryStateOf(acknowledgement),
            acknowledgedAt: this.now().toISOString(),
            providerCode: acknowledgement,
          });
        });
      },
    );
  }

  private async acceptMessage(message: WhatsAppMessageLike): Promise<void> {
    const id = message.id._serialized;
    if (!id || this.seenMessageIds.has(id)) {
      if (id) this.increment("duplicateMessages");
      return;
    }
    this.rememberMessageId(id);
    const signature = sendSignature(chatIdOf(message), message.body ?? "");
    const isKnownAgentMessage = this.agentMessageIds.has(id);
    const normalized = await this.normalizeMessage(
      message,
      message.fromMe &&
        (isKnownAgentMessage || this.consumePending(signature)),
    );
    this.increment("emittedMessages");
    this.lastEmittedMessage = diagnosticMessage(normalized);
    await this.events.emit("message", normalized);
  }

  private async normalizeMessage(
    message: WhatsAppMessageLike,
    isAgentMessage = false,
  ): Promise<NormalizedMessage> {
    const chatExternalId = chatIdOf(message);
    let quotedProviderMessageId: string | undefined;
    if (message.hasQuotedMsg && message.getQuotedMessage) {
      try {
        quotedProviderMessageId = (await message.getQuotedMessage()).id._serialized;
      } catch {
        // Quoted metadata is useful but failure to retrieve it must not drop the
        // message event itself.
      }
    }

    const data = message._data;
    const timestamp=Number(message.timestamp);
    return {
      provider: "whatsapp-web",
      providerMessageId: message.id._serialized,
      chatExternalId,
      senderExternalId: message.fromMe
        ? message.from
        : (message.author ?? message.from),
      direction: message.fromMe ? "outbound" : "inbound",
      origin: message.fromMe ? (isAgentMessage ? "agent" : "owner") : "customer",
      kind: messageKindOf(message.type),
      text: message.body ?? "",
      occurredAt: Number.isFinite(timestamp)&&timestamp>0
        ? new Date(timestamp * 1_000).toISOString()
        : this.now().toISOString(),
      ...(quotedProviderMessageId ? { quotedProviderMessageId } : {}),
      ...(message.hasMedia
        ? {
            media: {
              hasMedia: true,
              ...(data?.mimetype ? { mimeType: data.mimetype } : {}),
              ...(data?.filename ? { filename: data.filename } : {}),
              ...(typeof data?.size === "number"
                ? { sizeBytes: data.size }
                : {}),
            },
          }
        : {}),
    };
  }

  private rememberMessageId(id: string): void {
    this.seenMessageIds.add(id);
    this.seenMessageOrder.push(id);
    while (
      this.seenMessageOrder.length > this.options.maxRememberedMessageIds
    ) {
      const oldest = this.seenMessageOrder.shift();
      if (oldest) this.seenMessageIds.delete(oldest);
    }
  }

  private rememberAgentMessageId(id: string): void {
    if (this.agentMessageIds.has(id)) return;
    this.agentMessageIds.add(id);
    this.agentMessageOrder.push(id);
    while (
      this.agentMessageOrder.length > this.options.maxRememberedMessageIds
    ) {
      const oldest = this.agentMessageOrder.shift();
      if (oldest) this.agentMessageIds.delete(oldest);
    }
  }

  private toSendResult(
    message: WhatsAppMessageLike,
    fallbackChatId: string,
  ): SendResult {
    return {
      providerMessageId: message.id._serialized,
      chatExternalId: chatIdOf(message) || fallbackChatId,
      acceptedAt: this.now().toISOString(),
    };
  }

  private requireReadyClient(): WhatsAppClientLike {
    if (!this.client || this.currentStatus.state !== "ready") {
      throw new Error("WhatsApp channel is not ready");
    }
    return this.client;
  }

  private async setStatus(
    state: ChannelStatus["state"],
    detail?: string,
  ): Promise<void> {
    this.currentStatus = {
      state,
      changedAt: this.now().toISOString(),
      ...(detail ? { detail } : {}),
    };
    await this.events.emit("status", this.currentStatus);
  }

  private async runEvent(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (cause) {
      this.recordError(cause);
      await this.events.emit("error", {
        error: asError(cause),
        occurredAt: this.now().toISOString(),
      });
    }
  }

  private async captureProviderMetadata(
    client: WhatsAppClientLike,
  ): Promise<void> {
    const info = client.info;
    if (info?.wid?._serialized) {
      this.linkedIdentity = {
        externalId: info.wid._serialized,
        ...(info.pushname ? { displayName: info.pushname } : {}),
        ...(info.platform ? { platform: info.platform } : {}),
      };
    }

    if (client.getState) {
      try {
        this.providerState = await client.getState();
      } catch (cause) {
        this.recordError(cause);
      }
    } else {
      this.providerState = "CONNECTED";
    }

    if (client.getWWebVersion) {
      try {
        this.webVersion = await client.getWWebVersion();
      } catch (cause) {
        this.recordError(cause);
      }
    }
  }

  private recordRawEvent(name: string): void {
    this.increment("rawEvents");
    this.lastRawEvent = { name, occurredAt: this.now().toISOString() };
  }

  private recordRawMessage(
    eventName: string,
    message: WhatsAppMessageLike,
  ): void {
    this.recordRawEvent(eventName);
    this.increment("rawMessages");
    this.lastRawMessage = {
      providerMessageId: message.id._serialized,
      chatExternalId: chatIdOf(message),
      occurredAt: this.now().toISOString(),
    };
  }

  private recordError(cause: unknown): void {
    const error = asError(cause);
    this.increment("errors");
    this.lastError = {
      message: error.message,
      occurredAt: this.now().toISOString(),
    };
  }

  private increment(key: keyof ChannelDiagnosticCounters): void {
    this.counters = { ...this.counters, [key]: this.counters[key] + 1 };
  }

  private reservePending(signature: string): { consumed: boolean } {
    const reservation = { consumed: false };
    const reservations = this.pendingAgentMessages.get(signature) ?? [];
    reservations.push(reservation);
    this.pendingAgentMessages.set(signature, reservations);
    return reservation;
  }

  private consumePending(signature: string): boolean {
    const reservations = this.pendingAgentMessages.get(signature);
    const reservation = reservations?.shift();
    if (!reservation) return false;
    reservation.consumed = true;
    if (!reservations || reservations.length === 0) {
      this.pendingAgentMessages.delete(signature);
    }
    return true;
  }

  private releasePending(
    signature: string,
    reservation: { consumed: boolean },
  ): void {
    if (reservation.consumed) return;
    const reservations = this.pendingAgentMessages.get(signature);
    if (!reservations) return;
    const index = reservations.indexOf(reservation);
    if (index >= 0) reservations.splice(index, 1);
    if (reservations.length === 0) this.pendingAgentMessages.delete(signature);
  }
}

function chatIdOf(message: WhatsAppMessageLike): string {
  return message.fromMe ? message.to : message.from;
}

function sendSignature(chatExternalId: string, text: string): string {
  return `${chatExternalId}\u0000${text}`;
}

function deliveryStateOf(code: number): DeliveryState {
  switch (code) {
    case -1:
      return "failed";
    case 0:
      return "pending";
    case 1:
      return "server";
    case 2:
      return "device";
    case 3:
      return "read";
    case 4:
      return "played";
    default:
      return "unknown";
  }
}

function messageKindOf(type: string): MessageKind {
  switch (type) {
    case "chat":
      return "text";
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
    case "ptt":
      return "audio";
    case "document":
      return "document";
    case "sticker":
      return "sticker";
    case "location":
      return "location";
    case "vcard":
    case "multi_vcard":
      return "contact";
    default:
      return "unknown";
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function normalizeChat(chat: WhatsAppChatSummaryLike): DiscoveredChat {
  const chatExternalId = chat.id?._serialized ?? "";
  const timestamp = chat.timestamp;
  const lastActivityAt =
    typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
      ? new Date(timestamp * 1_000).toISOString()
      : undefined;
  return {
    provider: "whatsapp-web",
    chatExternalId,
    displayName: chat.name?.trim() || chatExternalId,
    kind:
      typeof chat.isGroup === "boolean"
        ? chat.isGroup
          ? "group"
          : "direct"
        : "unknown",
    archived: chat.archived ?? false,
    unreadCount: Math.max(0, chat.unreadCount ?? 0),
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
}

function compareChats(left: DiscoveredChat, right: DiscoveredChat): number {
  const byActivity = (right.lastActivityAt ?? "").localeCompare(
    left.lastActivityAt ?? "",
  );
  return byActivity || left.displayName.localeCompare(right.displayName);
}

async function fetchLightweightChats(client: WhatsAppClientLike): Promise<WhatsAppChatSummaryLike[]> {
  if (!client.pupPage) throw new Error("WhatsApp lightweight chat discovery is unavailable");
  return client.pupPage.evaluate<WhatsAppChatSummaryLike[]>(() => {
    const runtime = window as unknown as {
      require(name:string): { Chat: { getModelsArray(): Array<Record<string,any>> } };
    };
    const chats=runtime.require('WAWebCollections').Chat.getModelsArray();
    return chats.map(chat=>{
      const serialized=typeof chat.serialize==='function'?chat.serialize():chat;
      const id=chat.id?._serialized??serialized.id?._serialized??'';
      return {
        id:{_serialized:id},
        name:chat.formattedTitle??serialized.formattedTitle??serialized.name??id,
        isGroup:Boolean(chat.groupMetadata)||id.endsWith('@g.us'),
        archived:Boolean(chat.archive??serialized.archive),
        unreadCount:Number(chat.unreadCount??serialized.unreadCount??0),
        timestamp:Number(chat.t??serialized.t??0),
      };
    });
  });
}

async function fetchLightweightMessages(client: WhatsAppClientLike, chatExternalId:string, limit:number):Promise<WhatsAppMessageLike[]> {
  if (!client.pupPage) throw new Error("WhatsApp lightweight history retrieval is unavailable");
  return client.pupPage.evaluate(async(chatId:string,requestedLimit:number)=>{
    const runtime=window as unknown as {
      WWebJS:{getChat(chatId:string,options:{getAsModel:boolean}):Promise<Record<string,any>>;getMessageModel(message:Record<string,any>):Record<string,any>};
      require(name:string):{loadEarlierMsgs?(input:{chat:Record<string,any>}):Promise<Array<Record<string,any>>>};
    };
    const chat=await runtime.WWebJS.getChat(chatId,{getAsModel:false});
    if(!chat)throw new Error('WhatsApp conversation was not found.');
    const include=(message:Record<string,any>)=>!message.isNotification;
    let messages=(chat.msgs?.getModelsArray?.()??[]).filter(include);
    const loader=runtime.require('WAWebChatLoadMessages').loadEarlierMsgs;
    while(messages.length<requestedLimit&&loader){
      const earlier=await loader({chat});
      if(!earlier?.length)break;
      messages=[...earlier.filter(include),...messages];
    }
    messages.sort((left:Record<string,any>,right:Record<string,any>)=>Number(left.t??0)-Number(right.t??0));
    return messages.slice(-requestedLimit).map((message:Record<string,any>)=>{
      const model=runtime.WWebJS.getMessageModel(message);
      const id=model.id??{};
      const remote=typeof id.remote==='object'&&id.remote!==null?id.remote._serialized:id.remote;
      const serializedId=id._serialized??`${id.fromMe?'true':'false'}_${remote??''}_${id.id??''}`;
      const asId=(value:unknown)=>typeof value==='object'&&value!==null&&'_serialized' in value
        ? String((value as {_serialized:unknown})._serialized)
        : String(value??'');
      return {
        id:{_serialized:String(serializedId)},
        from:asId(model.from),to:asId(model.to),author:model.author?asId(model.author):undefined,
        fromMe:Boolean(id.fromMe),body:String(model.directPath?model.caption??'':model.body??model.pollName??model.eventName??''),
        type:String(model.type??'unknown'),timestamp:Number(model.t??0),hasMedia:Boolean(model.directPath),hasQuotedMsg:Boolean(model.quotedMsg),
        _data:{mimetype:model.mimetype,filename:model.filename,size:model.size},
      } as WhatsAppMessageLike;
    }).filter((message:WhatsAppMessageLike)=>Boolean(message.id._serialized));
  },chatExternalId,limit);
}

async function matchingOutboundIds(
  client: WhatsAppClientLike,
  chatExternalId: string,
  text: string,
): Promise<Set<string>> {
  if (!client.pupPage) return new Set();
  try {
    const messages = await fetchLightweightMessages(client, chatExternalId, 25);
    return new Set(
      messages
        .filter((message) => message.fromMe && message.body === text)
        .map((message) => message.id._serialized),
    );
  } catch {
    // Receipt recovery is best-effort and must not prevent the actual send.
    return new Set();
  }
}

async function findNewOutboundMessage(
  client: WhatsAppClientLike,
  chatExternalId: string,
  text: string,
  existingIds: ReadonlySet<string>,
): Promise<WhatsAppMessageLike | undefined> {
  if (!client.pupPage) return undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const messages = await fetchLightweightMessages(client, chatExternalId, 25);
      const match = messages
        .slice()
        .reverse()
        .find(
          (message) =>
            message.fromMe &&
            message.body === text &&
            !existingIds.has(message.id._serialized),
        );
      if (match) return match;
    } catch {
      // Preserve the provider's original send error when recovery also fails.
    }
    if (attempt < 2) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  return undefined;
}

function diagnosticMessage(message: NormalizedMessage) {
  return {
    providerMessageId: message.providerMessageId,
    chatExternalId: message.chatExternalId,
    occurredAt: message.occurredAt,
  };
}

function emptyCounters(): ChannelDiagnosticCounters {
  return {
    rawEvents: 0,
    rawMessages: 0,
    emittedMessages: 0,
    duplicateMessages: 0,
    acknowledgements: 0,
    errors: 0,
    chatSearches: 0,
    historyFetches: 0,
  };
}
