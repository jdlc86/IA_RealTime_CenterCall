# IA_RealTime_CenterCall — estado operativo

> Snapshot: 2026-08-23
> Para continuar: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md)

Los datos de GitHub y Cloudflare deben verificarse de nuevo al comenzar otra sesión. Este archivo distingue siempre implementación, CI, despliegue y E2E.

## Baseline actual

```text
rama                 rebuild/v39-stable-baseline
PR                    #85, OPEN / DRAFT / MERGEABLE
HEAD G2 session edge   a51c599b44044d54d48bde356816ee62237a5e9d
CI                    Control Plane CI #914 — SUCCESS
realtime baseline      gpt-realtime + marin
```

El HEAD documental será posterior a `a51c599b`; nunca uses este snapshot como sustituto de `git log`, PR/CI o estado efectivo de Cloudflare.

La versión productiva exacta y su porcentaje de tráfico deben verificarse antes de declarar un deploy actual. Gemini permanece deshabilitado para tráfico y no se despliega como provider activo durante G2.

## Estado por preocupación

| Área | Implementado | CI | Producción | E2E / evidencia pendiente |
|---|---:|---:|---:|---|
| Fronteras provider-neutral y saneamiento cross-generation | ✅ | ✅ | ✅ | mantener guards al incorporar Gemini |
| Conversación natural, presencia y cierre | ✅ | ✅ | ✅ | seguir revisando llamadas anómalas por trazas |
| Reservas, fechas, alternativas y concurrencia en commit | ✅ | ✅ | ✅ | repetir escenarios de voz tras cambios relacionados |
| Necesidades especiales y handoff inclusivo | ✅ | ✅ | ✅ | validación periódica de lenguaje/caso real |
| Seguridad semántica y sanciones durables | ✅ | ✅ | ✅ | pruebas adversariales periódicas |
| Diagnóstico técnico mínimo, redactado y de retención corta | ✅ | ✅ | ✅ | extender diagnóstico neutral a Gemini sin wire crudo |
| Saludo protegido frente a voz/ruido | ✅ | ✅ | ✅ | exigir paridad de invariante a Gemini |
| ResponseCoordinator: autorización pendiente one-shot | ✅ | ✅ (#871) | por verificar versión efectiva | repetir E2E de barge-in/tool sin bucle |
| OpenAI realtime | ✅ | ✅ | baseline activo | `gpt-realtime + marin` |
| Gemini G1: catálogo/tenant/binding/aislamiento | ✅ | ✅ (#888) | ❌ tráfico deshabilitado | cerrado |
| Gemini G2: setup + session owner + tool correlation | 🟢 base stateful implementada | ✅ (#914) | ❌ | falta semantic-decision strategy + transcript/media evidence |
| Gemini Live media/voz | ❌ | — | ❌ | G3/G4 pendientes |

## Decisión: OpenAI + Gemini Live por tenant

El producto soportará dos realtime providers seleccionables por tenant mediante `TenantConfiguration.realtime.provider`: `OPENAI` conserva el edge OpenAI actual y `GEMINI` tendrá un edge Gemini Live independiente. La selección se resuelve durante bootstrap/tenant binding y queda fijada durante toda la llamada.

El core compartido sigue siendo autoridad de negocio y lifecycle. No habrá mezcla de sockets, eventos, buffers, SDK types ni estado entre providers, ni failover OpenAI↔Gemini a mitad de llamada en esta primera integración.

### G1 completado

- `OPENAI` y `GEMINI` forman el catálogo neutral de providers registrados.
- Solo `OPENAI` está habilitado para tráfico; seleccionar `GEMINI` falla cerrado y nunca cae silenciosamente en OpenAI.
- Los tenants existentes sin `realtime.provider` conservan `OPENAI` como default; el override KV conserva precedencia.
- El binding por host/llamada es inmutable.
- `CallSession V31–V54` tiene guard estructural contra branches literales `GEMINI`.

### G2 — estado actual

La auditoría contra el protocolo Live real eliminó equivalencias falsas antes de conectar tráfico:

- `setup` se envía una sola vez y requiere `setupComplete`; no se usa como falso `session.update`.
- `speak`, decisiones aisladas y continuaciones no se simulan con `realtimeInput.text`.
- los chunks de transcripción no se promocionan a `*_TRANSCRIPT_COMPLETED` sin evidencia de boundary;
- function responses preservan `id` + nombre y fallan cerradas sin identidad;
- `generationComplete`, `turnComplete`, `interrupted` y `toolCallCancellation` se gobiernan ahora mediante un owner stateful de borde.

Se añadió `GeminiLiveSessionOwner` con estados `NEW → SETUP_SENT → READY → GENERATING/TOOL_WAIT/INTERRUPTED → READY/CLOSED`. El owner genera `responseId` neutrales estables, no libera una respuesta mientras haya tool calls pendientes y expone cancelaciones como evidencia sin convertirlas en rollback de negocio.

`GeminiLiveSessionRuntime` compone setup, owner, event adapter y command adapter como una única autoridad de edge. Un FunctionResponse stale/cancelado se rechaza antes del wire. Si el envío de un FunctionResponse falla, el tool call permanece pendiente; el estado solo avanza después de un write exitoso. CI #914 valida esta composición junto con el resto de la suite y los dry-runs de Wrangler.

Las capabilities Gemini permanecen en `false`: implementar el owner no equivale aún a demostrar paridad productiva. En particular siguen pendientes decisión semántica aislada, transcript boundary, media/playback evidence, VAD/barge-in y cierre/handoff de voz.

## Plan Gemini Live por gates

1. **G1 — contrato y selección: COMPLETO.** Catálogo, tenant selection, override, binding inmutable, capabilities conservadoras y fail-closed.
2. **G2 — conformance de sesión/eventos/tools: AVANZADO, NO CERRADO.** Setup y session owner stateful están implementados. Falta resolver `isolatedTextDecision` sin contaminar Live y definir transcript completion solo con evidencia real.
3. **G3 — media:** diseñar/implementar el media path Gemini necesario para Telnyx, con benchmark de codec/resampling, latencia, backpressure y playback evidence. ADR obligatorio antes de ampliar media plane.
4. **G4 — invariantes de voz:** saludo protegido, VAD/input detection, barge-in, one-shot response authorization, tools, silencio, cierre, handoff y liveness.
5. **G5 — tenant canary:** habilitar Gemini solo para un tenant de prueba; OpenAI continúa seleccionable para cualquier otro tenant.

## Siguiente validación

Continuar G2 antes de G3:

1. definir una `SemanticDecisionCapability` para el bundle Gemini que permita decisiones aisladas sin convertir autoridad del sistema en input del caller;
2. mantener `dynamicSessionPolicy=false` mientras no exista una semántica Gemini demostrada equivalente al gate requerido por el core;
3. diseñar el boundary de transcripción usando futura evidencia de actividad/media; no usar timers ni orden de llegada;
4. conectar `toolCallCancellation` a una política neutral de cancelación de trabajo pendiente, separada de cualquier rollback de operaciones ya committed;
5. crear tests de conformance compartidos OpenAI/Gemini para los invariantes que sí puedan expresarse de forma neutral;
6. mantener `GEMINI` fuera de `ENABLED_REALTIME_PROVIDERS` hasta completar G2/G3/G4.

## Restricciones vigentes

- No añadir `CallSession` V55+ ni reactivar V47/V52.
- No implementar Gemini mediante branches dispersos en dominio/lifecycle.
- No compartir sockets, buffers, wire events o estado privado OpenAI↔Gemini.
- No cambiar el media path OpenAI para acomodar Gemini si puede mantenerse aislado.
- No habilitar tráfico Gemini antes de completar los gates correspondientes.
- No implementar failover de provider a mitad de llamada en esta fase.
- No añadir timers/sleeps para emular ordering; usar identidad y evidencia.
- No tratar una feature anunciada por el vendor como capability validada del producto.
- No confundir implementación, CI, deploy y E2E.

Historial detallado: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md), [`SESSION_HANDOFF_PROMPT_2026-08-22.md`](./SESSION_HANDOFF_PROMPT_2026-08-22.md) y [`DEVELOPMENT_LOG.md`](./DEVELOPMENT_LOG.md).