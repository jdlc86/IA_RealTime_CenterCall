# IA_RealTime_CenterCall — MASTER PROJECT GUIDE

> **Path estable de compatibilidad. NO RENOMBRAR NI ELIMINAR.**

Este archivo es la puerta de entrada permanente a la documentación del proyecto.

## Continuación operativa más reciente

Estado actualizado al **18 de agosto de 2026**.

Para continuar el trabajo técnico leer primero:

- [`docs/PROJECT_STATUS.md`](./PROJECT_STATUS.md)
- [`docs/SESSION_HANDOFF_2026-08-17.md`](./SESSION_HANDOFF_2026-08-17.md) como contexto histórico de la reconstrucción v39+.

## Fuentes de verdad arquitectónicas

- [`docs/architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md) — arquitectura y roadmap.
- [`docs/architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md) — reglas no negociables de implementación.
- [`docs/architecture/BUSINESS_VERTICALS.md`](./architecture/BUSINESS_VERTICALS.md) — `CLINIC | RESTAURANT`.
- [`docs/architecture/HUMAN_HANDOFF.md`](./architecture/HUMAN_HANDOFF.md) — diseño transversal de handoff humano.
- [`docs/README.md`](./README.md) — índice documental.

## Checkpoint operativo — 2026-08-18

Repositorio y rama:

```text
jdlc86/IA_RealTime_CenterCall
rebuild/v39-stable-baseline
```

Checkpoint funcional previo a esta actualización documental:

```text
72b2d99003d6a6d9e4e901dd856a514f0fa84c0d
Control Plane CI #444 — SUCCESS
```

Ese checkpoint incorpora la reconstrucción contextual de cierre v41 y fue probado mediante llamadas reales con resultado correcto desde la perspectiva del usuario.

### Runtime conversacional relevante

```text
v18  user presence/watchdog
v23  herramientas directas restaurante
v29  semantic tool gate / input ignored
v35  protected speech / VAD
v36  concurrencia de turnos normales
v37  human handoff determinista
v38  lifecycle de fallo de handoff
v39  baseline estable + resultado Telnyx correcto
v40  response owner + barge-in reconstruido
v41  política contextual/semántica de cierre
v42+ fronteras y hardening incremental
v48  authoritative clock / grounding temporal Europe/Madrid
```

## Cierre de llamada — diseño vigente v41

La política de cierre ya no se modela como “Lucía solicita y un controlador veta”. Se distinguen tres situaciones semánticas.

### 1. Cierre resuelto por el propio contexto conversacional

Si Lucía acaba de formular una pregunta de continuidad como:

```text
¿Hay algo más en lo que te pueda ayudar?
¿Puedo ayudarte en algo más?
¿Necesitas alguna otra cosa?
```

y el usuario responde negativamente de forma clara:

```text
No, gracias.
No, no gracias.
Nada más.
```

la intención queda resuelta por el contexto de la conversación. No se vuelve a arbitrar ni se pregunta “¿Quieres terminar la llamada?”. Lucía se despide de forma natural y se ejecuta el hangup.

Este camino fue validado E2E el 18 de agosto de 2026.

### 2. Cierre espontáneo

Si el usuario decide terminar inesperadamente, incluso interrumpiendo a Lucía, por ejemplo:

```text
Ya, ya, hasta luego.
```

se combinan dos evaluaciones independientes:

- comprensión de Lucía;
- controlador semántico.

Si ambos detectan `CLOSE`, existe consenso fuerte: Lucía produce una despedida breve y se ejecuta el hangup sin una confirmación artificial adicional.

Este camino también fue validado E2E el 18 de agosto de 2026.

### 3. Desacuerdo real

La pregunta explícita:

```text
¿Quieres terminar la llamada?
```

queda reservada para el caso excepcional en que Lucía interpreta intención de cierre pero el controlador semántico no dispone de evidencia suficiente o discrepa. No debe ser el camino normal de finalización.

Mientras esta resolución está pendiente, `restaurant_input_ignored`, presence recovery u otras decisiones semánticas no deben apropiarse de la respuesta de confirmación.

### Cortesía e intención son dimensiones distintas

Una cortesía aislada no es cierre:

```text
Muchas gracias.
Gracias por la información.
```

Debe conducir normalmente a una pregunta natural de continuidad, no a hangup ni a una declaración artificial de ambigüedad.

En cambio una frase puede contener cortesía y cierre simultáneamente:

```text
Muchas gracias, no necesito nada más.
```

En ese caso `courtesy=true` puede coexistir con `close_intent=CLOSE`. Si Lucía y el controlador coinciden, se cierra directamente.

Una nueva intención posterior invalida un falso cierre, por ejemplo:

```text
No necesito nada más sobre la reserva, pero dime el horario.
Hasta luego... espera, una cosa más.
```

La intención final del usuario prevalece mientras el hangup irreversible no haya sido ejecutado.

### Invariantes de cierre

```text
contexto conversacional ya resuelto -> actuar directamente
cierre espontáneo + consenso       -> despedida + hangup
cierre espontáneo + desacuerdo     -> confirmar explícitamente
cortesía pura                       -> follow-up natural
nueva petición                      -> continuar
usuario cuelga físicamente          -> cleanup, sin diálogo adicional
```

No ampliar regex como mecanismo principal de comprensión. Las expresiones deterministas pueden aportar evidencia, pero el diseño debe preservar el contexto semántico y las fronteras de estado.

## Authoritative Clock — v48

El Worker aporta a Lucía un contexto temporal autoritativo en `Europe/Madrid`, actualizado durante la conversación. Incluye fecha/hora actuales y evita depender del conocimiento temporal del modelo para interpretar expresiones como “mañana”, “este domingo” o “el viernes”.

El reloj ayuda al modelo a razonar, pero no sustituye las validaciones backend. La arquitectura mantiene:

```text
AuthoritativeClock -> TemporalContext -> provider adapter -> Lucía
Lucía propone fecha -> backend valida -> operación
```

La defensa backend debe seguir rechazando fechas inválidas o incoherentes aunque el modelo se equivoque.

## Barge-in

La arquitectura reconstruida v40 usa un único owner. VAD bruto no cancela una respuesta. Durante playback se escucha sin auto-interrumpir y la transcripción candidata se clasifica fuera de conversación como `INTERRUPT` o `IGNORE`.

Evidencia E2E positiva observada:

```text
BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
TURN_CONCURRENCY_BYPASSED_V36
BARGE_IN_CONFIRMED_V40_REBUILD
response_done_gate=false
```

Los cierres espontáneos durante barge-in deben cancelar limpiamente la respuesta en curso antes de producir una única despedida y ejecutar el hangup.

## Presence recovery

Presence recovery no debe intervenir mientras existe una resolución explícita de cierre, una respuesta protegida o actividad conversacional válida. No usar “¿Sigues ahí?” para compensar errores de ownership o respuestas de confirmación que no llegaron a emitirse.

## Human handoff

El handoff humano está implementado y activo. v37 ejecuta el transporte determinista y v39 corrige la clasificación del resultado Telnyx (`call.answered` del target leg es la evidencia autoritativa de transferencia contestada).

Una petición de handoff válida constituye una nueva intención y no debe confundirse con cierre por contener expresiones negativas como “no”.

## Metodología de trabajo obligatoria

1. **No modificar código al recibir un síntoma.** Primero recuperar la llamada real de `public.call_diagnostic_events`.
2. Reconstruir cronológicamente el lifecycle y encontrar la capa que tomó la decisión errónea.
3. Distinguir causa raíz de síntoma. No asumir que fallos parecidos tienen la misma causa.
4. No apilar parches ni timers. Preferir ownership único, contratos de estado y fronteras deterministas.
5. Añadir prueba de regresión que reproduzca el incidente.
6. Exigir CI verde (`Run tests` + `Wrangler dry-run`) antes de pedir una llamada real.
7. Confirmar el SHA realmente desplegado antes de interpretar una llamada.
8. Después de la llamada, revisar diagnósticos **antes** de cambiar código.
9. Diferenciar siempre `IMPLEMENTADO`, `CI VERDE`, `DESPLEGADO` y `VALIDADO E2E`.
10. Para decisiones irreversibles (hangup, handoff, WRITE) el modelo/prompt no debe ser la única autoridad.
11. No arbitrar de nuevo una intención que el propio contexto conversacional ya haya resuelto inequívocamente.
12. La confirmación explícita debe ser una ruta excepcional de resolución de desacuerdo, no el camino normal.

## Infraestructura y conectores

### GitHub

Repositorio: `jdlc86/IA_RealTime_CenterCall`.

### Supabase

Proyecto operativo:

```text
project_id = vutekfkbtvfogouwcfvc
```

Diagnósticos E2E:

```text
public.call_diagnostic_events
```

Cloudflare Worker → Supabase está operativo. No modificar datos de negocio durante una investigación salvo instrucción explícita.

### Cloudflare

El control-plane se ejecuta en Workers. Configuración rápida por tenant usa `TENANT_CONFIG` KV. El repositorio valida con `wrangler deploy --dry-run` y despliega con `wrangler deploy`.

No afirmar que un deploy fue ejecutado si no existe evidencia o herramienta de escritura capaz de verificarlo.

## Regla de mantenimiento

1. Este archivo no se elimina ni se renombra.
2. Arquitectura canónica: `SYSTEM_ARCHITECTURE.md`.
3. Estado operativo: `PROJECT_STATUS.md` y el handoff de sesión más reciente.
4. Una funcionalidad no es `VALIDADA E2E` solo porque exista código o CI verde.
5. No crear forks del Core por tenant; usar `businessType`, configuración, módulos y allowlists.
6. El handoff telefónico es una capacidad transversal única; los verticales pueden aportar razones/reglas, no duplicar el transporte.
7. Cierre, handoff y otras acciones irreversibles deben conservar ownership y evidencia explícitos.
