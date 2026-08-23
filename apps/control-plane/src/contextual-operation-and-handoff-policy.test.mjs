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
  const [bootstrap, v29] = await Promise.all([
    source("direct-agent-realtime-bootstrap.ts"),
    source("call-session-v29.ts"),
  ]);

  assert.match(bootstrap, /reserva multivuelta/);
  assert.match(bootstrap, /no la elijas por inferencia propia/);
  assert.match(v29, /restaurant_conversation no es memoria operativa/);
  assert.match(v29, /fecha exacta usa restaurant_reservation_create desde que exista esa intención/);
  assert.match(v29, /no escales una reserva ordinaria por el tamaño del grupo/);
  assert.match(v29, /pregunta, objeción o petición de explicación/);
  assert.match(v29, /no conviertas por ello un turno comunicativo dirigido en silencio/);
});

test("inclusive accommodation needs stay in restaurant scope and receive respectful human confirmation", async () => {
  const [bootstrap, v29, v43] = await Promise.all([
    source("direct-agent-realtime-bootstrap.ts"),
    source("call-session-v29.ts"),
    source("call-session-v43-handoff-authorization.ts"),
  ]);

  assert.match(bootstrap, /"ACCESSIBILITY_ARRANGEMENT"/);
  assert.match(bootstrap, /"CHILD_OR_INFANT_ACCOMMODATION"/);
  assert.match(bootstrap, /incluso antes de iniciar una reserva/);
  assert.match(bootstrap, /nunca están fuera de ámbito/);
  assert.match(v29, /ATENCIÓN INCLUSIVA Y ADAPTACIONES/);
  assert.match(v29, /aunque aún no haya una reserva activa/);
  assert.match(v29, /No prometas ni niegues que una adaptación esté disponible/);
  assert.match(v29, /nunca de la persona como un problema/);
  assert.match(v29, /consentimiento explícito/);

  const confirmationStart = v43.indexOf('"HUMAN_HANDOFF_CONFIRMATION_REQUIRED"');
  const confirmationEnd = v43.indexOf("} else if (!this.handoffClarificationIssuedV43)", confirmationStart);
  const confirmationBoundary = v43.slice(confirmationStart, confirmationEnd);
  assert.match(v43, /INCLUSIVE_ASSISTANCE_REASONS/);
  assert.match(v43, /todo esté bien preparado para la visita/);
  assert.match(v43, /no presentes a la persona ni su necesidad como un problema/);
  assert.match(confirmationBoundary, /handoffOfferInstructions\(event\)/);
  assert.doesNotMatch(confirmationBoundary, /exactText:/);
  assert.doesNotMatch(`${bootstrap}\n${v29}\n${v43}`, /ando en silla de ruedas/i);
});

test("v43 composes pending-offer context at the provider-neutral policy boundary", async () => {
  const v43 = await source("call-session-v43-handoff-authorization.ts");

  assert.match(v43, /installRealtimeSessionPolicyTransform/);
  assert.match(v43, /withHandoffConversationContext/);
  assert.match(v43, /this\.handoffAuthorizationV43\.offerPending/);
  assert.doesNotMatch(v43, /session\.update/);
});
