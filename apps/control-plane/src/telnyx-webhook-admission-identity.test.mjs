import assert from "node:assert/strict";
import test from "node:test";
import { requireTelnyxWebhookAdmissionIdentity } from "../.test-dist/telnyx-webhook-admission-identity.js";

test("Telnyx retries preserve one admission identity and one Gemini bootstrap contract", () => {
  const event = {
    id: "event-incoming-1",
    occurred_at: "2026-08-24T18:49:24.123456Z",
  };

  // Delivery headers can have different timestamps; neither is an input here.
  const firstDelivery = requireTelnyxWebhookAdmissionIdentity(event);
  const retryDelivery = requireTelnyxWebhookAdmissionIdentity({ ...event });

  assert.equal(firstDelivery.eventId, "event-incoming-1");
  assert.equal(firstDelivery.occurredAt.toISOString(), "2026-08-24T18:49:24.123Z");
  assert.equal(firstDelivery.credentialNotAfterEpochMs, Date.parse(event.occurred_at) + 10 * 60 * 1000);
  assert.deepEqual(retryDelivery, firstDelivery);
});

test("incoming admission fails closed without the signed event identity or occurrence time", () => {
  assert.throws(
    () => requireTelnyxWebhookAdmissionIdentity({ occurred_at: "2026-08-24T18:49:24Z" }),
    /event id is required/,
  );
  assert.throws(
    () => requireTelnyxWebhookAdmissionIdentity({ id: "event-incoming-1", occurred_at: "not-a-date" }),
    /occurred_at is invalid/,
  );
});
