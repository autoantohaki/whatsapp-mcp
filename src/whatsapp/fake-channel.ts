import type {
  ChannelDiagnosticCounters,
  ChannelDiagnostics,
  ChannelEventHandler,
  ChannelEventMap,
  ChannelEventName,
  ChannelStatus,
  DiscoveredChat,
  DownloadedMedia,
  MessagingChannel,
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

export interface FakeMessagingChannelOptions {
  readonly now?: () => Date;
  readonly chats?: readonly DiscoveredChat[];
}

/** Deterministic, network-free channel used by integration and CI tests. */
export class FakeMessagingChannel implements MessagingChannel {
  private readonly events = new ChannelEventBus();
  private readonly messages: NormalizedMessage[] = [];
  private readonly sendsByKey = new Map<string, SendResult>();
  private readonly chats = new Map<string, DiscoveredChat>();
  private readonly media = new Map<string, DownloadedMedia>();
  private readonly lids = new Map<string, string>();
  private sequence = 0;
  private currentStatus: ChannelStatus;
  private readonly now: () => Date;
  private counters: ChannelDiagnosticCounters = emptyCounters();
  private lastRawEvent?: ChannelDiagnostics["lastRawEvent"];
  private lastRawMessage?: ChannelDiagnostics["lastRawMessage"];
  private lastEmittedMessage?: ChannelDiagnostics["lastEmittedMessage"];
  private lastError?: ChannelDiagnostics["lastError"];

  constructor(options: FakeMessagingChannelOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.currentStatus = {
      state: "idle",
      changedAt: this.now().toISOString(),
    };
    for (const chat of options.chats ?? []) this.chats.set(chat.chatExternalId, chat);
  }

  status(): ChannelStatus {
    return this.currentStatus;
  }

  diagnostics(): ChannelDiagnostics {
    return {
      status: this.currentStatus,
      linkedIdentity: {
        externalId: "fake-owner",
        displayName: "Fake owner",
        platform: "fake",
      },
      providerState: this.currentStatus.state,
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

  async connect(): Promise<void> {
    if (this.currentStatus.state === "ready") return;
    await this.setStatus("initializing");
    await this.setStatus("ready");
  }

  async disconnect(): Promise<void> {
    if (this.currentStatus.state === "disconnected") return;
    await this.setStatus("disconnected", "requested");
  }

  async injectMessage(message: NormalizedMessage): Promise<void> {
    this.recordRawMessage(message);
    if (
      this.messages.some(
        (existing) =>
          existing.providerMessageId === message.providerMessageId,
      )
    ) {
      this.increment("duplicateMessages");
      return;
    }
    this.messages.push(message);
    this.upsertChatFromMessage(message);
    this.recordEmittedMessage(message);
    await this.events.emit("message", message);
  }

  /**
   * Adds provider history without emitting a live event. This models the exact
   * failure the reconciliation loop exists to recover in deterministic tests.
   */
  seedHistory(messages: readonly NormalizedMessage[]): void {
    for (const message of messages) {
      if (this.messages.some(existing => existing.providerMessageId === message.providerMessageId)) continue;
      this.messages.push(message);
      this.upsertChatFromMessage(message);
    }
  }

  async emit<K extends ChannelEventName>(
    event: K,
    payload: ChannelEventMap[K],
  ): Promise<void> {
    this.recordRawEvent(event);
    if (event === "error") {
      const error = payload as ChannelEventMap["error"];
      this.lastError = {
        message: error.error.message,
        occurredAt: error.occurredAt,
      };
      this.increment("errors");
    }
    if (event === "acknowledgement") this.increment("acknowledgements");
    await this.events.emit(event, payload);
  }

  async sendText(command: SendTextCommand): Promise<SendResult> {
    assertSendCommand(command);
    this.assertReady();
    const existing = this.sendsByKey.get(command.idempotencyKey);
    if (existing) return existing;

    const acceptedAt = this.now().toISOString();
    const result: SendResult = {
      providerMessageId: `fake-${++this.sequence}`,
      chatExternalId: command.chatExternalId,
      acceptedAt,
    };
    this.sendsByKey.set(command.idempotencyKey, result);
    const message: NormalizedMessage = {
      provider: "fake",
      providerMessageId: result.providerMessageId,
      chatExternalId: command.chatExternalId,
      senderExternalId: "fake-owner",
      direction: "outbound",
      origin: "agent",
      kind: "text",
      text: command.text,
      occurredAt: acceptedAt,
    };
    this.messages.push(message);
    this.upsertChatFromMessage(message);
    this.recordRawMessage(message);
    this.recordEmittedMessage(message);
    await this.events.emit("message", message);
    return result;
  }

  async sendMedia(command: SendMediaCommand): Promise<SendResult> {
    assertSendMediaCommand(command);
    this.assertReady();
    const existing=this.sendsByKey.get(command.idempotencyKey);if(existing)return existing;
    const acceptedAt=this.now().toISOString();const result:SendResult={providerMessageId:`fake-${++this.sequence}`,chatExternalId:command.chatExternalId,acceptedAt};
    this.sendsByKey.set(command.idempotencyKey,result);
    const kind=command.mimeType.startsWith('image/')?'image':command.mimeType.startsWith('audio/')?'audio':command.mimeType.startsWith('video/')?'video':'document';
    const message:NormalizedMessage={provider:'fake',providerMessageId:result.providerMessageId,chatExternalId:command.chatExternalId,senderExternalId:'fake-owner',direction:'outbound',origin:'agent',kind,text:command.caption??'',occurredAt:acceptedAt,media:{mimeType:command.mimeType,filename:command.filename,hasMedia:true}};
    this.messages.push(message);this.upsertChatFromMessage(message);this.recordRawMessage(message);this.recordEmittedMessage(message);await this.events.emit('message',message);return result;
  }

  /** Registers the bytes returned by downloadMedia for an injected message. */
  seedMedia(providerMessageId: string, media: DownloadedMedia): void {
    this.media.set(providerMessageId, media);
  }

  async downloadMedia(providerMessageId: string): Promise<DownloadedMedia> {
    this.assertReady();
    const media = this.media.get(providerMessageId);
    if (!media) throw new Error(`WhatsApp message ${providerMessageId} has no attachment`);
    return media;
  }

  /** Declares that a test "@lid" ID belongs to a phone-number chat ID. */
  seedLid(lid: string, phoneId: string): void {
    this.lids.set(lid, phoneId);
  }

  async phoneIdFor(lid: string): Promise<string | undefined> {
    this.assertReady();
    return this.lids.get(lid);
  }

  async resolvePhoneNumber(digits: string): Promise<string | undefined> {
    this.assertReady();
    return `${digits}@c.us`;
  }

  async reply(command: ReplyCommand): Promise<SendResult> {
    this.assertReady();
    if (!command.replyToProviderMessageId.trim()) {
      throw new Error("replyToProviderMessageId is required");
    }
    return this.sendText(command);
  }

  async getRecentMessages(
    query: RecentMessagesQuery,
  ): Promise<NormalizedMessage[]> {
    this.assertReady();
    this.increment("historyFetches");
    const limit = Math.min(500, Math.max(1, query.limit ?? 50));
    return this.messages
      .filter((message) => message.chatExternalId === query.chatExternalId)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
      .slice(-limit);
  }

  async searchChats(query: SearchChatsQuery = {}): Promise<DiscoveredChat[]> {
    this.assertReady();
    this.increment("chatSearches");
    const text = query.text?.trim().toLocaleLowerCase() ?? "";
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    return [...this.chats.values()]
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

  private assertReady(): void {
    if (this.currentStatus.state !== "ready") {
      throw new Error("Fake messaging channel is not ready");
    }
  }

  private recordRawEvent(name: string): void {
    this.increment("rawEvents");
    this.lastRawEvent = { name, occurredAt: this.now().toISOString() };
  }

  private recordRawMessage(message: NormalizedMessage): void {
    this.recordRawEvent("message");
    this.increment("rawMessages");
    this.lastRawMessage = diagnosticMessage(message);
  }

  private recordEmittedMessage(message: NormalizedMessage): void {
    this.increment("emittedMessages");
    this.lastEmittedMessage = diagnosticMessage(message);
  }

  private increment(key: keyof ChannelDiagnosticCounters): void {
    this.counters = { ...this.counters, [key]: this.counters[key] + 1 };
  }

  private upsertChatFromMessage(message: NormalizedMessage): void {
    const previous = this.chats.get(message.chatExternalId);
    this.chats.set(message.chatExternalId, {
      provider: "fake",
      chatExternalId: message.chatExternalId,
      displayName: previous?.displayName ?? message.chatExternalId,
      kind: previous?.kind ?? (message.chatExternalId.endsWith("@g.us") ? "group" : "direct"),
      archived: previous?.archived ?? false,
      unreadCount:
        (previous?.unreadCount ?? 0) + (message.direction === "inbound" ? 1 : 0),
      lastActivityAt: message.occurredAt,
    });
  }
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

function diagnosticMessage(message: NormalizedMessage) {
  return {
    providerMessageId: message.providerMessageId,
    chatExternalId: message.chatExternalId,
    occurredAt: message.occurredAt,
  };
}

function compareChats(left: DiscoveredChat, right: DiscoveredChat): number {
  const byActivity = (right.lastActivityAt ?? "").localeCompare(
    left.lastActivityAt ?? "",
  );
  return byActivity || left.displayName.localeCompare(right.displayName);
}
