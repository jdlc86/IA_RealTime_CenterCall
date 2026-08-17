# SESSION HANDOFF — 2026-08-17

> Documento operativo para continuar el trabajo en una nueva sesión de ChatGPT sin reconstruir el contexto desde cero.
>
> Repositorio: `jdlc86/IA_RealTime_CenterCall`
> Rama de trabajo: `rebuild/v39-stable-baseline`
> Tenant principal de pruebas: `restaurante-centro`
> Zona horaria de negocio: `Europe/Madrid`

## 1. Objetivo inmediato

La prioridad actual es estabilizar el runtime conversacional de Lucía preservando la funcionalidad conocida de v39, pero formalizando fronteras deterministas para acciones irreversibles y para el lifecycle de respuestas.

No se deben introducir parches locales sin reconstruir primero la causa raíz a partir de una llamada real y sus diagnósticos.

## 2. Último estado conocido

Último head con CI verde:

```text
f69f37de06cc953d50dd18884cb7bcd2132251c3
```

GitHub Actions:

```text
Control Plane CI #254 — SUCCESS
Run tests          — SUCCESS
Wrangler dry-run   — SUCCESS
```

IMPORTANTE: al cerrar la sesión que generó este documento, este SHA estaba **validado por CI pero no se había confirmado todavía su despliegue ni una llamada E2E posterior**. La siguiente sesión debe preguntar/comprobar el SHA realmente desplegado antes de interpretar una nueva llamada.

## 3. Baseline y evolución reciente

### v39 — baseline estable

`call-session-v39.ts` es la referencia funcional estable previa a la reconstrucción del barge-in. v39 no redefine cuándo debe pedirse handoff humano; hereda de v37/v38 el transporte determinista y corrige la interpretación de eventos Telnyx durante la transferencia.

Regla importante: no asumir que una conducta que “no ocurría” en v39 estaba necesariamente formalmente prohibida. En varios casos v39 se comportaba bien de facto, pero la frontera no estaba codificada.

### v40 — response owner / barge-in reconstruido

Se añadió un único owner explícito para respuestas Realtime durante interrupciones normales.

Invariantes:

- VAD bruto nunca autoriza por sí solo una interrupción semántica;
- saludo, recovery y handoff protegidos no son interruptibles;
- durante playback normal se activa escucha no interruptiva (`interrupt_response=false`, `create_response=false`);
- una transcripción candidata se clasifica fuera de conversación como `INTERRUPT` o `IGNORE`;
- `INTERRUPT` no espera `response.done` para continuar;
- `IGNORE` no entra al pipeline semántico;
- candidatos sin transcript utilizable se resuelven como `IGNORE` sin watchdog;
- v36 cede ownership cuando el item pertenece al owner v40.

Evidencia E2E ya observada:

```text
BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
TURN_CONCURRENCY_BYPASSED_V36
BARGE_IN_CONFIRMED_V40_REBUILD
response_done_gate=false
```

También se observó correctamente:

```text
BARGE_IN_UNCLASSIFIABLE_IGNORED_V40_REBUILD
resolved_without_watchdog=true
```

### v41 — guard de cierre irreversible

Problema detectado: después de una reserva `BOOKED`, el modelo llamó por iniciativa propia a `restaurant_end_call {confirmed:true}` y Lucía colgó aunque el usuario no se había despedido.

Corrección v41:

- `confirmed:true` del modelo ya no es evidencia suficiente;
- el backend exige evidencia del último turno del usuario;
- se autoriza cierre por despedida inequívoca del usuario o confirmación explícita a una pregunta de cierre pendiente;
- BOOKED, marketing o una frase cordial de Lucía no autorizan hangup.

Evidencia posterior: en la siguiente llamada `USER_CLOSING_EVIDENCE_EVALUATED_V41` permaneció con `closing_authorized=false`; no hubo cierre automático indebido.

### v42 — fronteras de turno para presence recovery y handoff

Dos problemas observados después de v41:

1. `BACKGROUND_INPUT_IGNORED` podía volver a armar el watchdog como si empezara un periodo nuevo de espera del usuario.
2. después de responder correctamente una pregunta de horario mediante `restaurant_business_info -> FOUND`, el modelo pidió `restaurant_human_assistance` y v37 inició una transferencia irreversible aunque el turno ya estaba resuelto.

Corrección v42 en `f69f37de...`:

- `background_input_ignored_v29` no rearma/resetear el deadline de presencia;
- si el turno actual ya fue resuelto de forma concluyente por `restaurant_business_info` con `FOUND` y esa respuesta terminó, un handoff posterior en **ese mismo turno** se bloquea;
- un nuevo transcript útil del usuario abre un turno nuevo y vuelve a permitir handoff legítimo;
- se añadieron tests de regresión para ambos comportamientos.

No generalizar el bloqueo a todas las tools sin nueva evidencia: la política actual es deliberadamente conservadora.

## 4. Últimas llamadas y hallazgos

### Llamada en la que se validó el nuevo barge-in

Resultado positivo:

- interrupción legítima clasificada `INTERRUPT`;
- v36 hizo bypass;
- no hubo dependencia de `response.done`;
- ruido/candidato no utilizable terminó en `IGNORE` sin bloqueo de 30 s;
- la conversación pudo continuar hasta reserva y handoff.

### Llamada que motivó v41

Problemas:

- apareció “¿Sigues ahí?” mientras la conversación seguía activa;
- después de `BOOKED` el modelo pidió `restaurant_end_call` y el sistema colgó.

Causas:

- presence recovery no distinguía suficientemente estados activos;
- `executeEndCallV23` confiaba en `confirmed:true` del propio modelo.

### Llamada que motivó v42

El usuario hizo el mismo diálogo de validación.

Observaciones:

- la reserva terminó en `BOOKED` (`R-100032` en esa ejecución);
- el cierre automático indebido ya no ocurrió;
- el usuario preguntó a qué hora cerraba;
- el modelo seleccionó correctamente `restaurant_business_info` con `topics=["HOURS"]`;
- backend devolvió `FOUND` con horario oficial;
- a continuación el modelo pidió `restaurant_human_assistance` con razón `OTHER_RESTAURANT_MATTER`;
- v37 aceptó el handoff y comenzó transferencia a Recepción;
- también se observó un `USER_PRESENCE_RECOVERY_REQUESTED` previo, después de que entradas de fondo hubieran vuelto a armar el reloj.

Conclusión: el fallo de esa llamada no era el transporte Telnyx ni el barge-in. Era autoridad insuficiente en dos fronteras: presence recovery y handoff irreversible.

## 5. Metodología de trabajo obligatoria

Esta metodología debe mantenerse en la siguiente sesión.

### 5.1 Evidencia antes que hipótesis

Ante cualquier fallo reportado por el usuario:

1. No cambiar código inmediatamente.
2. Recuperar la última llamada de `public.call_diagnostic_events` por `call_id`/timestamp.
3. Reconstruir cronológicamente el lifecycle.
4. Identificar qué capa tomó la decisión incorrecta.
5. Distinguir síntoma de causa raíz.
6. Solo después proponer/codificar la corrección.

No asumir que dos silencios, dos transferencias o dos cortes de audio tienen la misma causa.

### 5.2 No apilar parches

Regla explícita del proyecto: no solucionar regresiones añadiendo condiciones aisladas sobre condiciones anteriores.

Preferir:

- ownership explícito;
- contratos puros de estado;
- fronteras deterministas para acciones irreversibles;
- una sola autoridad por lifecycle;
- tests que reproduzcan el incidente real.

Evitar:

- timers añadidos para tapar carreras;
- waits a `response.done` como condición de progreso;
- múltiples productores independientes de `response.create/cancel`;
- prompts como único mecanismo de seguridad para hangup, handoff o mutaciones.

### 5.3 Baseline v39 como referencia, no como dogma

Cuando haya una regresión comparar contra v39, pero comprobar si v39 tenía realmente una garantía codificada o solo un comportamiento favorable de facto.

No reintroducir automáticamente código antiguo si el problema original de ese código ya fue demostrado.

### 5.4 Cambios pequeños y CI antes de llamada

Después de cada cambio:

1. añadir/actualizar test de regresión;
2. commit en `rebuild/v39-stable-baseline`;
3. comprobar GitHub Actions del SHA exacto;
4. exigir `Run tests = success` y `Wrangler dry-run = success`;
5. no pedir una llamada real mientras CI esté rojo o en curso;
6. confirmar qué SHA está desplegado antes de analizar resultados E2E.

### 5.5 Prueba telefónica controlada

Dar al usuario un diálogo reproducible. Después de la llamada, revisar la traza completa antes de cambiar nada.

Las pruebas deben mezclar, cuando proceda:

- turno normal;
- interrupción legítima mientras Lucía habla;
- ruido breve que debe ser ignorado;
- tool READ como menú/horario;
- reserva hasta confirmación;
- continuación de conversación después de BOOKED;
- cierre solo con despedida explícita;
- handoff solo cuando exista necesidad real.

### 5.6 Estados de validación

Usar siempre estas categorías:

- `IMPLEMENTADO`: existe código;
- `CI VERDE`: tests + dry-run pasan;
- `DESPLEGADO`: SHA confirmado en Worker;
- `VALIDADO E2E`: llamada real demuestra el comportamiento;
- `PENDIENTE`: falta una de las evidencias anteriores.

No usar “resuelto” como sinónimo de “hay código”.

## 6. Conectores y recursos disponibles

### GitHub

Repositorio:

```text
jdlc86/IA_RealTime_CenterCall
```

Rama actual:

```text
rebuild/v39-stable-baseline
```

El conector GitHub de ChatGPT permite en esta configuración:

- leer archivos y commits;
- comparar revisiones;
- escribir/actualizar archivos en la rama;
- consultar GitHub Actions por commit;
- revisar jobs y logs cuando están disponibles;
- hacer commits a través de las acciones de contenido.

Usar el SHA exacto para correlacionar CI y despliegue.

### Supabase

Proyecto usado por este sistema:

```text
project_id = vutekfkbtvfogouwcfvc
```

El conector Supabase está disponible para consultas SQL y gestión del proyecto cuando la sesión lo expone.

Tabla principal de observabilidad de llamadas:

```text
public.call_diagnostic_events
```

Patrón habitual para inspeccionar la llamada más reciente:

```sql
with latest as (
  select call_id, max(created_at) last_at
  from public.call_diagnostic_events
  group by call_id
  order by last_at desc
  limit 1
)
select d.created_at, d.call_id, d.stage, d.event, d.severity, d.details, d.diagnosis
from public.call_diagnostic_events d
join latest l using (call_id)
order by d.created_at asc;
```

No modificar datos de negocio durante una investigación salvo que el usuario lo solicite expresamente.

### Cloudflare

El control-plane se ejecuta en Cloudflare Workers y usa Wrangler para validación/despliegue.

El repositorio dispone de:

```text
npm run deploy:dry  -> wrangler deploy --dry-run
npm run deploy      -> wrangler deploy
```

Configuración rápida por tenant utiliza Cloudflare KV (`TENANT_CONFIG`). Variables/secretos sensibles no deben documentarse ni copiarse a chats.

Importante sobre conectores: la disponibilidad de una conexión Cloudflare con permisos de escritura **depende de la sesión**. En la sesión que generó este documento había conocimientos/skills de Cloudflare, pero no una conexión operativa de escritura que permitiera afirmar un `wrangler deploy` remoto desde ChatGPT. Por eso el usuario realizó/confirmó los despliegues manualmente. La siguiente sesión debe descubrir sus herramientas reales antes de prometer despliegue.

En conversaciones anteriores el usuario proporcionó IDs de deployment de Cloudflare para correlacionar llamadas, pero esos IDs son efímeros y no deben tratarse como identificador estable del proyecto.

### Telnyx / OpenAI Realtime

Telnyx aporta caller ID confiable y transporte telefónico/handoff. OpenAI Realtime maneja audio, VAD, responses y tool calls.

No confundir:

- `response.done` con fin de playback telefónico;
- `call.bridged` con humano ya contestando;
- VAD con intención semántica del usuario.

En handoff v39, `call.answered` del target leg es la evidencia autoritativa de transferencia contestada.

## 7. Arquitectura de ownership relevante

Capas clave actuales:

```text
v18  user presence/watchdog
v23  herramientas directas restaurante y end-call heredado
v29  semantic tool gate + input ignored
v35  protected speech / VAD lifecycle
v36  turn concurrency para turnos normales
v37  transporte determinista human handoff
v38  fallos terminales handoff
v39  clasificación correcta del resultado Telnyx; baseline
v40  response owner + barge-in reconstruido
v41  autorización de cierre basada en evidencia del usuario
v42  fronteras de turno: background no rearma presence + handoff redundante bloqueado
```

Principio: una capa posterior puede restringir una acción irreversible heredada, pero no debe duplicar su transporte/lifecycle.

## 8. Archivos importantes

```text
docs/MASTER_PROJECT_GUIDE.md
docs/PROJECT_STATUS.md
docs/architecture/SYSTEM_ARCHITECTURE.md
docs/architecture/DESIGN_RULES.md
apps/control-plane/src/call-session-v29.ts
apps/control-plane/src/call-session-v36.ts
apps/control-plane/src/call-session-v37.ts
apps/control-plane/src/call-session-v39.ts
apps/control-plane/src/call-session-v40-rebuild.ts
apps/control-plane/src/call-session-v41-closure-guard.ts
apps/control-plane/src/call-session-v42-turn-boundaries.ts
apps/control-plane/src/realtime-response-owner.ts
apps/control-plane/src/response-owner-barge-in-decision.ts
apps/control-plane/src/barge-in-confirmation.ts
apps/control-plane/src/core-closing-policy.ts
apps/control-plane/src/human-handoff-turn-policy.ts
apps/control-plane/src/index-v5.ts
```

## 9. Commits recientes de esta reconstrucción

Commits/sha relevantes observados durante la sesión:

```text
290012aca927aba87c5d0ef528d44fa7bca2ca1d  owner barge-in activo
fc52e405c7b9f85feca3c92c5939d19d074d9ffb  candidato sin transcript / ventana real de escucha
f4b12f95eaa47f86bfc7792e577d0bfd4cf52419  v36 cede ownership a v40
5383151bc8c74fb97c77f4ba2f094b98119db513  presence guard + cierre con evidencia de usuario
f69f37de06cc953d50dd18884cb7bcd2132251c3  v42 handoff/presence turn boundaries — CI #254 verde
```

Consultar GitHub antes de asumir que estos siguen siendo el head actual.

## 10. Próximo paso recomendado

1. Confirmar si `f69f37de06cc953d50dd18884cb7bcd2132251c3` está desplegado.
2. Si no lo está, desplegar por el flujo disponible y registrar el SHA/Deployment ID real.
3. Repetir un diálogo controlado similar al que produjo la regresión.
4. Revisar `call_diagnostic_events` sin hacer cambios.
5. Confirmar específicamente:
   - ausencia de `USER_PRESENCE_RECOVERY_REQUESTED` inducido por background ignored;
   - después de `restaurant_business_info -> FOUND`, ausencia de `HUMAN_HANDOFF_ACCEPTED_V37` en el mismo turno;
   - un nuevo turno sigue pudiendo pedir handoff legítimo;
   - v40 mantiene `BARGE_IN_CONFIRMED`/`IGNORE` sin locks paralelos;
   - v41 mantiene `closing_authorized=false` salvo despedida real.
6. Solo si falla algo, investigar causa raíz antes de editar.

## 11. Prompt de continuación sugerido

El prompt completo para una nueva sesión se entrega también al usuario en el chat que creó este documento. La nueva sesión debe comenzar leyendo este archivo y `docs/PROJECT_STATUS.md`, después comprobar GitHub/CI y descubrir qué conectores reales están disponibles antes de ejecutar cambios o despliegues.
