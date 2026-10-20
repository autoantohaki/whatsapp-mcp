import type {
  ChannelEventHandler,
  ChannelEventMap,
  ChannelEventName,
  Unsubscribe,
} from "../domain.ts";

type HandlerTable = {
  [K in ChannelEventName]: Set<ChannelEventHandler<K>>;
};

export class ChannelEventBus {
  private readonly handlers: HandlerTable = {
    message: new Set(),
    acknowledgement: new Set(),
    status: new Set(),
    qr: new Set(),
    error: new Set(),
  };

  on<K extends ChannelEventName>(
    event: K,
    handler: ChannelEventHandler<K>,
  ): Unsubscribe {
    this.handlers[event].add(handler);
    return () => this.handlers[event].delete(handler);
  }

  async emit<K extends ChannelEventName>(
    event: K,
    payload: ChannelEventMap[K],
  ): Promise<void> {
    const handlers = [...this.handlers[event]] as ChannelEventHandler<K>[];
    const results = await Promise.allSettled(
      handlers.map((handler) => Promise.resolve().then(() => handler(payload))),
    );

    if (event === "error") return;
    for (const result of results) {
      if (result.status === "rejected") {
        const error =
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason));
        await this.emit("error", {
          error,
          occurredAt: new Date().toISOString(),
        });
      }
    }
  }
}
