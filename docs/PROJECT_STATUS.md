# IA_RealTime_CenterCall — estado operativo

> Snapshot: 2026-08-23
> Para continuar: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md)

Los datos de GitHub y Cloudflare deben verificarse de nuevo al comenzar otra sesión. Este archivo distingue siempre implementación, CI, despliegue y E2E.

## Baseline actual

```text
rama                rebuild/v39-stable-baseline
PR                   #85, OPEN / DRAFT / MERGEABLE
HEAD G2 audit código  23d642f1fa8184943ba643f666c0e3148e26d3a3
CI                   Control Plane CI #900 — SUCCESS
realtime baseline     gpt-realtime + marin
```

El HEAD documental será posterior a `23d642f1`; nunca uses este snapshot como sustituto de `git log`, PR/CI o estado efectivo de Cloudflare.

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
| Gemini G2: protocolo text/tools y capabilities | 🟡 endurecido, no completo | ✅ (#900) | ❌ | falta session owner + lifecycle + semantic decision strategy |
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

### Auditoría exhaustiva G2

La primera implementación sintética G2 pasó compilación, pero la revisión contra el protocolo Live real detectó equivalencias incorrectas que ya fueron eliminadas antes de conectar tráfico:

- `setup` no puede reutilizarse como equivalente de `session.update`: Gemini Live configura la sesión una vez al inicio y requiere esperar `setupComplete`.
- `speak`, decisiones aisladas y continuaciones no pueden simularse enviando `realtimeInput.text`, porque eso representa input del usuario y alteraría turn ownership/contexto.
- La transcripción Gemini no aporta un flag `finished` equivalente al supuesto inicialmente; los chunks no se promocionan a `*_TRANSCRIPT_COMPLETED` hasta disponer de correlación stateful real.
- `generationComplete`, `turnComplete`, `interrupted` y `toolCallCancellation` permanecen como evidencia del edge hasta que un owner Gemini pueda traducirlos sin inventar identidades ni ordering.
- El mapeo de function response por `id` + nombre se mantiene como operación G2 demostrada.
- La matriz de capabilities ahora distingue además `governedSpeech`, `isolatedTextDecision`, `dynamicSessionPolicy`, `correlatedResponseLifecycle` y `toolCallCancellation`. Gemini conserva todas las capabilities en `false` hasta demostrar cada gate.

El resultado de esta auditoría es intencionalmente conservador: G2 todavía NO está cerrado aunque CI esté verde. `CI verde` aquí significa que las fronteras fallan cerradas y no degradan OpenAI, no que Gemini esté listo para producción.

## Plan Gemini Live por gates

1. **G1 — contrato y selección: COMPLETO.** Catálogo, tenant selection, override, binding inmutable, capabilities conservadoras y fail-closed.
2. **G2 — conformance de sesión/eventos/tools: EN CURSO.** Construir un session owner Gemini que envíe setup una vez, espere `setupComplete`, preserve tool identities y traduzca lifecycle/transcripción mediante evidencia real. Resolver la capacidad de decisión semántica aislada sin contaminar la conversación Live.
3. **G3 — media:** diseñar/implementar el media path Gemini necesario para Telnyx, con benchmark de codec/resampling, latencia, backpressure y playback evidence. ADR obligatorio antes de ampliar media plane.
4. **G4 — invariantes de voz:** saludo protegido, VAD/input detection, barge-in, one-shot response authorization, tools, silencio, cierre, handoff y liveness.
5. **G5 — tenant canary:** habilitar Gemini solo para un tenant de prueba; OpenAI continúa seleccionable para cualquier otro tenant.

## Siguiente validación

Continuar G2 antes de G3:

1. crear un owner de sesión Gemini de borde: `setup → setupComplete → runtime`, sin segunda configuración;
2. definir cómo se obtiene `isolatedTextDecision` para el bundle Gemini sin inyectarla como caller input; si Live no ofrece la semántica requerida, componer una capacidad de decisión separada;
3. modelar lifecycle Gemini (`generationComplete`, `turnComplete`, `interrupted`) con identidades neutrales propias y correlación por evento, no tiempo;
4. diseñar tratamiento de `toolCallCancellation`: nunca deshacer una mutación ya confirmada por backend; cancelar solo trabajo aún no comprometido cuando exista ownership demostrable;
5. establecer estrategia de transcripción stateful y ordering antes de emitir `CALLER_TRANSCRIPT_COMPLETED` o `ASSISTANT_TRANSCRIPT_COMPLETED`;
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