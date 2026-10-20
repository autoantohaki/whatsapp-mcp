import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  WhatsAppWebChannel,
  type WhatsAppChatLike,
  type WhatsAppClientLike,
  type WhatsAppMessageLike,
} from "../src/whatsapp/web-channel.ts";

function createMessage(
  overrides: Partial<WhatsAppMessageLike> & { id: { _serialized: string } },
): WhatsAppMessageLike {
  return {
    from: "551100000001@c.us",
    to: "owner@c.us",
    fromMe: false,
    body: "Hello",
    type: "chat",
    timestamp: 1_789_211_600,
    reply: async () =>
      createMessage({ id: { _serialized: "reply-1" }, fromMe: true }),
    ...overrides,
  };
}

class StubClient extends EventEmitter implements WhatsAppClientLike {
  pupPage?: NonNullable<WhatsAppClientLike['pupPage']>;
  info = {
    wid: { _serialized: "owner@c.us" },
    pushname: "Mauricio",
    platform: "android",
  };
  initialize = vi.fn(async () => {
    this.emit("ready");
  });
  destroy = vi.fn(async () => undefined);
  sent: WhatsAppMessageLike[] = [];
  messages = new Map<string, WhatsAppMessageLike>();
  recent: WhatsAppMessageLike[] = [];
  chats: WhatsAppChatLike[] = [];
  fetchLimit = 0;

  sendMessage = vi.fn(async (chatId: string, body: string) => {
    const message = createMessage({
      id: { _serialized: `sent-${this.sent.length + 1}` },
      from: "owner@c.us",
      to: chatId,
      fromMe: true,
      body,
    });
    this.sent.push(message);
    this.emit("message_create", message);
    return message;
  });

  getMessageById = vi.fn(async (id: string) => this.messages.get(id));
  getChatById = vi.fn(async (): Promise<WhatsAppChatLike> => ({
    fetchMessages: async ({ limit }) => {
      this.fetchLimit = limit;
      return this.recent.slice(-limit);
    },
  }));
  getChats = vi.fn(async () => this.chats);
  getState = vi.fn(async () => "CONNECTED");
  getWWebVersion = vi.fn(async () => "2.3000.1");
}

async function settleEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("WhatsAppWebChannel", () => {
  it("reports QR and ready lifecycle without opening a real browser", async () => {
    const client = new StubClient();
    client.initialize = vi.fn(async () => {
      client.emit("qr", "qr-value");
      client.emit("authenticated");
      client.emit("ready");
    });
    const channel = new WhatsAppWebChannel({
      clientFactory: async () => client,
    });
    const states: string[] = [];
    const qrValues: string[] = [];
    channel.on("status", ({ state }) => {
      states.push(state);
    });
    channel.on("qr", ({ value }) => {
      qrValues.push(value);
    });

    await channel.connect();
    await settleEvents();

    expect(states).toEqual([
      "initializing",
      "awaiting_qr",
      "authenticated",
      "ready",
    ]);
    expect(qrValues).toEqual(["qr-value"]);
    expect(channel.status().state).toBe("ready");
    expect(channel.diagnostics()).toEqual(
      expect.objectContaining({
        linkedIdentity: {
          externalId: "owner@c.us",
          displayName: "Mauricio",
          platform: "android",
        },
        providerState: "CONNECTED",
        webVersion: "2.3000.1",
        lastRawEvent: expect.objectContaining({ name: "ready" }),
        counters: expect.objectContaining({ rawEvents: 3, errors: 0 }),
      }),
    );
  });

  it("normalizes and deduplicates message/message_create events", async () => {
    const client = new StubClient();
    const channel = new WhatsAppWebChannel({ clientFactory: async () => client });
    const received: unknown[] = [];
    channel.on("message", (message) => {
      received.push(message);
    });
    await channel.connect();
    const message = createMessage({
      id: { _serialized: "incoming-1" },
      author: "group-member@c.us",
      from: "group@g.us",
      body: "Question",
      hasQuotedMsg: true,
      getQuotedMessage: async () =>
        createMessage({ id: { _serialized: "quoted-1" } }),
    });

    client.emit("message", message);
    client.emit("message_create", message);
    await settleEvents();

    expect(received).toEqual([
      expect.objectContaining({
        providerMessageId: "incoming-1",
        chatExternalId: "group@g.us",
        senderExternalId: "group-member@c.us",
        direction: "inbound",
        origin: "customer",
        text: "Question",
        quotedProviderMessageId: "quoted-1",
      }),
    ]);
    expect(channel.diagnostics()).toEqual(
      expect.objectContaining({
        lastRawMessage: expect.objectContaining({
          providerMessageId: "incoming-1",
          chatExternalId: "group@g.us",
        }),
        lastEmittedMessage: expect.objectContaining({
          providerMessageId: "incoming-1",
        }),
        counters: expect.objectContaining({
          rawMessages: 2,
          emittedMessages: 1,
          duplicateMessages: 1,
        }),
      }),
    );
  });

  it("discovers and searches existing chats using provider-neutral metadata", async () => {
    const client = new StubClient();
    client.chats = [
      {
        id: { _serialized: "acme@c.us" },
        name: "Acme Client",
        isGroup: false,
        archived: false,
        unreadCount: 3,
        timestamp: 1_789_211_600,
        fetchMessages: async () => [],
      },
      {
        id: { _serialized: "acme-team@g.us" },
        name: "Acme Team",
        isGroup: true,
        archived: false,
        unreadCount: 0,
        timestamp: 1_789_211_700,
        fetchMessages: async () => [],
      },
      {
        id: { _serialized: "old@c.us" },
        name: "Old account",
        isGroup: false,
        archived: true,
        unreadCount: 0,
        timestamp: 1_789_211_800,
        fetchMessages: async () => [],
      },
    ];
    const channel = new WhatsAppWebChannel({ clientFactory: async () => client });
    await channel.connect();
    await settleEvents();

    const chats = await channel.searchChats({
      text: "acme",
      includeGroups: false,
    });

    expect(chats).toEqual([
      expect.objectContaining({
        provider: "whatsapp-web",
        chatExternalId: "acme@c.us",
        displayName: "Acme Client",
        kind: "direct",
        unreadCount: 3,
      }),
    ]);
    expect(channel.diagnostics().counters.chatSearches).toBe(1);
  });

  it("fetches normalized history without emitting it as a live message", async () => {
    const client = new StubClient();
    client.recent = Array.from({ length: 510 }, (_, index) =>
      createMessage({
        id: { _serialized: `history-${index}` },
        timestamp: 1_789_211_600 + index,
      }),
    );
    const channel = new WhatsAppWebChannel({ clientFactory: async () => client });
    const live = vi.fn();
    channel.on("message", live);
    await channel.connect();
    await settleEvents();

    const history = await channel.getRecentMessages({
      chatExternalId: "551100000001@c.us",
      limit: 999,
    });

    expect(client.fetchLimit).toBe(500);
    expect(history).toHaveLength(500);
    expect(live).not.toHaveBeenCalled();
    expect(channel.diagnostics().counters.historyFetches).toBe(1);
  });

  it('uses lightweight page metadata when full group expansion is broken upstream',async()=>{
    const client=new StubClient();
    client.getChats.mockRejectedValueOnce(new Error('upstream group expansion failed'));
    const evaluate=vi.fn(async()=>[{id:{_serialized:'group@g.us'},name:'Working group',isGroup:true,archived:true,unreadCount:2,timestamp:1_789_211_600}]);
    client.pupPage={evaluate:evaluate as NonNullable<WhatsAppClientLike['pupPage']>['evaluate']};
    const channel=new WhatsAppWebChannel({clientFactory:async()=>client});await channel.connect();
    const chats=await channel.searchChats({text:'working',includeArchived:true});
    expect(chats).toEqual([expect.objectContaining({chatExternalId:'group@g.us',displayName:'Working group',kind:'group',archived:true})]);
    expect(client.getChats).not.toHaveBeenCalled();
  });

  it('recovers a provider receipt when WhatsApp throws after dispatch',async()=>{
    const client=new StubClient();
    const recovered=createMessage({
      id:{_serialized:'recovered-send'},
      from:'owner@c.us',
      to:'group@g.us',
      fromMe:true,
      body:'Transport smoke',
    });
    const evaluate=vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([recovered]);
    client.pupPage={evaluate:evaluate as NonNullable<WhatsAppClientLike['pupPage']>['evaluate']};
    client.sendMessage.mockRejectedValueOnce(new Error('opaque post-dispatch error'));
    const channel=new WhatsAppWebChannel({clientFactory:async()=>client});await channel.connect();

    await expect(channel.sendText({
      chatExternalId:'group@g.us',
      text:'Transport smoke',
      idempotencyKey:'receipt-recovery',
    })).resolves.toEqual(expect.objectContaining({
      providerMessageId:'recovered-send',
      chatExternalId:'group@g.us',
    }));
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('falls back to lightweight recent-message retrieval when getChatById fails',async()=>{
    const client=new StubClient();client.getChatById.mockRejectedValueOnce(new Error('upstream chat expansion failed'));
    const fallback=createMessage({id:{_serialized:'fallback-history'},from:'group@g.us',author:'member@c.us',body:'Recovered history'});
    const evaluate=vi.fn(async()=>[fallback]);
    client.pupPage={evaluate:evaluate as NonNullable<WhatsAppClientLike['pupPage']>['evaluate']};
    const channel=new WhatsAppWebChannel({clientFactory:async()=>client});await channel.connect();
    const history=await channel.getRecentMessages({chatExternalId:'group@g.us',limit:10});
    expect(history).toEqual([expect.objectContaining({providerMessageId:'fallback-history',chatExternalId:'group@g.us',text:'Recovered history'})]);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("marks adapter sends as agent-originated and honors idempotency keys", async () => {
    const client = new StubClient();
    const channel = new WhatsAppWebChannel({ clientFactory: async () => client });
    const received: Array<{ origin: string }> = [];
    channel.on("message", (message) => {
      received.push(message);
    });
    await channel.connect();

    const command = {
      chatExternalId: "customer@c.us",
      text: "Response",
      idempotencyKey: "outbox-1",
    };
    const [first, duplicate] = await Promise.all([
      channel.sendText(command),
      channel.sendText(command),
    ]);
    await settleEvents();

    expect(first).toEqual(duplicate);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(received).toEqual([expect.objectContaining({ origin: "agent" })]);
  });

  it("maps provider acknowledgements", async () => {
    const client = new StubClient();
    const channel = new WhatsAppWebChannel({ clientFactory: async () => client });
    const acknowledgements: unknown[] = [];
    channel.on("acknowledgement", (ack) => {
      acknowledgements.push(ack);
    });
    await channel.connect();
    const sent = createMessage({
      id: { _serialized: "sent-1" },
      fromMe: true,
      from: "owner@c.us",
      to: "customer@c.us",
    });

    client.emit("message_ack", sent, 3);
    await settleEvents();

    expect(acknowledgements).toEqual([
      expect.objectContaining({
        providerMessageId: "sent-1",
        chatExternalId: "customer@c.us",
        state: "read",
        providerCode: 3,
      }),
    ]);
  });

  it("tracks provider state changes and transport errors without changing readiness", async () => {
    const client = new StubClient();
    const channel = new WhatsAppWebChannel({ clientFactory: async () => client });
    await channel.connect();
    await settleEvents();

    client.emit("change_state", "TIMEOUT");
    client.sendMessage.mockRejectedValueOnce(new Error("provider send failed"));
    await expect(
      channel.sendText({
        chatExternalId: "customer@c.us",
        text: "Response",
        idempotencyKey: "failed-send",
      }),
    ).rejects.toThrow("provider send failed");

    expect(channel.status().state).toBe("ready");
    expect(channel.diagnostics()).toEqual(
      expect.objectContaining({
        providerState: "TIMEOUT",
        lastRawEvent: expect.objectContaining({ name: "change_state" }),
        lastError: expect.objectContaining({ message: "provider send failed" }),
        counters: expect.objectContaining({ errors: 1 }),
      }),
    );
  });

  it('bounds the successful-send cache while preserving in-flight coalescing', async () => {
    const client = new StubClient();
    const channel = new WhatsAppWebChannel({ clientFactory: async () => client, maxRememberedMessageIds: 2 });
    await channel.connect();
    for (const idempotencyKey of ['one', 'two', 'three']) {
      await channel.sendText({ chatExternalId: 'customer@c.us', text: idempotencyKey, idempotencyKey });
    }
    await channel.sendText({ chatExternalId: 'customer@c.us', text: 'one again', idempotencyKey: 'one' });
    expect(client.sendMessage).toHaveBeenCalledTimes(4);
  });

  it("refuses to reply when the source message belongs to another chat", async () => {
    const client = new StubClient();
    client.messages.set(
      "source-1",
      createMessage({
        id: { _serialized: "source-1" },
        from: "actual-chat@c.us",
      }),
    );
    const channel = new WhatsAppWebChannel({ clientFactory: async () => client });
    await channel.connect();

    await expect(
      channel.reply({
        chatExternalId: "wrong-chat@c.us",
        replyToProviderMessageId: "source-1",
        text: "Response",
        idempotencyKey: "reply-1",
      }),
    ).rejects.toThrow("belongs to actual-chat@c.us");
  });

  it("disconnects cleanly and rejects sends while offline", async () => {
    const client = new StubClient();
    const channel = new WhatsAppWebChannel({ clientFactory: async () => client });
    await channel.connect();
    await channel.disconnect();

    expect(client.destroy).toHaveBeenCalledOnce();
    expect(channel.status().state).toBe("disconnected");
    await expect(
      channel.sendText({
        chatExternalId: "chat",
        text: "No",
        idempotencyKey: "offline",
      }),
    ).rejects.toThrow("not ready");
  });
});
