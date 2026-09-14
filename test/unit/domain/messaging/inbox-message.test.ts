import { describe, expect, it } from "bun:test";
import { InboxMessage } from "../../../../src/domain/messaging/inbox-message";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-01T00:05:00.000Z");

describe("InboxMessage", () => {
  it("receive nasce não processada", () => {
    const message = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "wager-transactions",
      payloadHash: "hash-1",
      receivedAt: NOW,
    });
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  it("markProcessed registra processedAt", () => {
    const message = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "wager-transactions",
      payloadHash: "hash-1",
      receivedAt: NOW,
    });
    message.markProcessed(LATER);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(LATER);
  });

  it("rehydrate reconstrói o estado persistido", () => {
    const processed = InboxMessage.rehydrate({
      messageId: "msg-1",
      consumerName: "wager-transactions",
      payloadHash: "hash-1",
      receivedAt: NOW,
      processedAt: LATER,
    });
    expect(processed.isProcessed()).toBe(true);

    const pending = InboxMessage.rehydrate({
      messageId: "msg-2",
      consumerName: "wager-transactions",
      payloadHash: "hash-2",
      receivedAt: NOW,
    });
    expect(pending.isProcessed()).toBe(false);
  });
});
