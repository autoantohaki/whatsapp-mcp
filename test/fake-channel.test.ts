import { describe, expect, it, vi } from "vitest";
import type { NormalizedMessage } from "../src/domain.ts";
import { FakeMessagingChannel } from "../src/whatsapp/fake-channel.ts";

const fixedNow = () => new Date("2026-09-12T12:00:00.000Z");

describe("FakeMessagingChannel", () => {
  it("has deterministic lifecycle and idempotent sends", async () => {
    const channel = new FakeMessagingChannel({ now: fixedNow });
    const states: string[] = [];
    channel.on("status", (event) => {
      states.push(event.state);
    });

    await channel.connect();
    const first = await channel.sendText({
      chatExternalId: "chat-1",
      text: "Hello",
      idempotencyKey: "draft-1",
    });
    const duplicate = await channel.sendText({
      chatExternalId: "chat-1",
      text: "Hello",
      idempotencyKey: "draft-1",
    });

    expect(first).toEqual(duplicate);
    expect(first.providerMessageId).toBe("fake-1");
    expect(states).toEqual(["initializing", "ready"]);
    expect(await channel.getRecentMessages({ chatExternalId: "chat-1" })).toHaveLength(1);
  });

  it("deduplicates injected provider messages", async () => {
    const channel = new FakeMessagingChannel({ now: fixedNow });
    const handler = vi.fn();
    channel.on("message", handler);
    await channel.connect();
    const message: NormalizedMessage = {
      provider: "fake",
      providerMessageId: "incoming-1",
      chatExternalId: "chat-1",
      senderExternalId: "customer-1",
      direction: "inbound",
      origin: "customer",
      kind: "text",
      text: "Question",
      occurredAt: fixedNow().toISOString(),
    };

    await channel.injectMessage(message);
    await channel.injectMessage(message);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(channel.diagnostics()).toEqual(
      expect.objectContaining({
        lastRawMessage: expect.objectContaining({
          providerMessageId: "incoming-1",
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

  it("discovers seeded and observed chats deterministically", async () => {
    const channel = new FakeMessagingChannel({
      now: fixedNow,
      chats: [
        {
          provider: "fake",
          chatExternalId: "existing@c.us",
          displayName: "Existing Client",
          kind: "direct",
          archived: false,
          unreadCount: 0,
          lastActivityAt: "2026-09-11T12:00:00.000Z",
        },
        {
          provider: "fake",
          chatExternalId: "archived@c.us",
          displayName: "Archived Client",
          kind: "direct",
          archived: true,
          unreadCount: 0,
        },
      ],
    });
    await channel.connect();
    await channel.injectMessage({
      provider: "fake",
      providerMessageId: "new-1",
      chatExternalId: "new@c.us",
      senderExternalId: "new@c.us",
      direction: "inbound",
      origin: "customer",
      kind: "text",
      text: "Hello",
      occurredAt: fixedNow().toISOString(),
    });

    expect(await channel.searchChats({ text: "client" })).toEqual([
      expect.objectContaining({ chatExternalId: "existing@c.us" }),
    ]);
    expect(await channel.searchChats()).toEqual([
      expect.objectContaining({ chatExternalId: "new@c.us", unreadCount: 1 }),
      expect.objectContaining({ chatExternalId: "existing@c.us" }),
    ]);
    expect(channel.diagnostics().counters.chatSearches).toBe(2);
  });

  it("isolates subscriber failures and reports them", async () => {
    const channel = new FakeMessagingChannel({ now: fixedNow });
    const errors: Error[] = [];
    channel.on("error", ({ error }) => {
      errors.push(error);
    });
    channel.on("message", () => {
      throw new Error("subscriber failed");
    });
    await channel.connect();

    await channel.injectMessage({
      provider: "fake",
      providerMessageId: "incoming-2",
      chatExternalId: "chat-1",
      senderExternalId: "customer-1",
      direction: "inbound",
      origin: "customer",
      kind: "text",
      text: "Question",
      occurredAt: fixedNow().toISOString(),
    });

    expect(errors.map((error) => error.message)).toEqual(["subscriber failed"]);
  });
});
