import test from "node:test";
import assert from "node:assert/strict";

import {
  isRecipientOwned,
  stripServerOnlyDeliveryFields,
  withChannelBinding,
} from "./recipient-policy.js";

// alice's Telegram DM (chat id = her Telegram user id) is linked to her.
const lookupOwner = async (channelId: string, id: string) =>
  channelId === "telegram" && id === "111" ? "alice" : null;

const job = (delivery?: object) => ({ userId: "alice", delivery: delivery as never });

test("a job may deliver to its owner's linked channel account", async () => {
  assert.equal(await isRecipientOwned(job(), { channelId: "telegram", recipientId: "111" }, lookupOwner), true);
});

test("a job may not deliver to someone else's chat, however the recipient was set", async () => {
  // Explicit recipient, or derived from a crafted session_id like "whatsapp-<victim>".
  assert.equal(await isRecipientOwned(job(), { channelId: "telegram", recipientId: "999" }, lookupOwner), false);
  assert.equal(await isRecipientOwned(job(), { channelId: "whatsapp", recipientId: "15550001111" }, lookupOwner), false);
});

test("the chat a job was created from is allowed through its server-recorded binding", async () => {
  const delivery = { mode: "channel" as const, channelId: "telegram", recipientId: "-100123" };
  const bound = withChannelBinding(delivery, { channelName: "telegram", channelChatId: "-100123" });
  assert.equal(
    await isRecipientOwned(job(bound), { channelId: "telegram", recipientId: "-100123" }, lookupOwner),
    true,
  );
  // A binding only covers its own chat.
  assert.equal(
    await isRecipientOwned(job(bound), { channelId: "telegram", recipientId: "-100999" }, lookupOwner),
    false,
  );
});

test("no binding is recorded when the recipient isn't the current chat", () => {
  const delivery = { mode: "channel" as const, channelId: "telegram", recipientId: "999" };
  const result = withChannelBinding(delivery, { channelName: "telegram", channelChatId: "111" });
  assert.equal("channelBinding" in result, false);
});

test("clients can't supply a binding", () => {
  const forged = { mode: "channel", channelId: "telegram", recipientId: "999", channelBinding: { channelId: "telegram", chatId: "999" } };
  assert.deepEqual(stripServerOnlyDeliveryFields(forged), { mode: "channel", channelId: "telegram", recipientId: "999" });
});

test("push always goes to the job owner", async () => {
  assert.equal(await isRecipientOwned(job(), { channelId: "push", recipientId: "anyone" }, lookupOwner), true);
});
