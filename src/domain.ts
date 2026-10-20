export type MessageDirection = "inbound" | "outbound";

export type MessagingProvider = "whatsapp-web" | "fake";

export type MessageOrigin = "customer" | "owner" | "agent";

export type MessageKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "unknown";

export type DeliveryState =
  | "pending"
  | "server"
  | "device"
  | "read"
  | "played"
  | "failed"
  | "unknown";

export interface MediaDescriptor {
  readonly mimeType?: string;
  readonly filename?: string;
  readonly sizeBytes?: number;
  readonly hasMedia: boolean;
}

/**
 * Provider-neutral representation of a message. Provider timestamps are
 * converted to ISO-8601 at the adapter boundary so this value can be logged,
 * persisted, and replayed without custom serialization.
 */
export interface NormalizedMessage {
  readonly provider: MessagingProvider;
  readonly providerMessageId: string;
  readonly chatExternalId: string;
  readonly senderExternalId: string;
  readonly direction: MessageDirection;
  readonly origin: MessageOrigin;
  readonly kind: MessageKind;
  readonly text: string;
  readonly quotedProviderMessageId?: string;
  readonly occurredAt: string;
  readonly media?: MediaDescriptor;
}

export type ChannelLifecycleState =
  | "idle"
  | "initializing"
  | "awaiting_qr"
  | "authenticated"
  | "ready"
  | "disconnected"
  | "authentication_failed"
  | "failed";

export interface ChannelStatus {
  readonly state: ChannelLifecycleState;
  readonly changedAt: string;
  readonly detail?: string;
}

export interface MessageAcknowledgement {
  readonly providerMessageId: string;
  readonly chatExternalId?: string;
  readonly state: DeliveryState;
  readonly acknowledgedAt: string;
  readonly providerCode?: number;
}

export interface SendTextCommand {
  readonly chatExternalId: string;
  readonly text: string;
  /** A caller-owned key used by the durable outbox. */
  readonly idempotencyKey: string;
}

export interface SendMediaCommand {
  readonly chatExternalId: string;
  readonly mimeType: string;
  readonly base64: string;
  readonly filename?: string;
  readonly caption?: string;
  /** A caller-owned key used by the durable delivery record. */
  readonly idempotencyKey: string;
}

export interface ReplyCommand extends SendTextCommand {
  readonly replyToProviderMessageId: string;
}

export interface SendResult {
  readonly providerMessageId: string;
  readonly chatExternalId: string;
  readonly acceptedAt: string;
}

export interface DownloadedMedia {
  readonly mimeType: string;
  readonly base64: string;
  readonly filename?: string;
}

export interface RecentMessagesQuery {
  readonly chatExternalId: string;
  readonly limit?: number;
}

export type ChatKind = "direct" | "group" | "unknown";

/** Provider-neutral metadata used to discover an existing conversation. */
export interface DiscoveredChat {
  readonly provider: MessagingProvider;
  readonly chatExternalId: string;
  readonly displayName: string;
  readonly kind: ChatKind;
  readonly archived: boolean;
  readonly unreadCount: number;
  readonly lastActivityAt?: string;
}

export interface SearchChatsQuery {
  /** Case-insensitive text matched against the display name and external ID. */
  readonly text?: string;
  readonly limit?: number;
  readonly includeGroups?: boolean;
  readonly includeArchived?: boolean;
}

export interface LinkedMessagingIdentity {
  readonly externalId: string;
  readonly displayName?: string;
  readonly platform?: string;
}

export interface ChannelDiagnosticEvent {
  readonly name: string;
  readonly occurredAt: string;
}

export interface ChannelDiagnosticMessage {
  readonly providerMessageId: string;
  readonly chatExternalId: string;
  readonly occurredAt: string;
}

export interface ChannelDiagnosticError {
  readonly message: string;
  readonly occurredAt: string;
}

export interface ChannelDiagnosticCounters {
  readonly rawEvents: number;
  readonly rawMessages: number;
  readonly emittedMessages: number;
  readonly duplicateMessages: number;
  readonly acknowledgements: number;
  readonly errors: number;
  readonly chatSearches: number;
  readonly historyFetches: number;
}

/**
 * A synchronous snapshot of transport health. Provider lookups are captured
 * when the connection becomes ready, keeping status pages free of network I/O.
 */
export interface ChannelDiagnostics {
  readonly status: ChannelStatus;
  readonly linkedIdentity?: LinkedMessagingIdentity;
  readonly providerState?: string;
  readonly webVersion?: string;
  readonly lastRawEvent?: ChannelDiagnosticEvent;
  readonly lastRawMessage?: ChannelDiagnosticMessage;
  readonly lastEmittedMessage?: ChannelDiagnosticMessage;
  readonly lastError?: ChannelDiagnosticError;
  readonly counters: ChannelDiagnosticCounters;
}

export interface ChannelEventMap {
  message: NormalizedMessage;
  acknowledgement: MessageAcknowledgement;
  status: ChannelStatus;
  qr: { readonly value: string; readonly emittedAt: string };
  error: { readonly error: Error; readonly occurredAt: string };
}

export type ChannelEventName = keyof ChannelEventMap;
export type ChannelEventHandler<K extends ChannelEventName> = (
  event: ChannelEventMap[K],
) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface MessagingChannel {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): ChannelStatus;
  diagnostics(): ChannelDiagnostics;
  on<K extends ChannelEventName>(
    event: K,
    handler: ChannelEventHandler<K>,
  ): Unsubscribe;
  sendText(command: SendTextCommand): Promise<SendResult>;
  sendMedia(command: SendMediaCommand): Promise<SendResult>;
  reply(command: ReplyCommand): Promise<SendResult>;
  searchChats(query?: SearchChatsQuery): Promise<DiscoveredChat[]>;
  getRecentMessages(query: RecentMessagesQuery): Promise<NormalizedMessage[]>;
  downloadMedia(providerMessageId: string): Promise<DownloadedMedia>;
  /** Resolves a phone number (digits only) to its chat ID, or undefined when it is not on WhatsApp. */
  resolvePhoneNumber(digits: string): Promise<string | undefined>;
  /**
   * WhatsApp now addresses some contacts by a private "@lid" ID instead of
   * their phone number. Returns the phone-number chat ID for such an ID.
   */
  phoneIdFor(lid: string): Promise<string | undefined>;
}

export function isValidIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export function assertSendCommand(command: SendTextCommand): void {
  if (!command.chatExternalId.trim()) {
    throw new Error("chatExternalId is required");
  }
  if (!command.text.trim()) {
    throw new Error("message text is required");
  }
  if (!command.idempotencyKey.trim()) {
    throw new Error("idempotencyKey is required");
  }
}

export function assertSendMediaCommand(command: SendMediaCommand): void {
  if (!command.chatExternalId.trim()) throw new Error('chatExternalId is required');
  if (!command.idempotencyKey.trim()) throw new Error('idempotencyKey is required');
  if (!command.mimeType.trim()) throw new Error('mimeType is required');
  if (!command.base64.trim()) throw new Error('media content is required');
}
