# Diseño — producto Gemini independiente

> **Estado:** PROPUESTO / FASE 2 ACTIVA  
> **Fecha:** 2026-08-26  
> **ADR autoridad:** [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> **Inventario de entrada:** [`PROVIDER_RUNTIME_INVENTORY_PHASE1_CLOSURE.md`](./PROVIDER_RUNTIME_INVENTORY_PHASE1_CLOSURE.md)  
> **Plan vivo:** [`OPENAI_GEMINI_SEPARATION_WORKPLAN.md`](./OPENAI_GEMINI_SEPARATION_WORKPLAN.md)

## 1. Objetivo

Definir un producto Gemini que pueda desplegarse y operar sin runtime, semántica, SDK ni credenciales OpenAI.

El diseño prioriza:

1. semántica real de Gemini Live;
2. baja latencia;
3. una sola identidad vocal por sesión;
4. ToolGateway/dominio/Supabase como autoridades empresariales compartidas;
5. media continuo fuera de Cloudflare Worker;
6. ownership explícito y pequeño;
7. recuperación basada en mecanismos nativos de Gemini Live;
8. ausencia de selector OPENAI/GEMINI dentro del runtime del producto;
9. observabilidad suficiente sin audio, secretos ni PII innecesaria;
10. capacidad de limpiar después el producto OpenAI sin romper Gemini.

---

# 2. Evidencia externa verificada

Diseño contrastado el 2026-08-26 con documentación oficial actual.

## Gemini Live

- Live usa una sesión WebSocket persistente y soporta audio bidireccional/nativo.
- input audio nativo: PCM 16-bit/16 kHz; output audio: PCM 16-bit/24 kHz.
- function calling en Live requiere que el cliente ejecute la función y envíe manualmente `FunctionResponse`.
- se puede desactivar VAD automático y enviar `activityStart` / `activityEnd` desde el cliente.
- `interrupted`, `generationComplete` y `turnComplete` son señales nativas de lifecycle.
- `inputAudioTranscription` existe, pero sus mensajes de transcripción se entregan independientemente y **sin ordering garantizado** respecto a otros mensajes.
- session resumption y `GoAway` son mecanismos nativos para reconexión/lifetime; no se debe reiniciar una sesión para inyectar contexto después de cada tool.

Referencias oficiales:

- https://ai.google.dev/gemini-api/docs/live-api
- https://ai.google.dev/gemini-api/docs/live-api/capabilities
- https://ai.google.dev/gemini-api/docs/live-api/tools
- https://ai.google.dev/gemini-api/docs/live-api/session-management
- https://ai.google.dev/api/live

## Cloudflare

- Durable Objects son el punto de coordinación recomendado para WebSockets stateful.
- un DO puede actuar como servidor WebSocket y usar Hibernation API para conexiones entrantes.
- hibernation no aplica a WebSockets salientes; por eso el Gemini Live WebSocket permanece en el Media Edge y no se mueve al DO por comodidad arquitectónica.

Referencias oficiales:

- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/

---

# 3. Topología objetivo

```text
                                  SUPABASE COMPARTIDO
                             negocio + diagnóstico seguro
                                        ▲
                                        │ contratos shared
                                        │
PSTN                                    │
 │                                      │
 ▼                                      │
Telnyx ───── webhook/control ─────► GEMINI CONTROL PLANE WORKER
 │                                      │
 │                                      ▼
 │                              GeminiCallSession DO
 │                              business/turn/tool authority
 │                                      ▲
 │                                      │ control WSS
 │                                      ▼
 └──── L16 Media Streaming ─────► GEMINI MEDIA EDGE
                                   │           │
                                   │           └─ bounded STT/security evidence
                                   │
                                   └──── WSS ─────► GEMINI LIVE
                                                     │
                                                     └─ AUDIO nativo
```

Conceptualmente:

```text
Producto Gemini
= Gemini Control Plane Worker
+ GeminiCallSession Durable Object
+ Gemini Media Edge
+ Gemini Live
+ shared business/data packages
```

No existe dependencia runtime hacia el Worker OpenAI.

---

# 4. Ownership por componente

## 4.1 Gemini Control Plane Worker

Propietario de:

- verificación/admission de webhook Telnyx;
- tenant binding/config empresarial;
- caller security pre-call;
- creación/localización del `GeminiCallSession` DO;
- `answer`/`streaming_start` Telnyx;
- emisión de credencial efímera call↔Media Edge;
- ToolGateway y composición de módulos de negocio;
- hangup/handoff de Call Control;
- health/readiness del producto Gemini.

No posee:

- frames de audio;
- codec/resampling;
- socket Gemini Live;
- playback PCM;
- Google/OpenAI wire de otro producto.

## 4.2 `GeminiCallSession` Durable Object

Un DO por llamada es la autoridad stateful de control de la conversación Gemini.

Propietario de:

- lifecycle lógico de la llamada;
- `turn_id` neutral por caller turn;
- estado `LISTENING / CALLER_ACTIVE / TURN_GATING / TOOL_PENDING / ASSISTANT_ACTIVE / CLOSING / TERMINAL`;
- caller-turn authorization/security result;
- tool calls pendientes por `tool_call_id`;
- autorización ToolGateway;
- reserva/confirmación/estado empresarial de sesión cuando corresponda;
- respuesta a tool result;
- cierre/handoff;
- correlación de eventos cross-plane;
- control WSS con el Media Edge.

No posee:

- `response.create`;
- `session.update` OpenAI;
- provider selector;
- audio buffers;
- socket Gemini Live;
- TTS.

## 4.3 Gemini Media Edge

Debe reducirse a un **media/provider edge**, no a un segundo Control Plane.

Propietario de:

- WSS Telnyx Media Streaming;
- validación de credencial/binding del stream;
- reorder bounded de frames Telnyx;
- PCM framing/resampling;
- VAD acústico necesario para turn boundaries/barge-in;
- WebSocket Gemini Live;
- setup Gemini Live;
- session resumption / GoAway;
- streaming de audio Telnyx→Gemini;
- recepción Gemini→Telnyx;
- buffering de audio mientras un turno está en gate;
- playback mark/clear y evidencia de reproducción;
- traducción mínima de eventos Live a eventos control-plane;
- tool calls en espera de autorización;
- diagnóstico local bounded.

No posee:

- Supabase de negocio;
- ToolGateway;
- reservas;
- provider selection;
- semantic preselection mediante un segundo modelo;
- decisiones de negocio;
- voz alternativa Google TTS.

## 4.4 Gemini Live

Propietario de:

- comprensión multimodal/voz;
- elección de function call dentro del catálogo autorizado de sesión;
- generación natural de respuesta;
- voz nativa única de la sesión;
- `interrupted` / `generationComplete` / `turnComplete`;
- session resumption tokens / GoAway.

El modelo nunca es autoridad de permisos, confirmación empresarial ni persistencia.

---

# 5. Contrato Worker ↔ Media Edge

Se reemplaza el sideband histórico por un contrato pequeño, versionado y provider-specific.

El transporte preferido es **un WebSocket entrante al `GeminiCallSession` DO desde el Media Edge**. Cloudflare puede mantener coordinación WebSocket stateful en el DO; el socket Gemini Live continúa en el Edge.

## 5.1 Identidad

Toda conexión se liga a:

```text
tenant_id
call_control_id
call_session_id
edge_session_id
contract_version
credential_id
```

La credencial es efímera, de un solo ámbito y no se registra en diagnóstico.

## 5.2 Edge → Worker: eventos mínimos

```text
EDGE_READY
MEDIA_STARTED
CALLER_ACTIVITY_STARTED { turn_id }
CALLER_ACTIVITY_ENDED { turn_id }
CALLER_TRANSCRIPT_READY { turn_id, redacted/authorized evidence reference }
GEMINI_TOOL_CALL { turn_id, tool_call_id, tool_name, arguments }
GEMINI_GENERATION_STARTED { turn_id, generation_id }
GEMINI_INTERRUPTED { generation_id }
GEMINI_GENERATION_COMPLETE { generation_id }
GEMINI_TURN_COMPLETE { generation_id }
PLAYBACK_STARTED { generation_id }
PLAYBACK_COMPLETED { generation_id }
SESSION_RESUMPTION_UPDATE { opaque_handle_ref }
PROVIDER_GO_AWAY { time_left_ms }
PROVIDER_RECONNECTED
MEDIA_CLOSED
EDGE_ERROR { category }
```

No se transporta audio por este canal.

## 5.3 Worker → Edge: comandos mínimos

```text
TURN_AUTHORIZED { turn_id }
TURN_REJECTED { turn_id, policy_code }
TOOL_RESULT { tool_call_id, tool_name, structured_result }
TOOL_REJECTED { tool_call_id, policy_code }
CLEAR_PLAYBACK { generation_id }
SET_PROTECTED_INPUT { enabled }
START_CONTROL_TURN { control_kind }
TERMINATE_MEDIA { reason }
```

No existen comandos genéricos `CREATE_RESPONSE` / `DEFAULT_RESPONSE` nacidos de OpenAI.

## 5.4 Serialización y error

- orden por `sequence` monotónico por dirección;
- cada comando que produce efecto tiene `command_id` idempotente;
- una falla de comando **no envenena automáticamente toda la sesión**;
- errores se clasifican como `RETRYABLE_COMMAND`, `TURN_REJECTED`, `SESSION_TERMINAL` o `PROTOCOL_VIOLATION`;
- no existe equivalente al `commandFailure` sticky actual sin política explícita;
- reconnect del control WSS puede recuperar estado desde el DO por `call_session_id` y último sequence confirmado.

---

# 6. Flujo normal de caller turn

## 6.1 Ingreso de audio

Después del saludo protegido:

```text
Telnyx audio
→ Media Edge
→ VAD/candidate owner
→ activityStart + PCM → Gemini Live
→ audio continúa en chunks pequeños
→ activityEnd al finalizar el caller turn
```

El audio llega a Gemini Live **en tiempo real**; no se espera a STT ni semantic preselection antes de alimentar el modelo.

Esto elimina del pre-provider critical path actual:

```text
caller audio
→ STT completo
→ classifier completo
→ recién entonces Gemini Live
```

## 6.2 Gate de seguridad/negocio en paralelo

Durante el mismo turno el Edge conserva un buffer PCM bounded para obtener evidencia textual autorizable.

Baseline inicial recomendado para Fase 3:

```text
Gemini Live procesa audio            ┐
                                     ├─ en paralelo
Google STT obtiene transcript        ┘
```

El STT **no bloquea la entrada a Gemini Live**. Sí bloquea efectos de tools y la liberación de output audible hasta completar el gate de caller security.

El Worker recibe transcript/turn evidence, ejecuta:

- seguridad;
- tenant/tool permissions;
- business confirmation invariants;
- autorización de turno.

Luego envía `TURN_AUTHORIZED` o `TURN_REJECTED`.

### Por qué mantener STT inicialmente

Gemini Live ofrece `inputAudioTranscription`, pero la referencia oficial indica que esos mensajes se envían independientemente y sin ordering garantizado respecto a otros mensajes. No existe en la evidencia consultada un flag de transcript-final equivalente a nuestra autoridad actual.

Por tanto, Fase 3 puede conservar Google STT **en paralelo** como baseline seguro, mientras un benchmark específico compara:

1. Google STT actual;
2. transcript Gemini Live + boundary propio;
3. streaming STT si aporta latencia/quality suficientes.

Eliminar STT será una optimización probada, no una apuesta arquitectónica.

## 6.3 Quarantine de output

Mientras el turno no esté autorizado:

- tool calls quedan retenidos;
- PCM generado por Gemini puede guardarse en buffer bounded, pero no reproducirse;
- si el buffer supera el límite antes de autorización, se falla cerrado en lugar de crecer sin límite.

Cuando llega `TURN_AUTHORIZED`:

- audio conversacional buffered se libera en orden;
- tool call autorizado puede ejecutarse;
- el resto de audio continúa streaming normalmente.

Cuando llega `TURN_REJECTED`:

- se descarta output del turno;
- no se ejecuta ninguna tool;
- se aplica política de seguridad/cierre/control-turn.

---

# 7. Tool flow nativo Gemini

Se elimina la obligación de `semantic preselection → Gemini Live tool call → comparar ambos`.

Flujo objetivo:

```text
Gemini Live
  ↓ GEMINI_TOOL_CALL
Media Edge
  ↓ hold + correlate
GeminiCallSession DO
  ↓ security + capability + business invariant
ToolGateway
  ↓
Shared domain / Supabase
  ↓ structured result
GeminiCallSession DO
  ↓ TOOL_RESULT
Media Edge
  ↓ FunctionResponse con mismo tool_call_id
Gemini Live
  ↓ continuación natural en la MISMA sesión
```

## 7.1 Autorización sin segundo clasificador

La seguridad se obtiene mediante capas deterministas:

1. tool incluida en catálogo de sesión;
2. tenant capability/allowlist;
3. caller turn autorizado;
4. schema validation;
5. business-state invariant;
6. confirmación explícita para escrituras irreversibles/sensibles;
7. commit backend como fuente de verdad.

La selección de intención abierta pertenece a Gemini Live. No se llama a un segundo Gemini para decidir qué tool debería haber elegido Gemini Live.

Si aparece evidencia futura de que una clase de tool necesita un semantic gate adicional, se diseña sólo para esa clase y se mide su coste.

## 7.2 Continuación post-tool

Después de un `FunctionResponse`:

- se conserva la misma sesión Live;
- Gemini continúa naturalmente con el resultado estructurado;
- no se cierra/reabre el provider para insertar bootstrap;
- estados `NEEDS_INFO`, `OUTSIDE_BUSINESS_HOURS`, `AVAILABLE`, `BOOKED`, etc. se expresan en resultados estructurados del dominio;
- system instruction establece cómo verbalizar estos estados y nunca afirmar éxito sin evidencia backend.

La session rotation sólo se usa para `GoAway`/fallo/lifetime y mediante session resumption cuando sea posible.

---

# 8. Una sola identidad vocal

## 8.1 Decisión

El producto Gemini final usa **Gemini Live native audio como motor audible normal y de continuidad**.

Se elimina Google Text-to-Speech como segunda voz del camino productivo Gemini.

Las respuestas de tool, missing fields, business hours, confirmaciones y alternativas se verbalizan por Gemini Live a partir de estado estructurado, no por TTS paralelo.

## 8.2 Control speech

Quedan pocos casos system-owned que no nacen de un caller turn:

- greeting;
- presence/recovery;
- handoff announcement;
- terminal message.

El diseño preferido usa `START_CONTROL_TURN {control_kind}` y un mecanismo Gemini-native de control turn que produzca audio con la misma voz Live, sin registrar ese control como caller evidence.

**Gate de implementación:** antes de Fase 3 se debe probar sintéticamente el mecanismo exacto de control turn con Live (`sendClientContent`/realtime text u otra capacidad vigente) y confirmar:

1. no contamina caller transcript;
2. produce audio en la misma voz;
3. no rompe tool/turn ownership;
4. no necesita falsear estado empresarial;
5. puede correlacionarse por generation id.

Si no existe una semántica Live suficientemente limpia, el fallback no será volver silenciosamente a Google TTS: se hará un benchmark explícito de una estrategia de voz única para **todas** las respuestas.

## 8.3 Greeting protegido

Mientras se reproduce el saludo:

- `SET_PROTECTED_INPUT=true`;
- el Edge no entrega audio superpuesto a Gemini como caller turn;
- el audio se descarta bounded;
- sólo `PLAYBACK_COMPLETED` libera input;
- después `SET_PROTECTED_INPUT=false`.

Esta garantía se conserva del sistema actual sin copiar su response lifecycle OpenAI.

---

# 9. Barge-in e input detection

## 9.1 Decisión inicial

Mantener VAD acústico en el Media Edge durante la primera implementación porque:

- está junto al audio;
- permite caller candidate identity propia;
- permite saludo protegido;
- permite enviar `activityStart/activityEnd` explícitos a Gemini Live;
- la API Live soporta oficialmente VAD manual.

Gemini automatic VAD queda desactivado en la primera versión para evitar dos owners del mismo boundary.

## 9.2 Interrupción

Durante assistant playback normal:

```text
caller VAD start
→ CALLER_ACTIVITY_STARTED(turn_id)
→ activityStart a Gemini
→ Gemini `interrupted`
→ Edge clear Telnyx playback
→ Worker correlaciona generation/turn
```

No se espera a transcript para vaciar playback; la evidencia acústica es suficiente para interrupción normal.

Protected speech ignora esta regla y descarta caller audio hasta completar playback.

---

# 10. Session lifecycle y reconexión

## 10.1 Estados Edge/Live

```text
NEW
→ CONNECTING
→ SETUP_SENT
→ READY
↔ GENERATING
↔ TOOL_WAIT
↔ INTERRUPTED
→ RESUMING
→ READY
→ CLOSING
→ CLOSED
```

## 10.2 Mecanismos nativos

Configurar:

- `contextWindowCompression`;
- `sessionResumption` cuando la política de datos del deployment lo permita;
- manejo de `SessionResumptionUpdate`;
- manejo de `GoAway.timeLeft`;
- reconexión con último handle válido.

No confundir sesión lógica con una única conexión WebSocket.

### Privacidad

La documentación Gemini indica que session resumption implica almacenamiento de estado para permitir reconexión. Si un cliente exige zero-data-retention estricto, esta capability debe poder deshabilitarse y aceptar una política diferente de reconexión. No se activa sin reflejarlo en configuración/compliance.

---

# 11. Estado del GeminiCallSession DO

Modelo inicial deliberadamente pequeño:

```text
CALL_BOOTSTRAP
LISTENING
CALLER_ACTIVE
TURN_GATING
TOOL_PENDING
ASSISTANT_ACTIVE
CLOSING
TERMINAL
```

Owners separados dentro de la sesión:

```text
CallLifecycleOwner
CallerTurnOwner
ToolAuthorizationOwner
BusinessConversationState
PlaybackObservationState   # evidencia, no audio
```

No crear una nueva cadena V55/V56 ni heredar las 50+ generaciones actuales. La implementación será composición explícita desde módulos pequeños.

---

# 12. Shared packages objetivo

No mover todo al inicio. Extraer sólo cuando exista consumidor OpenAI + Gemini o una frontera claramente reusable.

Objetivo conceptual:

```text
packages/
  business-domain/
    tool-gateway
    reservations
    business-hours
    authorization
  data-supabase/
    contracts
    adapters
  security/
    caller-security
    diagnostic-redaction
  diagnostics/
    cross-plane-contract
```

Cada paquete shared:

- no importa OpenAI/Gemini SDK;
- no conoce WebSocket provider wire;
- no lee `host.env` directamente;
- recibe dependencias/configuración por parámetros.

---

# 13. Estructura de apps objetivo

```text
apps/
  control-plane/                 # evolucionará a producto OpenAI
  gemini-control-plane/          # NUEVO Worker
  gemini-media-edge/             # Edge reducido/específico media
  gemini-media-edge-benchmark/
```

`apps/gemini-control-plane/` tendrá como mínimo:

```text
src/
  index.ts
  gemini-call-session.ts
  admission/
  control-contract/
  call-lifecycle/
  tool-runtime/
  telephony/
wrangler.jsonc
package.json
```

No se copia la estructura V2…V54.

---

# 14. Secrets y bindings

Gemini Worker:

```text
TELNYX_API_KEY
TELNYX_PUBLIC_KEY
SUPABASE_URL
SUPABASE_SECRET_KEY
MEDIA_EDGE_URL
MEDIA_EDGE_CREDENTIAL_SIGNING_KEY (o binding equivalente)
TENANT_CONFIG
GEMINI_CALL_SESSIONS
```

Gemini Media Edge:

```text
GEMINI_API_KEY
CONTROL_PLANE_URL
control credential verification material
Google STT credentials mientras siga habilitado
```

**Prohibido en producto Gemini:**

```text
OPENAI_API_KEY
OPENAI_PROJECT_ID
OpenAI SDK como runtime dependency
```

El Worker OpenAI no necesitará, tras Fase 4:

```text
GEMINI_API_KEY
GEMINI_MEDIA_EDGE_URL
MEDIA_EDGE_CONTROL_PLANE_TOKEN
```

---

# 15. Observabilidad

Supabase sigue siendo la fuente compartida para diagnóstico técnico bounded.

Todo evento nuevo incluye cuando sea aplicable:

```text
product = GEMINI
runtime = gemini-control-plane | gemini-media-edge | gemini-live
deployment_id
call_control_id
call_session_id
turn_id
generation_id
tool_call_id
causal_parent_event_id
```

No se persisten:

- audio;
- API tokens;
- session resumption handles;
- bootstrap credentials;
- prompts completos;
- transcripciones sin redacción salvo política explícita ya existente.

El Edge no necesita que el Worker haga pull de todo al hangup como única estrategia. El diseño preferido usa batches bounded/event-driven hacia la autoridad de persistencia; la implementación exacta se decide en Fase 3.

---

# 16. CI y E2E del producto Gemini

Pipeline futuro independiente:

```text
Gemini Control Plane CI
Gemini Media Edge CI
Gemini Contract/Integration CI
Gemini Canary Deploy
Gemini E2E
```

El CI Gemini no depende de ejecutar suite OpenAI completa para declarar su propio artefacto válido; sí puede ejecutar shared-package tests cuando los modifica.

E2E mínimo antes de declarar autónomo Gemini:

1. incoming call/admission;
2. greeting protegido con una sola voz;
3. turno conversacional simple;
4. pregunta inesperada dentro de scope;
5. reserva progresiva;
6. outside business hours → alternativa → continuación;
7. confirmación y BOOKED real;
8. tool rejection/permission;
9. barge-in;
10. split caller utterance;
11. provider GoAway/session resumption;
12. control WSS reconnect;
13. hangup/handoff;
14. ausencia de secretos OpenAI;
15. diagnóstico reconstructible cross-plane.

---

# 17. Cambios respecto al híbrido actual

| Actual | Objetivo Gemini independiente |
|---|---|
| mismo Worker selecciona OpenAI/Gemini | Worker Gemini dedicado |
| `realtime-provider-runtime` universal | runtime Gemini propio |
| CallSession V2…V54 | `GeminiCallSession` por composición |
| sideband grande/sticky | contrato Worker↔Edge pequeño/versionado |
| STT antes de alimentar Live | audio a Live inmediato + STT gate paralelo inicialmente |
| isolated semantic classifier | eliminado por defecto |
| tool preselection vs Live conflict | ToolGateway/business invariants autorizan tool real |
| provider rotation post-tool | FunctionResponse en misma sesión |
| Google TTS + Gemini Live | una sola voz Gemini Live |
| reconnect ad hoc | session resumption + GoAway |
| Worker OpenAI conoce Media Edge Gemini | Worker OpenAI no conoce Gemini tras Fase 4 |

---

# 18. Decisiones que requieren probe/benchmark antes de implementación final

## D1 — STT authority

Comparar Google STT batch actual vs Gemini input transcription vs alternativa streaming.

Métricas:

- end-of-speech→transcript-ready p50/p95;
- WER/corrección española/telefonía;
- split-utterance behavior;
- coste/minuto;
- impacto en tool authorization;
- ordering/completion evidence.

## D2 — Control speech Gemini-native

Probar greeting/presence/handoff/terminal sin Google TTS y sin convertirlos en caller evidence.

## D3 — Output quarantine

Medir memoria y latencia de buffer hasta `TURN_AUTHORIZED`; definir límite bounded y política fail-closed.

## D4 — Worker↔Edge WSS

Probar:

- DO WebSocket server;
- reconnect;
- sequence/idempotency;
- no sticky poison;
- pérdida/duplicación;
- latencia p50/p95.

---

# 19. Orden de implementación propuesto

Cuando este diseño se acepte:

1. crear `apps/gemini-control-plane` skeleton sin tráfico;
2. crear contrato Worker↔Edge y tests puros;
3. mover/copiar sólo shared contracts imprescindibles por extracción limpia;
4. implementar GeminiCallSession mínimo;
5. conectar admission Telnyx sin habilitar número productivo;
6. adaptar Media Edge al nuevo control contract detrás de flag/test;
7. conectar Gemini Live mismo-session tool continuation;
8. eliminar isolated semantic preselection del nuevo camino;
9. implementar single-voice path;
10. ejecutar probes D1–D4;
11. E2E sintético;
12. canary Gemini manual;
13. sólo después retirar el camino Gemini híbrido;
14. después iniciar Fase 4 de limpieza OpenAI.

---

# 20. Criterio de salida Fase 2

Fase 2 puede cerrarse cuando:

- [ ] este diseño haya sido revisado contra repo y APIs actuales;
- [ ] entrypoint/DO/owners estén definidos;
- [ ] contrato Worker↔Edge esté definido;
- [ ] tool flow same-session esté definido;
- [ ] single-voice strategy esté definida;
- [ ] barge-in/VAD estén definidos;
- [ ] session resumption/reconnect estén definidos;
- [ ] shared-domain injection esté definida;
- [ ] D1–D4 tengan plan de prueba;
- [ ] no quede ninguna dependencia OpenAI en el diseño Gemini;
- [ ] el plan de Fase 3 pueda dividirse en commits incrementales sin romper OpenAI.
