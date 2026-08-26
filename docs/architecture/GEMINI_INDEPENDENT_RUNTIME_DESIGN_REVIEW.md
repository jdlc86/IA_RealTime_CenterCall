# Revisión normativa — diseño del producto Gemini independiente

> **Estado:** APROBADO CON ENMIENDAS / FASE 2  
> **Fecha:** 2026-08-26  
> **Documento revisado:** [`GEMINI_INDEPENDENT_RUNTIME_DESIGN.md`](./GEMINI_INDEPENDENT_RUNTIME_DESIGN.md)  
> **Autoridad:** [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> **Inventario:** [`PROVIDER_RUNTIME_INVENTORY_PHASE1_CLOSURE.md`](./PROVIDER_RUNTIME_INVENTORY_PHASE1_CLOSURE.md)

## 1. Propósito

Esta revisión valida el diseño del producto Gemini independiente contra:

- el repositorio real inventariado en Fase 1;
- la semántica vigente de Gemini Live a 2026-08-26;
- el modelo actual de Durable Objects/WebSocket Hibernation de Cloudflare;
- el objetivo comercial aprobado: producto Gemini desplegable sin runtime, SDK ni credenciales OpenAI.

Este documento es un **addendum normativo**. Cuando exista conflicto con el diseño propuesto, prevalecen las enmiendas de esta revisión hasta que ambos documentos se consoliden.

No se modifica runtime productivo en esta revisión.

---

# 2. Veredicto general

La topología propuesta queda **ACEPTADA**:

```text
Telnyx
  ├─ webhook / Call Control ──► Gemini Control Plane Worker
  │                              └─ GeminiCallSession DO
  │
  └─ L16 Media Streaming ─────► Gemini Media Edge
                                  └─ Gemini Live

Gemini Worker + Gemini Media Edge ──► Supabase compartido por contratos
```

Se mantienen como decisiones firmes:

1. Worker Gemini físicamente separado del Worker OpenAI.
2. `GeminiCallSession` nuevo por composición; no herencia V2→V54.
3. Gemini Media Edge conserva audio continuo y WebSocket Gemini Live.
4. ToolGateway/dominio/Supabase permanecen compartibles por contrato.
5. No existe selector OPENAI/GEMINI dentro del runtime Gemini.
6. No existe failover OpenAI durante una llamada Gemini.
7. Una sola identidad vocal por sesión Gemini.
8. No se copia `realtime-provider-runtime.ts` al producto Gemini.
9. No se copia el sideband actual como arquitectura final.
10. Function calling se completa devolviendo el resultado al mismo tool call y manteniendo la sesión Live cuando el estado es confiable.

---

# 3. Enmienda E1 — estado del Durable Object debe sobrevivir hibernación

Cloudflare permite que el `GeminiCallSession` actúe como servidor WebSocket hibernatable. Durante hibernación el WebSocket puede permanecer conectado, pero **el estado en memoria del DO se pierde y el constructor vuelve a ejecutarse**.

Por tanto, el diseño no puede depender de Maps/sets/owners exclusivamente en memoria para recuperar una sesión después de hibernación.

## Estado que debe persistirse o poder reconstruirse

Como mínimo:

```text
call_session_id
call_control_id
tenant_id
contract_version
lifecycle_state
last_edge_sequence_accepted
last_worker_sequence_emitted
active_turn_id
active_generation_id
pending_tool_call identities
business conversation state reference
terminal flag / terminal reason
```

No implica escribir a storage cada frame ni cada evento acústico. Se persisten únicamente **fronteras de control** necesarias para recuperar ownership e idempotencia.

El attachment del WebSocket debe contener sólo metadata bounded suficiente para reenlazar la conexión; estado que deba sobrevivir a la vida del socket debe estar en DO storage/Supabase según su naturaleza.

**Regla:** el nuevo runtime debe poder reconstruir su autoridad tras reinicialización del DO sin depender de memoria perdida.

---

# 4. Enmienda E2 — session resumption NO es rollback de seguridad

`SessionResumptionUpdate`/session handles de Gemini sirven para reanudar una sesión previa. No existe evidencia contractual para tratarlos como snapshots transaccionales por turno ni para eliminar selectivamente contenido ya enviado al modelo.

Por ello:

> **Nunca usar session resumption como mecanismo para deshacer un caller turn rechazado.**

## Problema

El diseño de baja latencia propone:

```text
caller audio ──► Gemini Live inmediatamente
             └─► STT/security en paralelo
```

Esto es correcto para latencia, pero significa que Gemini puede haber incorporado el turno a su contexto antes de que el Control Plane emita `TURN_AUTHORIZED` o `TURN_REJECTED`.

Bloquear tools y no reproducir output evita efectos externos, pero **no elimina automáticamente el contenido rechazado del contexto Live**.

## Política obligatoria

### Rechazo de seguridad terminal

Cuando la política de seguridad exige finalizar la llamada:

```text
TURN_REJECTED
→ descartar output quarantined
→ no ejecutar tools
→ terminar media/provider
→ hangup controlado
```

No se continúa la conversación en esa sesión contaminada.

### Rechazo no terminal que permita continuar

Si en el futuro existe una política que rechaza el turno pero permite seguir hablando:

```text
NO continuar sobre el mismo contexto Live por defecto.
```

Se debe crear una **nueva sesión Gemini limpia**, reconstruida únicamente desde:

- system instruction autorizada;
- configuración tenant autorizada;
- catálogo de tools permitido;
- resumen/estado empresarial confiable previo al turno rechazado;
- datos explícitamente aprobados para reinyectar.

No se reinyecta el caller turn rechazado.

Session resumption sólo puede usarse si se demuestra contractualmente que el handle corresponde a un punto confiable previo al contenido rechazado; no se asumirá esa granularidad.

---

# 5. Enmienda E3 — output quarantine protege efectos, no contexto

El `output quarantine` sigue aprobado como mecanismo de baja latencia:

- audio Gemini puede procesarse/generarse mientras STT/security termina;
- PCM no autorizado no se reproduce;
- tool calls no autorizados no se ejecutan;
- buffers son bounded y fail-closed.

Pero su propiedad queda definida con precisión:

> **Quarantine impide efectos y audio audible antes de autorización; no constituye aislamiento de contexto del modelo.**

Por ello E2 forma parte inseparable del diseño.

D3 debe medir además:

- tiempo `activityEnd → TURN_AUTHORIZED` p50/p95;
- bytes PCM acumulados durante gate p50/p95/max;
- porcentaje de turnos donde Gemini empieza output antes del gate;
- frecuencia de tool call antes del gate;
- coste de reset limpio en rechazo no terminal.

---

# 6. Enmienda E4 — control speech con semántica Gemini 3.1 vigente

Para `gemini-3.1-flash-live-preview`, la documentación vigente limita `sendClientContent` al seeding de historial inicial cuando se habilita `initialHistoryInClientContent`. Después del primer turno del modelo, el texto durante conversación se envía mediante realtime input.

Por tanto, D2 debe probar explícitamente el mecanismo equivalente a:

```text
sendRealtimeInput({ text: CONTROL_DIRECTIVE })
```

No se diseñará `START_CONTROL_TURN` suponiendo que `sendClientContent` esté disponible durante toda la sesión.

## Requisitos de un control turn

El `CONTROL_DIRECTIVE`:

- nace del sistema, no del caller;
- tiene `control_turn_id` propio;
- nunca se registra como transcript/evidencia del caller;
- no modifica estado empresarial por sí mismo;
- no puede autorizar tools;
- cualquier tool call producido durante un control turn se rechaza fail-closed;
- su audio se correlaciona con una generation/control identity;
- usa la misma voz nativa Gemini Live.

Casos iniciales:

```text
GREETING
PRESENCE
RECOVERY
HANDOFF_ANNOUNCEMENT
TERMINAL_MESSAGE
```

## Gate D2

Antes de declarar implementado single-voice se debe demostrar:

1. generación de audio con la voz Live configurada;
2. ausencia de tool side-effects;
3. no confusión con caller turn;
4. correlación estable de inicio/fin;
5. siguiente caller turn natural;
6. no degradación por acumular control directives en contexto.

Si el mecanismo no cumple, no se reintroduce Google TTS silenciosamente. Se abre una decisión específica de voz única.

---

# 7. Enmienda E5 — FunctionResponse same-session permanece como ruta normal

El flujo normal aprobado es:

```text
Gemini tool call
→ hold/correlation
→ GeminiCallSession
→ ToolGateway
→ business/Supabase
→ structured result
→ mismo tool_call_id
→ FunctionResponse
→ continuación Gemini en la misma sesión
```

Esta es la ruta normal para:

- datos faltantes;
- disponibilidad;
- fuera de horario;
- alternativas;
- confirmación;
- BOOKED/FAILED/etc.

Se elimina del nuevo camino:

- provider rotation después de cada tool;
- bootstrap de continuación por reconnect;
- `DEFAULT_RESPONSE` heredado de OpenAI;
- `G3/G4` como compatibilidad del runtime híbrido.

Una reconexión sólo se justifica por lifecycle real del proveedor, fallo, GoAway, política de seguridad o recuperación explícita.

---

# 8. Enmienda E6 — separación entre continuidad y recuperación

Se definen dos conceptos diferentes:

## Continuidad normal

```text
misma sesión Live
+ FunctionResponse
+ turn/generation lifecycle nativo
```

## Recuperación de conexión

```text
socket failure / GoAway / lifetime
→ session resumption cuando sea apropiado
```

## Recuperación de confianza

```text
contexto potencialmente no confiable
→ sesión Live nueva
→ reconstrucción desde estado confiable
```

No mezclar estas tres operaciones en una sola función `reconnect()`.

---

# 9. Enmienda E7 — duración de sesión y reconnect deben formar parte del E2E

La documentación vigente indica límite de sesión audio-only y mecanismos de administración para extender conversaciones mediante reconexión/resumption.

Por ello el E2E Gemini debe incluir una prueba acelerada/sintética de:

- recepción y almacenamiento seguro de session-resumption update;
- GoAway;
- reconnect/resume;
- preservación de tool/business ownership;
- ausencia de audio duplicado;
- ausencia de tool reexecution;
- continuación de turn ids locales después de cambiar la conexión física.

La sesión lógica de llamada y la conexión Live no comparten identidad 1:1.

---

# 10. Enmienda E8 — contrato Worker↔Edge: ACK explícito para efectos

Además de `sequence` y `command_id`, los comandos con efecto deben tener ACK/NACK correlacionado cuando la acción no sea puramente local al DO.

Ejemplo conceptual:

```text
Worker → Edge
TOOL_RESULT { command_id, tool_call_id, ... }

Edge → Worker
COMMAND_APPLIED { command_id, effect = FUNCTION_RESPONSE_SENT }
```

Lo mismo aplica, según corresponda, a:

- CLEAR_PLAYBACK;
- SET_PROTECTED_INPUT;
- START_CONTROL_TURN;
- TERMINATE_MEDIA.

Un reconnect no puede inferir por silencio si un efecto fue aplicado. La reconciliación usa `command_id`, sequence y último ACK conocido.

No se requiere ACK por cada frame/evento informativo.

---

# 11. Enmienda E9 — tool authorization y rechazo

Un tool call observado desde Gemini no equivale a ejecución autorizada.

El `GeminiCallSession` debe aplicar en orden:

```text
call/turn ownership
→ tool catalog membership
→ tenant allowlist/capability
→ argument schema validation
→ caller security state
→ business-state invariant
→ explicit confirmation si aplica
→ ToolGateway execution
```

Si una tool se rechaza pero la llamada puede continuar, el modelo recibe un resultado estructurado de denegación únicamente cuando sea seguro hacerlo. Nunca se inventa éxito ni se ejecuta una alternativa implícita.

Los efectos backend se deduplican por identidad empresarial/idempotency key independiente del WebSocket command id.

---

# 12. Enmienda E10 — single voice es criterio de arquitectura, no cosmética

Se mantiene la decisión:

```text
una llamada Gemini = una identidad vocal audible
```

Google Text-to-Speech deja de ser fallback invisible del producto Gemini.

Si Gemini Live no puede producir de forma fiable alguno de los mensajes system-owned, ese caso bloquea la declaración de single-voice y requiere decisión explícita. No se acepta volver a dos voces para cerrar rápidamente un bug.

---

# 13. Enmienda E11 — Media Edge reducido pero no "tonto"

El Edge conservará responsabilidades que necesitan proximidad al audio/proveedor:

```text
Telnyx media socket
Gemini Live socket
PCM/resampling
bounded frame reorder
VAD/manual activity boundaries
playback/mark/clear
output quarantine
provider lifecycle/resumption
wire validation
bounded local diagnostics
```

Se retiran del Edge como autoridad final:

```text
business decisions
reservations
Supabase business writes
ToolGateway authorization
provider selection
isolated semantic classifier por defecto
Google TTS productivo
```

El objetivo es eliminar un segundo Control Plane, no mover arbitrariamente todo estado al Worker.

---

# 14. Enmienda E12 — shared packages no leen env ni conocen producto

Todo componente extraído como shared debe cumplir:

```text
no OpenAI/Gemini SDK
no provider wire
no host.env directo
no WebSocket ownership
config/dependencies inyectadas
business identity e idempotency explícitas
```

Los productos pueden compartir implementación de dominio; no comparten obligatoriamente lifecycle conversacional.

---

# 15. Probes/benchmarks actualizados de Fase 2/3

## D1 — transcript authority

Comparar:

- Google STT batch actual;
- Gemini input transcription;
- alternativa streaming si aplica.

No sólo WER: medir también latencia y evidencia de finalización/ordering.

## D2 — control speech Gemini-native

Probar `sendRealtimeInput({text})`/mecanismo vigente y requisitos de E4.

## D3 — authorization/output quarantine

Medir latencia, memoria, output temprano y política E2/E3.

## D4 — DO↔Edge WebSocket

Probar:

- Hibernation API del DO;
- restauración de state después de constructor nuevo;
- sequence;
- command idempotency;
- ACK/NACK;
- reconnect;
- duplicación/pérdida;
- latencia p50/p95;
- ausencia de sticky poison.

## D5 — rejected-turn trust recovery (NUEVO)

Probar:

1. caller turn llega a Gemini antes de autorización;
2. security lo rechaza;
3. output/tools no producen efectos;
4. si es terminal, se cierra sin continuar contexto;
5. si se habilita una política no terminal, se crea sesión limpia desde estado confiable;
6. ningún dato rechazado reaparece en prompt/history reconstruido.

---

# 16. Orden de implementación revisado

1. crear skeleton `apps/gemini-control-plane` sin tráfico;
2. crear contrato Edge↔DO v1 y tests puros;
3. implementar almacenamiento mínimo de ownership/idempotencia del DO compatible con hibernación;
4. implementar admission Telnyx/Gemini sin número productivo;
5. adaptar Media Edge al contrato v1 detrás de camino no productivo;
6. implementar tool call → ToolGateway → FunctionResponse same-session;
7. implementar/quarantinar output previo a autorización;
8. implementar política de rejected-turn trust recovery;
9. ejecutar D2 y fijar single-voice control turns;
10. ejecutar D1 y decidir transcript authority final/baseline;
11. ejecutar D3/D4/D5;
12. E2E sintético completo;
13. canary Gemini manual sólo cuando el SHA desplegado y E2E estén verificados;
14. retirar camino Gemini híbrido sólo después del canary exitoso;
15. iniciar Fase 4 de limpieza/optimización OpenAI.

---

# 17. Criterio de salida actualizado de Fase 2

Fase 2 queda lista para construcción cuando estén documentados y aceptados:

- [x] dos Workers/productos independientes;
- [x] topología Gemini Worker + DO + Media Edge + Live;
- [x] ownership Worker/DO/Edge;
- [x] contrato lógico Worker↔Edge;
- [x] tool flow same-session;
- [x] single-voice como requisito;
- [x] VAD/manual activity baseline;
- [x] session resumption como recuperación, no rollback;
- [x] política de contexto para turnos rechazados;
- [x] DO hibernation/state recovery requirement;
- [x] shared-domain dependency injection;
- [x] no dependencia OpenAI;
- [ ] D2 control speech tiene mecanismo exacto probado;
- [ ] límites/ACK concretos del contrato v1 fijados por tests;
- [ ] plan ejecutable de skeleton/commits convertido en primera tarea de Fase 3.

Hasta cerrar los tres puntos pendientes, se permite crear probes/tests de arquitectura, pero no habilitar tráfico productivo del nuevo camino.

---

# 18. Siguiente acción exacta

Crear el **contrato v1 Worker↔Media Edge como especificación/test-first**, incluyendo:

```text
message envelope
contract_version
call_session_id
sequence
command_id
turn_id
generation_id
tool_call_id
ACK/NACK
reconnect/replay rules
```

y, en paralelo, un probe aislado D2 para validar control speech con la API Gemini Live vigente.
