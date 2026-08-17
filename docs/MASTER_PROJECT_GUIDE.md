# IA_RealTime_CenterCall — MASTER PROJECT GUIDE

> **Path estable de compatibilidad. NO RENOMBRAR NI ELIMINAR.**

Este archivo es la puerta de entrada permanente a la documentación del proyecto.

## Continuación operativa más reciente

Para continuar el trabajo técnico desde el estado del **17 de agosto de 2026**, leer primero:

- [`docs/SESSION_HANDOFF_2026-08-17.md`](./SESSION_HANDOFF_2026-08-17.md)
- [`docs/PROJECT_STATUS.md`](./PROJECT_STATUS.md)

El handoff de sesión contiene:

- rama y SHA actuales;
- estado CI/despliegue/E2E;
- reconstrucción v39 → v40 → v41 → v42;
- metodología obligatoria de diagnóstico antes de modificar código;
- conectores GitHub, Supabase y entorno Cloudflare;
- `project_id` de Supabase y tabla de diagnósticos;
- procedimiento para revisar llamadas reales;
- siguiente prueba recomendada.

## Fuentes de verdad arquitectónicas

- [`docs/architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md) — arquitectura y roadmap.
- [`docs/architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md) — reglas no negociables de implementación.
- [`docs/architecture/BUSINESS_VERTICALS.md`](./architecture/BUSINESS_VERTICALS.md) — `CLINIC | RESTAURANT`.
- [`docs/architecture/HUMAN_HANDOFF.md`](./architecture/HUMAN_HANDOFF.md) — diseño transversal de handoff humano.
- [`docs/README.md`](./README.md) — índice documental.

## Checkpoint operativo — 2026-08-17

Repositorio y rama:

```text
jdlc86/IA_RealTime_CenterCall
rebuild/v39-stable-baseline
```

Último SHA funcional con CI verde al generar este checkpoint:

```text
f69f37de06cc953d50dd18884cb7bcd2132251c3
Control Plane CI #254 — SUCCESS
```

Este SHA incorpora v42. Al generar este documento todavía faltaba confirmar **despliegue + nueva llamada E2E**.

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
v41  cierre irreversible exige evidencia del usuario
v42  fronteras de turno para presence + handoff redundante
```

### Barge-in

La arquitectura reconstruida v40 usa un único owner. VAD bruto no cancela una respuesta. Durante playback se escucha sin auto-interrumpir y la transcripción candidata se clasifica fuera de conversación como `INTERRUPT` o `IGNORE`.

Evidencia E2E positiva ya observada:

```text
BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
TURN_CONCURRENCY_BYPASSED_V36
BARGE_IN_CONFIRMED_V40_REBUILD
response_done_gate=false
```

También se validó que candidatos sin transcript utilizable pueden resolverse como `IGNORE` sin watchdog.

### Cierre de llamada

Después de detectar un hangup incorrecto posterior a `BOOKED`, v41 dejó de confiar en `restaurant_end_call {confirmed:true}` como evidencia suficiente. El backend exige despedida/confirmación originada en el último turno del usuario.

### Presence recovery

Se detectaron falsos “¿Sigues ahí?” durante conversación activa. v41 añadió guardas para playback/procesamiento y v42 elimina el rearme del deadline causado por `background_input_ignored_v29`.

### Human handoff

**El handoff humano ya está implementado y activo en el runtime.** Documentación anterior que lo marcaba como “F6 no iniciada/no activo” está obsoleta para el estado operativo actual.

v37 ejecuta el transporte determinista; v39 corrige la clasificación del resultado Telnyx (`call.answered` del target leg es la evidencia autoritativa de transferencia contestada).

En una llamada reciente se observó una transferencia injustificada justo después de `restaurant_business_info(HOURS) -> FOUND`. v42 añade una frontera conservadora: si el mismo turno ya fue resuelto por `restaurant_business_info -> FOUND` y la respuesta terminó, un handoff posterior en ese mismo turno se bloquea. Un nuevo turno del usuario vuelve a permitir handoff legítimo.

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
10. Para decisiones irreversibles (hangup, handoff, WRITE) el prompt/modelo no debe ser la única autoridad.

## Infraestructura y conectores

### GitHub

Repositorio: `jdlc86/IA_RealTime_CenterCall`.

La sesión puede usar el conector GitHub para leer/escribir archivos, inspeccionar commits y consultar GitHub Actions cuando esté disponible.

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

La disponibilidad de un conector Cloudflare con permisos reales depende de la sesión. No afirmar que un deploy fue ejecutado si la sesión no dispone de una herramienta de escritura; en ese caso el usuario confirma/despliega por su flujo habitual.

## Regla de mantenimiento

1. Este archivo no se elimina ni se renombra.
2. Arquitectura canónica: `SYSTEM_ARCHITECTURE.md`.
3. Estado operativo: `PROJECT_STATUS.md` y el handoff de sesión más reciente.
4. Una funcionalidad no es `VALIDADA E2E` solo porque exista código o CI verde.
5. No crear forks del Core por tenant; usar `businessType`, configuración, módulos y allowlists.
6. El handoff telefónico es una capacidad transversal única; los verticales pueden aportar razones/reglas, no duplicar el transporte.
