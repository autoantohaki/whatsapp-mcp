import type { MessagingChannel, NormalizedMessage } from "./domain.ts";
import type { AutopilotMode, AutopilotSetting, Draft, MessageStore, StoredMessage } from "./store.ts";

/**
 * What a background Claude run can do for one client. Implemented here so the
 * autopilot, not the model, decides what actually reaches the client.
 */
export interface AutopilotTools {
  readChat(limit?: number, before?: string): Promise<string>;
  search(query: string): Promise<string>;
  proposeReply(text: string): Promise<string>;
  noReplyNeeded(reason: string): Promise<string>;
}

export interface AgentRun {
  readonly prompt: string;
  readonly chatId: string;
  readonly clientName: string;
  /** Claude conversation to continue; undefined starts a new one. */
  readonly sessionId?: string;
  /** Continue a copy of the conversation (used when the lawyer has it open right now). */
  readonly fork: boolean;
  readonly tools: AutopilotTools;
}

export type AgentRunner = (run: AgentRun) => Promise<{ sessionId?: string }>;

export interface AutopilotOptions {
  readonly channel: MessagingChannel;
  readonly store: MessageStore;
  readonly runAgent: AgentRunner;
  /** Reads a chat the same way the MCP tool does (also fills gaps from the phone). */
  readonly readChat: (chatId: string, limit?: number, before?: string) => Promise<StoredMessage[]>;
  /** Resolves "@lid" IDs etc. so the lawyer's own chat is recognized. */
  readonly canonicalId: (id: string) => Promise<string>;
  /** Whether a Claude conversation was used in the last few minutes (the lawyer is in it). */
  readonly sessionInUse: (sessionId: string) => boolean;
  /** True when an open Claude session already receives this chat's messages live. */
  readonly handledLive?: (chatId: string, mode: AutopilotMode) => boolean;
  readonly debounceMs?: number;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

const APPROVE = /^(ok|okay|sim|s|yes|y|pode|pode mandar|manda|envia|enviar|send|👍|✅)[.!\s]*$/iu;
const DISCARD = /^(n[aã]o|no|n|descarta|descartar|cancela|cancelar|discard|❌)[.!\s]*$/iu;
const SEND_OWN = /^(?:enviar|envia|send)\s*:\s*([\s\S]+)$/iu;
const DRAFT_NUMBER = /#(\d+)/;

const RULES = `You are answering on behalf of a lawyer, in the background, while he is away from the computer.
- Read the client's file first if it exists (clients/<Client Name>/notes.md, see CLAUDE.md), and the recent chat with read_chat.
- Reply in the client's language, short, professional and warm, as the lawyer's office would on WhatsApp.
- Never give a legal conclusion, deadline, fee or promise that is not already in the notes or the chat. When unsure, acknowledge the message and say the lawyer will get back to them.
- If no reply is needed (a "thanks", a sticker, an "ok"), call no_reply_needed instead.
- If the client shared important new facts, update their notes.md.
- Only touch files inside clients/. Do not use any other WhatsApp tool to send messages.`;

/**
 * Optional per-client automation. For each client the lawyer chooses:
 *   off    nothing happens (default)
 *   notify he gets a WhatsApp note in his own chat ("Message yourself") when the client writes
 *   draft  Claude prepares a reply in the background and he approves it from his phone
 * Nothing is ever sent to a client without his explicit approval.
 */
export class Autopilot {
  private readonly options: AutopilotOptions;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, StoredLike[]>();
  private readonly running = new Set<string>();

  constructor(options: AutopilotOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  ownerChatId(): string | undefined {
    return this.options.channel.diagnostics().linkedIdentity?.externalId;
  }

  configure(input: { chatId: string; mode: AutopilotMode; sessionId?: string; instructions?: string }): AutopilotSetting {
    const current = this.options.store.getAutopilot(input.chatId);
    const setting: AutopilotSetting = {
      chatId: input.chatId,
      mode: input.mode,
      ...((input.sessionId ?? current?.sessionId) ? { sessionId: input.sessionId ?? current?.sessionId } : {}),
      ...((input.instructions ?? current?.instructions) ? { instructions: input.instructions ?? current?.instructions } : {}),
    };
    this.options.store.setAutopilot(setting, this.now().toISOString());
    return setting;
  }

  list(): AutopilotSetting[] {
    return this.options.store.listAutopilot();
  }

  pendingDrafts(): Draft[] {
    return this.options.store.pendingDrafts();
  }

  /** Called for every new message seen live (not for imported history). */
  async onLiveMessage(message: NormalizedMessage): Promise<void> {
    const owner = this.ownerChatId();
    if (owner && (await this.isOwnerChat(message.chatExternalId, owner))) {
      if (message.origin === "owner") await this.onOwnerMessage(message);
      return;
    }
    if (message.direction !== "inbound" || message.chatExternalId.endsWith("@g.us")) return;
    const ageMs = this.now().getTime() - Date.parse(message.occurredAt);
    if (ageMs > 10 * 60 * 1000) return;
    const setting = this.options.store.getAutopilot(message.chatExternalId);
    if (!setting || setting.mode === "off") return;

    // Clients often send several messages in a row; wait for them to finish.
    const queue = this.pending.get(message.chatExternalId) ?? [];
    queue.push(message);
    this.pending.set(message.chatExternalId, queue);
    clearTimeout(this.timers.get(message.chatExternalId));
    const timer = setTimeout(() => void this.flush(message.chatExternalId), this.options.debounceMs ?? 45_000);
    timer.unref?.();
    this.timers.set(message.chatExternalId, timer);
  }

  private async isOwnerChat(chatId: string, owner: string): Promise<boolean> {
    if (chatId === owner) return true;
    if (!chatId.endsWith("@lid")) return false;
    return (await this.options.canonicalId(chatId)) === owner;
  }

  private async flush(chatId: string): Promise<void> {
    this.timers.delete(chatId);
    if (this.running.has(chatId)) {
      // A run is in progress; it picks these up when it finishes.
      return;
    }
    const messages = this.pending.get(chatId) ?? [];
    this.pending.delete(chatId);
    if (!messages.length) return;
    const setting = this.options.store.getAutopilot(chatId);
    if (!setting || setting.mode === "off") return;
    const name = this.options.store.getChat(chatId)?.name ?? chatId;

    if (setting.mode === "notify") {
      await this.tellOwner(`📩 *${name}* escreveu:\n${messages.map(describe).join("\n")}`);
      return;
    }

    // An open Claude session following this client reacts there instead.
    if (this.options.handledLive?.(chatId, setting.mode)) return;

    this.running.add(chatId);
    try {
      await this.runAgent(setting, name, this.newMessagesPrompt(name, chatId, messages, setting));
    } finally {
      this.running.delete(chatId);
      if (this.pending.get(chatId)?.length) void this.flush(chatId);
    }
  }

  private newMessagesPrompt(name: string, chatId: string, messages: StoredLike[], setting: AutopilotSetting): string {
    const action =
      "Prepare the reply you recommend and call propose_reply; the lawyer approves it from his phone. Do not send anything yourself.";
    return [
      `[WhatsApp autopilot] New WhatsApp message(s) from client "${name}" (chat id ${chatId}):`,
      ...messages.map((message) => `- ${describe(message)}`),
      "",
      action,
      setting.instructions ? `The lawyer's standing instructions for this client: ${setting.instructions}` : "",
      "",
      RULES,
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  private async runAgent(setting: AutopilotSetting, name: string, prompt: string): Promise<void> {
    const chatId = setting.chatId;
    let outcome = "";
    const tools: AutopilotTools = {
      readChat: async (limit, before) =>
        (await this.options.readChat(chatId, limit, before)).map(describe).join("\n") || "No messages.",
      search: async (query) =>
        this.options.store.search(query, { chatId, limit: 20 }).map(describe).join("\n") || "Nothing found.",
      proposeReply: async (text) => {
        if (setting.mode !== "draft") return "Not allowed.";
        const draft = this.options.store.createDraft(chatId, text, this.now().toISOString());
        const notice = await this.tellOwner(
          `✍️ *Resposta sugerida para ${name}* (#${draft.id})\n\n${text}\n\n` +
            "Responda *ok* para enviar, *não* para descartar, ou diga o que mudar. " +
            "Para mandar outro texto: *enviar: seu texto*.",
        );
        if (notice) this.options.store.updateDraft(draft.id, { noticeMessageId: notice });
        outcome = "proposed";
        return `Draft #${draft.id} sent to the lawyer for approval. Stop here.`;
      },
      noReplyNeeded: async (reason) => {
        outcome = "none";
        if (setting.mode === "draft") await this.tellOwner(`ℹ️ *${name}* escreveu, mas não precisa de resposta: ${reason}`);
        return "Noted.";
      },
    };

    const sessionId = setting.sessionId;
    const fork = Boolean(sessionId && this.options.sessionInUse(sessionId));
    try {
      const result = await this.options.runAgent({
        prompt,
        chatId,
        clientName: name,
        ...(sessionId ? { sessionId } : {}),
        fork,
        tools,
      });
      // Keep using the same conversation next time (unless it was a temporary copy).
      if (result.sessionId && !fork && result.sessionId !== sessionId) {
        this.configure({ chatId, mode: setting.mode, sessionId: result.sessionId });
      }
      if (!outcome) await this.tellOwner(`⚠️ *${name}* escreveu, mas não consegui preparar uma resposta. Abra a conversa do cliente no Claude.`);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.log(`Autopilot run for ${chatId} failed: ${reason}`);
      await this.tellOwner(`⚠️ *${name}* escreveu, mas o piloto automático falhou (${reason.slice(0, 200)}). Abra a conversa do cliente no Claude.`);
    }
  }

  private async onOwnerMessage(message: NormalizedMessage): Promise<void> {
    const text = message.text.trim();
    if (!text) return;
    const store = this.options.store;
    const numbered = DRAFT_NUMBER.exec(text);
    const draft =
      (message.quotedProviderMessageId && store.draftByNotice(message.quotedProviderMessageId)) ||
      (numbered ? store.getDraft(Number(numbered[1])) : undefined) ||
      store.latestPendingDraft();
    if (!draft || draft.status !== "pending") return; // just a note to himself
    const name = store.getChat(draft.chatId)?.name ?? draft.chatId;
    const command = text.replace(DRAFT_NUMBER, "").trim();

    if (APPROVE.test(command)) {
      if (await this.sendToClient(draft.chatId, draft.text, name)) {
        store.updateDraft(draft.id, { status: "sent" });
        await this.tellOwner(`✅ Enviado para *${name}*.`);
      }
      return;
    }
    if (DISCARD.test(command)) {
      store.updateDraft(draft.id, { status: "discarded" });
      await this.tellOwner(`🗑️ Resposta para *${name}* descartada.`);
      return;
    }
    const own = SEND_OWN.exec(command);
    if (own) {
      if (await this.sendToClient(draft.chatId, own[1]!.trim(), name)) {
        store.updateDraft(draft.id, { status: "sent" });
        await this.tellOwner(`✅ Seu texto foi enviado para *${name}*.`);
      }
      return;
    }

    // Anything else is feedback: ask Claude for a new version.
    const setting = store.getAutopilot(draft.chatId) ?? { chatId: draft.chatId, mode: "draft" as const };
    store.updateDraft(draft.id, { status: "superseded" });
    if (this.running.has(draft.chatId)) return;
    this.running.add(draft.chatId);
    try {
      await this.runAgent(
        { ...setting, mode: "draft" },
        name,
        [
          `[WhatsApp autopilot] The lawyer reviewed your draft #${draft.id} for "${name}":`,
          `"""${draft.text}"""`,
          `His feedback: "${text}"`,
          "Write a new version that follows his feedback and call propose_reply. Do not send anything yourself.",
          "",
          RULES,
        ].join("\n"),
      );
    } finally {
      this.running.delete(draft.chatId);
    }
  }

  private async sendToClient(chatId: string, text: string, name: string): Promise<boolean> {
    try {
      await this.options.channel.sendText({
        chatExternalId: chatId,
        text,
        idempotencyKey: `autopilot:${chatId}:${this.now().getTime()}:${text.length}`,
      });
      return true;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.log(`Autopilot could not send to ${chatId}: ${reason}`);
      await this.tellOwner(`❌ Não consegui enviar para *${name}* (${reason.slice(0, 150)}). Tente de novo com *ok*.`);
      return false;
    }
  }

  /** Writes to the lawyer's own WhatsApp chat ("Message yourself"). Returns the message id. */
  private async tellOwner(text: string): Promise<string | undefined> {
    const owner = this.ownerChatId();
    if (!owner) return undefined;
    try {
      const result = await this.options.channel.sendText({
        chatExternalId: owner,
        text,
        idempotencyKey: `owner:${this.now().getTime()}:${text.length}:${Math.random()}`,
      });
      return result.providerMessageId;
    } catch (cause) {
      this.log(`Could not notify the owner: ${cause instanceof Error ? cause.message : String(cause)}`);
      return undefined;
    }
  }
}

const localTime = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

type StoredLike = Pick<StoredMessage, "kind" | "text" | "occurredAt"> & Partial<Pick<StoredMessage, "direction" | "mediaFilename">>;

function describe(message: StoredLike | NormalizedMessage): string {
  const filename = "mediaFilename" in message ? message.mediaFilename : "media" in message ? message.media?.filename : undefined;
  const who = "direction" in message && message.direction === "outbound" ? "Lawyer's office: " : "";
  const attachment = message.kind !== "text" ? `[${message.kind}${filename ? `: ${filename}` : ""}] ` : "";
  const time = localTime.format(new Date(message.occurredAt));
  return `(${time}) ${who}${attachment}${message.text}`.trim();
}
