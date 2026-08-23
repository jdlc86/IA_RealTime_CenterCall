# IA_RealTime_CenterCall — estado operativo

> Snapshot: 2026-08-23
> Para continuar: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md)

Los datos de GitHub y Cloudflare deben verificarse de nuevo al comenzar otra sesión. Este archivo distingue siempre implementación, CI, despliegue y E2E.

## Baseline actual

```text
rama              rebuild/v39-stable-baseline
PR                 #85, OPEN / DRAFT / MERGEABLE
HEAD previo docs    a53197f9d920c67349f862057ca618cc4b3d68fe
CI                 Control Plane CI #873 — SUCCESS
realtime baseline   gpt-realtime + marin
```

El HEAD documental será posterior a `a53197f9`; nunca uses este snapshot como sustituto de `git log`, PR/CI o estado efectivo de Cloudflare.

La versión productiva exacta y su porcentaje de tráfico deben verificarse antes de declarar un deploy actual. La sesión confirmó CI verde para la restauración del baseline, pero este documento no inventa un UUID de producción no comprobado.

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
| Gemini Live como segundo realtime provider | 🟡 diseño/inicio | — | ❌ | implementar por gates; no tráfico hasta conformance de voz |

## Decisión nueva: OpenAI + Gemini Live por tenant

A partir de este punto el producto debe soportar dos realtime providers seleccionables por tenant:

```text
TenantConfiguration.realtime_provider
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

## Plan Gemini Live por gates

1. **G1 — contrato y selección:** auditar registry/capabilities actuales; añadir `GEMINI` sin habilitar tráfico y demostrar selección por tenant + rechazo de provider no registrado.
2. **G2 — conformance text/tools:** implementar adapter Gemini para sesión, eventos, comandos y function calling usando contratos neutrales; tests compartidos con OpenAI.
3. **G3 — media:** diseñar/implementar el media path Gemini necesario para Telnyx, con benchmark de codec/resampling, latencia, backpressure y playback evidence. ADR obligatorio antes de ampliar media plane.
4. **G4 — invariantes de voz:** saludo protegido, VAD/input detection, barge-in, one-shot response authorization, tools, silencio, cierre, handoff y liveness.
5. **G5 — tenant canary:** habilitar Gemini solo para un tenant de prueba; OpenAI continúa seleccionable para cualquier otro tenant. Solo después ampliar disponibilidad.

Criterio de aislamiento: un fallo, desconexión o peculiaridad de Gemini no debe modificar el runtime OpenAI de otra llamada. Cada llamada posee un único provider binding inmutable.

## Incidentes recientes que deben permanecer corregidos

- Protección del saludo: durante habla protegida se suspende input detection, se descarta audio solapado y solo playback realmente detenido libera el turno.
- `ResponseCoordinator`: `callerResponsePending` es autorización one-shot; una respuesta liberada no puede autoencadenar respuestas indefinidamente.
- La prueba con `gpt-realtime-2.1-mini` mostró compatibilidad funcional pero calidad de voz no preferida; se restauró el baseline `gpt-realtime + marin`. Esto no cambia el diseño multi-provider.

## Siguiente validación

Comenzar Gate G1 sin habilitar tráfico Gemini:

1. auditar el registry/capabilities realtime actuales y localizar el punto único de binding por tenant;
2. formalizar `TenantConfiguration.realtime_provider` como `OPENAI | GEMINI` sin condicionales dispersos en dominio/lifecycle;
3. registrar Gemini como provider conocido pero no seleccionable para tráfico hasta disponer de adapter/conformance;
4. añadir pruebas de selección por tenant, binding inmutable durante la llamada y rechazo de provider no registrado/no habilitado;
5. añadir guard estructural que impida referencias Gemini en capas neutrales;
6. mantener OpenAI sin cambios funcionales y ejecutar `npm run docs:check`, `npm test` y `npm run check` antes de avanzar a G2.

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
