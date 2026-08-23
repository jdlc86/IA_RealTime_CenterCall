# IA_RealTime_CenterCall — estado operativo

> Snapshot: 2026-08-23
> Para continuar: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md)

Los datos de GitHub y Cloudflare deben verificarse de nuevo al comenzar otra sesión. Este archivo distingue siempre implementación, CI, despliegue y E2E.

## Baseline actual

```text
rama              rebuild/v39-stable-baseline
PR                 #85, OPEN / DRAFT / MERGEABLE
HEAD G1 código      f85e3e70433457ca807e7a128bbc4088c384aa02
CI                 Control Plane CI #888 — SUCCESS
realtime baseline   gpt-realtime + marin
```

El HEAD documental será posterior a `f85e3e70`; nunca uses este snapshot como sustituto de `git log`, PR/CI o estado efectivo de Cloudflare.

La versión productiva exacta y su porcentaje de tráfico deben verificarse antes de declarar un deploy actual. Gemini permanece deshabilitado para tráfico; G1 no autoriza por sí solo un media path Gemini.

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
| Gemini G1: catálogo/tenant/binding/aislamiento | ✅ | ✅ (#888) | ❌ tráfico deshabilitado | G2 text/tools antes de habilitar |
| Gemini Live media/voz | ❌ | — | ❌ | G3/G4 pendientes |

## Decisión: OpenAI + Gemini Live por tenant

El producto soportará dos realtime providers seleccionables por tenant mediante:

```text
TenantConfiguration.realtime.provider
  ├─ OPENAI → OpenAI realtime adapter/media path
  └─ GEMINI → Gemini Live adapter/media path
```

La selección se resuelve durante bootstrap/tenant binding y queda fijada durante toda la llamada. No habrá mezcla de sockets, eventos, buffers, SDK types ni estado entre providers, y no habrá failover entre OpenAI y Gemini a mitad de llamada en la primera integración.

El core compartido sigue siendo autoridad de negocio y lifecycle:

```text
Tenant/Domain/Tools/Security
          ↓
TurnOwnership + ResponseCoordinator + ConversationLifecycle
          ↓
provider-neutral realtime ports
        ↙       ↘
 OpenAI edge   Gemini edge
```

OpenAI debe permanecer funcional y sin cambios semánticos mientras se incorpora Gemini. Las diferencias de Gemini Live —wire protocol, audio, VAD, interruption, tool calls, identidades o transporte— se absorben en adapters de borde.

### G1 completado

- `OPENAI` y `GEMINI` forman el catálogo neutral de providers registrados.
- Solo `OPENAI` está habilitado para tráfico; seleccionar `GEMINI` falla cerrado con 503 en composición y nunca cae silenciosamente en OpenAI.
- Los tenants existentes sin `realtime.provider` conservan `OPENAI` como default.
- `realtime.provider` acepta `OPENAI | GEMINI`; el override operacional KV conserva precedencia sobre la configuración del tenant.
- El binding por host/llamada es inmutable incluso antes de crear el command runtime.
- Las capacidades Gemini están declaradas conservadoramente como no implementadas/no validadas en G1; registrar el provider no implica paridad funcional.
- `CallSession V31–V54` tiene guard estructural contra branches literales `GEMINI`; la selección vive en composición, no en dominio/lifecycle.
- El wire/event adapter sigue siendo OpenAI-only mientras Gemini no está habilitado; G2 debe resolver esa frontera antes de cualquier tráfico Gemini.

## Plan Gemini Live por gates

1. **G1 — contrato y selección: COMPLETO.** Catálogo, `TenantConfiguration.realtime.provider`, override, binding inmutable, capabilities conservadoras, fail-closed y guard estructural; CI #888 verde.
2. **G2 — conformance text/tools: EN CURSO.** Implementar adapter Gemini para sesión, eventos, comandos y function calling usando contratos neutrales; tests compartidos con OpenAI. No habilitar tráfico.
3. **G3 — media:** diseñar/implementar el media path Gemini necesario para Telnyx, con benchmark de codec/resampling, latencia, backpressure y playback evidence. ADR obligatorio antes de ampliar media plane.
4. **G4 — invariantes de voz:** saludo protegido, VAD/input detection, barge-in, one-shot response authorization, tools, silencio, cierre, handoff y liveness.
5. **G5 — tenant canary:** habilitar Gemini solo para un tenant de prueba; OpenAI continúa seleccionable para cualquier otro tenant. Solo después ampliar disponibilidad.

Criterio de aislamiento: un fallo, desconexión o peculiaridad de Gemini no debe modificar el runtime OpenAI de otra llamada. Cada llamada posee un único provider binding inmutable.

## Incidentes recientes que deben permanecer corregidos

- Protección del saludo: durante habla protegida se suspende input detection, se descarta audio solapado y solo playback realmente detenido libera el turno.
- `ResponseCoordinator`: `callerResponsePending` es autorización one-shot; una respuesta liberada no puede autoencadenar respuestas indefinidamente.
- La prueba con `gpt-realtime-2.1-mini` mostró compatibilidad funcional pero calidad de voz no preferida; se restauró el baseline `gpt-realtime + marin`. Esto no cambia el diseño multi-provider.

## Siguiente validación

Continuar Gate G2 sin habilitar tráfico Gemini:

1. definir traducción Gemini Live para los comandos neutrales sin copiar conceptos wire de OpenAI;
2. adaptar `toolCall.functionCalls`/tool responses al contrato `SEMANTIC_TOOL_SELECTED` y `RealtimeToolResultRequest` preservando `id`;
3. mapear transcripción, turn completion e interruption teniendo en cuenta que Gemini no garantiza orden entre transcripciones y `serverContent`;
4. demostrar con tests de conformance compartidos que una misma intención neutral produce semántica equivalente en ambos adapters;
5. mantener Gemini fuera de `ENABLED_REALTIME_PROVIDERS` hasta completar G2 y antes de cualquier trabajo de media G3;
6. no modelar `response.create`, `response_id` o eventos OpenAI como si fueran primitives de Gemini; generar identidades neutrales donde sea necesario.

## Restricciones vigentes

- No añadir `CallSession` V55+ ni reactivar V47/V52.
- No implementar Gemini mediante `if provider === GEMINI` dispersos en dominio/lifecycle.
- No compartir sockets, buffers, wire events o estado privado OpenAI↔Gemini.
- No cambiar el media path de OpenAI para acomodar Gemini si puede mantenerse aislado.
- No habilitar tráfico Gemini antes de completar los gates correspondientes.
- No implementar failover de provider a mitad de llamada en esta fase.
- No añadir timers/sleeps para emular ordering; usar identidad y evidencia.
- No confundir implementación, CI, deploy y E2E.

Historial detallado: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md), [`SESSION_HANDOFF_PROMPT_2026-08-22.md`](./SESSION_HANDOFF_PROMPT_2026-08-22.md) y [`DEVELOPMENT_LOG.md`](./DEVELOPMENT_LOG.md).
