import test from "node:test";
import assert from "node:assert/strict";
import { normalizeChannels, normalizeDelivery } from "../src/channel-filter.js";

test("normalizes a list of channel names", () => {
  assert.deepEqual(normalizeChannels([" Email ", "sms", "email"]), ["email", "sms"]);
  assert.deepEqual(normalizeChannels([]), []);
});

test("normalizes delivery flags", () => {
  assert.deepEqual(normalizeDelivery({ " Push ": true, sms: false }), { push: true, sms: false });
  assert.deepEqual(normalizeDelivery({}), {});
});
