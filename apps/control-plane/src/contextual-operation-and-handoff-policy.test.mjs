import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { withHandoffConversationContext } from "../.test-dist/handoff-conversation-context.js";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

test("pending handoff state is injected as semantic context without enumerating caller phrases", () => {
  const base = "Política base de la agente.";
  const pending = withHandoffConversationContext(base, true);

  assert.match(pending, /oferta de transferencia pendiente/);
  assert.match(pending, /pregunta, objeción, duda o petición de explicación/);
  assert.match(pending, /usa restaurant_conversation/);
  assert.match(pending, /restaurant_input_ignored solo si el contenido es claramente externo/);
  assert.doesNotMatch(pending, /por qu[eé] me transfieres/i);
  assert.equal(withHandoffConversationContext(pending, false), base);
  assert.equal((withHandoffConversationContext(pending, true).match(/\[CONTEXTO_ACTIVO_TRANSFERENCIA\]/g) ?? []).length, 1);
});

test("semantic policy keeps multi-turn reservations in the reservation tool", async () => {
  const [v17, v29] = await Promise.all([
    source("call-session-v17.ts"),
    source("call-session-v29.ts"),
  ]);

  assert.match(v17, /reserva multivuelta/);
  assert.match(v17, /no la elijas por inferencia propia/);
  assert.match(v29, /restaurant_conversation no es memoria operativa/);
  assert.match(v29, /usa restaurant_reservation_create desde que exista esa intención/);
  assert.match(v29, /no escales una reserva por el tamaño del grupo/);
  assert.match(v29, /pregunta, objeción o petición de explicación/);
  assert.match(v29, /no conviertas por ello un turno comunicativo dirigido en silencio/);
});

test("v43 composes pending-offer context at the provider-neutral policy boundary", async () => {
  const v43 = await source("call-session-v43-handoff-authorization.ts");

  assert.match(v43, /installRealtimeSessionPolicyTransform/);
  assert.match(v43, /withHandoffConversationContext/);
  assert.match(v43, /this\.handoffAuthorizationV43\.offerPending/);
  assert.doesNotMatch(v43, /session\.update/);
});
