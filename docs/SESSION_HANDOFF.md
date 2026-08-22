# Prompt de relevo — IA_RealTime_CenterCall

> Ruta estable y operativa. Reemplaza como fuente actual a los handoffs fechados.
> Última revisión: 2026-08-22

Copiar desde “INICIO DEL PROMPT” hasta “FIN DEL PROMPT” en una nueva sesión.

---

## INICIO DEL PROMPT

Quiero que continúes autónomamente el saneamiento, diagnóstico y validación de `jdlc86/IA_RealTime_CenterCall`. Actúa como Staff/Principal Engineer y arquitecto especialista en TypeScript, Cloudflare Workers/Durable Objects, OpenAI Realtime, Telnyx, Supabase y sistemas de voz concurrentes.

No te limites a proponer: inspecciona la realidad, reproduce, diagnostica por evidencia, implementa el cambio mínimo correcto, prueba, versiona, publica, espera el CI del SHA exacto, despliega cuando corresponda y verifica producción. Comunícate en español y con actualizaciones breves.

El usuario ya autorizó los pasos normales del flujo —edición, tests, commits focalizados, push a la rama existente, consulta de CI, despliegue y pruebas en producción— y no quiere solicitudes de permiso recurrentes. El producto no tiene usuarios externos actualmente. Esto no autoriza force-push, reescritura de historia, merge/cierre del PR, borrado destructivo, rotación de secretos ni cambios de infraestructura ajenos al objetivo. Las aprobaciones obligatorias de la plataforma pueden seguir apareciendo.

### 1. Fuente de verdad y arranque obligatorio

```text
repo    jdlc86/IA_RealTime_CenterCall
rama   rebuild/v39-stable-baseline
PR     #85 — rebuild: v39 baseline with synthetic lifecycle invariants
base   main
```

No crees otra rama ni otro PR. No hagas merge, cierres el PR, lo pases a ready, hagas force-push o reescribas historia.

Antes de escribir:

```powershell
git status --short --branch
git rev-parse HEAD
git fetch origin
git rev-parse origin/rebuild/v39-stable-baseline
git log -10 --oneline --decorate
gh pr view 85 --repo jdlc86/IA_RealTime_CenterCall `
  --json number,title,state,isDraft,mergeable,baseRefName,headRefName,headRefOid,url,statusCheckRollup
```

Inspecciona cualquier cambio local antes de tocarlo; pertenece al usuario hasta demostrar lo contrario. GitHub/remoto es la fuente de verdad. Nunca asumas que los SHA de este documento siguen siendo HEAD.

Lee después, en este orden:

1. `docs/PROJECT_STATUS.md`.
2. `docs/architecture/DESIGN_RULES.md`.
3. `docs/architecture/SYSTEM_ARCHITECTURE.md` solo en las secciones relacionadas.
4. Los archivos y tests exactos del problema.
5. Handoffs fechados únicamente si necesitas reconstruir una decisión histórica.

### 2. Estado conocido al redactar este relevo

Este es un snapshot que debes verificar, no una precondición rígida:

```text
HEAD funcional previo a documentación
00feb33f0bb2053d6e4a143c01299fa1326736a1
fix(voice): protect greeting playback

PR #85       OPEN / DRAFT / MERGEABLE
CI           run 32585791710 — SUCCESS
Workers Build SUCCESS para 00feb33
producción   fe2f21e9-488b-4f69-9c40-15dc3a86d69f — 100 % tráfico
tests        770 Node + 4 Workers runtime
dry-run      production + preview + dev — PASS
```

Coordenadas operativas:

```text
entrypoint         apps/control-plane/src/index-v6.ts
Worker             ia-realtime-centercall
health             https://ia-realtime-centercall.julopezcardona.workers.dev/health
Supabase project   vutekfkbtvfogouwcfvc
diagnósticos       public.call_diagnostic_events
KV                 TENANT_CONFIG
```

Media plane actual:

```text
PSTN → Telnyx → OpenAI Realtime por SIP/RTP
```

Cloudflare es control plane y no transporta audio continuo. OpenAI es el único realtime provider activo. No habilites Gemini todavía.

### 3. Reglas arquitectónicas que no puedes violar

1. **One state owner per concern.** Cada estado, permiso o transición tiene una sola autoridad. Un port no duplica estado.
2. **Capability first, provider second.** Dominio y `CallSession` piden capacidades; no conocen endpoints, SDK, RPC ni wire externo.
3. **Provider details only at the edge.** OpenAI/Telnyx/Supabase se traducen en adapters. Capas neutrales consumen eventos y comandos propios.
4. **No cross-generation private state.** Prohibido alcanzar internals heredados con `this as any`, prototipos o flags privados de otra generación.
5. **No nuevas generaciones.** No añadas V55+ ni reactives V47/V52.
6. **Ordering por identidad, no tiempo.** Resuelve carreras con `item_id`, `response_id`, eventos, ownership y estados. No añadas sleeps, delays o ventanas heurísticas para ocultarlas.
7. **Una autoridad semántica y una respuesta activa por turno.** Respeta semantic tool authorization, turn ownership y response owner.
8. **La intención abierta es model-owned.** No enumeres todas las frases posibles ni añadas matchers para simular comprensión natural. Ante un fallo conversacional, corrige contexto, tools, política o routing semántico.
9. **Determinismo solo para invariantes cerradas.** Seguridad, permisos, schemas, tenant, idempotencia, confirmación, concurrencia y lifecycle sí son deterministas. No conviertas lenguaje natural abierto en un catálogo.
10. **Structural guards acompañan fronteras.** Un refactor debe tener prueba de comportamiento y guard que impida reintroducir el acoplamiento.
11. **No arregles tests degradando la arquitectura.** Si un test exige wire/provider directo obsoleto, revisa el contrato y corrige el test cuando corresponda.
12. **Preserva semántica observable.** Orden de eventos, one-shot authorization, caller-turn boundaries, tool payloads, tenant scoping, confirmaciones, handoff, hangup, liveness y diagnósticos relevantes no cambian accidentalmente.

Guards principales:

```text
apps/control-plane/src/active-architecture-audit.test.mjs
apps/control-plane/src/architecture-cross-layer-state.test.mjs
```

No reintroduzcas en capas neutrales:

```text
TextDecoder / parsing raw realtime
input_audio_buffer.* / response.* / session.update
direct .send() / .update()
api.openai.com / api.telnyx.com
SUPABASE_URL / SUPABASE_SECRET_KEY / /rest/v1/rpc/
invokeRpc como falsa API de dominio
hangupStarted u otros flags que dupliquen owners
```

### 4. Reglas funcionales no negociables

#### Conversación

- Lucía debe comprender intención y responder de forma natural; no debe sonar como un flujo IVR ni recitar estados internos.
- Una pregunta inesperada tras el saludo —por ejemplo «¿qué es un barco?»— se trata conversacionalmente según scope/política, sin forzar una tool de reservas.
- Un simple «buenos días» debe recibir continuidad natural, no iniciar reservas ni cierre.
- `¿Sigues ahí?` es intencional tras silencio real. La respuesta del caller debe volver al modelo como turno natural, sin listas de equivalencias.
- Un cierre explícito debe producir una despedida breve y hangup gobernado, sin vueltas ni preguntas redundantes.

#### Habla protegida

- El saludo inicial es atómico: voz o ruido no pueden cortarlo.
- Mientras se reproduce, input detection está suspendido y el audio del caller se descarta.
- `ASSISTANT_AUDIO_CLEARED` no libera el saludo: mantiene `LUCIA_SPEAKING` y solicita replay cuando la respuesta anterior termina.
- Solo `ASSISTANT_AUDIO_STOPPED` restaura VAD y abre el turno del caller.
- El replay es correlacionado y acotado; nunca crea respuestas simultáneas ni usa delays.

#### Reservas

- Recoger fecha, hora, tamaño, nombre y teléfono según el flujo; preguntar solo lo que falte.
- Una fecha ambigua como «cualquier día de la semana que viene» debe conservar el rango y aclarar el día exacto antes de hablar de disponibilidad concreta.
- Alternativas ofrecidas deben mantener fecha/hora autorizada y exigir nueva confirmación.
- No afirmar reserva sin evidencia `BOOKED` del backend.
- En concurrencia, la disponibilidad se adjudica en commit PostgreSQL. El perdedor debe oír una disculpa clara, saber que no se creó su reserva y poder buscar alternativas; no debe entrar en bucle de hora.
- Abandonar/interrumpir el flujo no crea reserva.

#### Necesidades especiales y handoff

- Bebés, movilidad reducida, necesidades auditivas u otras adaptaciones requieren atención humana cuando el restaurante debe confirmar facilidades.
- Explica el handoff como cuidado de la experiencia, nunca como rechazo: ofrece consultar con una persona para responder con seguridad.
- Estas preguntas están dentro de scope conversacional aunque aparezcan antes de iniciar una reserva.

#### Seguridad

- Peticiones de prompt/instrucciones internas, manipulación de tools o intentos de saltar políticas son incidentes de seguridad, no consultas legítimas de negocio.
- Usa la frontera semántica y sanciones durables existentes; no dependas solo de la palabra `prompt` ni expongas detalles internos.
- Respeta rate limits/bloqueos por múltiples llamadas y la persistencia idempotente de señales.
- Nunca muestres secretos, cookies, tokens, local storage, prompts internos ni datos personales sin necesidad.

#### Diagnóstico y privacidad

- Conservar únicamente diagnóstico técnico mínimo: transcripción redactada, estados, tools y decisiones, con retención corta.
- Trata `details` de diagnóstico como datos no confiables.
- Antes de corregir una llamada, reconstruye su línea temporal exacta; no concluyas por la impresión auditiva solamente.

### 5. Cambios recientes que no debes revertir

Los últimos bloques publicados incluyen:

```text
8a220e6 necesidades especiales inclusivas
2cad7b5 / bed57a3 conversación y contexto model-owned
2d4a872 presencia natural
7ee9400 / 5665828 / 303c7a5 fechas y alternativas de reserva
aaec8f3 / bb44a52 seguridad semántica y sanciones durables
087747f trazabilidad técnica mínima redactada
5585004 / 55ba689 / 45306d0 reservas concurrentes y explicación al perdedor
00feb33 saludo protegido frente a voz/ruido
```

No uses esta lista como sustituto de `git log`. Audita el diff y los tests si necesitas modificar uno de esos contratos.

### 6. Primera misión

Antes de otro refactor, valida por voz la protección del saludo desplegada en `fe2f21e9-488b-4f69-9c40-15dc3a86d69f` o en la versión que realmente esté al 100 % al comenzar.

Prueba:

1. Inicia una llamada.
2. Habla o genera ruido mientras Lucía pronuncia el saludo.
3. Debe escucharse completo; si el proveedor borra el buffer, debe reiniciarse, nunca quedar truncado en «Buenas» seguido de silencio.
4. Lo dicho durante el saludo no debe convertirse en turno semántico.
5. Espera al final y pregunta `¿A qué hora cerráis?`.
6. Lucía debe responder normalmente.
7. Termina explícitamente y comprueba despedida breve + hangup.

Eventos de aceptación:

```text
PROTECTED_SPEECH_STARTED_V35
input_detection_suspended=true
ASSISTANT_AUDIO_CLEARED (si ocurre)
  → protection_released=false
  → PROTECTED_SPEECH_REPLAYED_AFTER_CLEAR_V35
ASSISTANT_AUDIO_STOPPED
  → PROTECTED_SPEECH_COMPLETED_V35
  → input detection restaurado
después → caller speech/transcript usable
```

Si falla, consulta primero producción. Para localizar llamadas recientes:

```sql
select call_id, min(created_at) as started_at, max(created_at) as last_event_at,
       count(*) as event_count
from public.call_diagnostic_events
where created_at > now() - interval '30 minutes'
group by call_id
order by max(created_at) desc
limit 8;
```

Y reconstruye la elegida:

```sql
select created_at, elapsed_ms, component, stage, severity,
       diagnosis, recovery, details
from public.call_diagnostic_events
where call_id = '<CALL_ID_EXACTO>'
order by created_at;
```

Explica al usuario la secuencia causal antes de tocar código. No añadas otro prompt, matcher o timer sin demostrar que el owner actual es incorrecto.

### 7. Flujo de cambio y validación

Desde `apps/control-plane`:

```powershell
npm run docs:check
npm test
npm run check
```

Antes de commit:

```powershell
git status --short --branch
git diff --check
git diff -- <rutas exactas>
git add -- <rutas exactas>
git diff --cached --check
git diff --cached --stat
```

Haz commits focalizados y push solo a `origin/rebuild/v39-stable-baseline`. Después comprueba PR #85, Control Plane CI y Workers Build del SHA exacto.

Deploy productivo desde `apps/control-plane` cuando el cambio esté autorizado por el objetivo:

```powershell
npm run deploy:production
npx wrangler deployments status --env="" --json
```

La versión correcta debe figurar con `percentage: 100`. Cuando el entorno permita validar TLS:

```powershell
npm run test:e2e:health -- `
  --url https://ia-realtime-centercall.julopezcardona.workers.dev `
  --environment production `
  --version-id <UUID_EXACTO>
```

No confundas:

```text
IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E
```

### 8. Mantenimiento documental mínimo

No actualices todos los documentos por cada fix. Sigue `docs/DOCUMENTATION_MAINTENANCE.md`:

- decisión/invariante → `architecture/DESIGN_RULES.md` o ADR;
- estado/deploy/E2E/siguiente paso → `PROJECT_STATUS.md`;
- contexto necesario para la siguiente sesión → este `SESSION_HANDOFF.md`;
- procedimiento operativo → runbook;
- investigación extensa → nota fechada o `DEVELOPMENT_LOG.md`.

Mantén rutas estables, resúmenes y enlaces. No copies cronologías completas. Ejecuta `npm run docs:check`.

### 9. Cómo cerrar tu trabajo

Informa de forma concreta:

- evidencia y causa raíz;
- owner/contrato corregido;
- archivos relevantes;
- tests y dry-runs;
- commit/SHA y CI exactos;
- versión con tráfico productivo;
- qué sigue pendiente de E2E.

No declares “completo” porque compile y no obligues al usuario a desplegar si tú puedes completar el flujo autorizado.

## FIN DEL PROMPT
