# Prompt de relevo — IA_RealTime_CenterCall

> Última revisión: 2026-08-28  
> Rama estable: `rebuild/v39-stable-baseline`  
> Baseline de referencia al redactar: `794ff32f954c89b80cf3e8973b6bb7ae8b42a5fb`  
> PR de larga duración contra `main`: PR #85, OPEN / DRAFT  
> Arquitectura Gemini vigente: [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

## INICIO DEL PROMPT

Continúa autónomamente el trabajo sobre `jdlc86/IA_RealTime_CenterCall` como Staff/Principal Engineer de sistemas realtime de voz. Prioriza estabilidad, evidencia y latencia. No conviertas documentación histórica en estado operativo sin contrastarla con código, workflows y servicios remotos.

### 1. Fuente de verdad y arranque obligatorio

```text
repo   jdlc86/IA_RealTime_CenterCall
rama   rebuild/v39-stable-baseline
PR     #85
base   main
```

La rama estable es la fuente de trabajo del proyecto. PR #85 sigue siendo el PR de larga duración contra `main`; verifica su estado remoto antes de asumirlo.

Antes de escribir o desplegar:

1. leer `docs/README.md`;
2. leer `docs/PROJECT_STATUS.md`;
3. leer `docs/SYSTEM_OVERVIEW.md`;
4. leer `docs/architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`;
5. leer `docs/architecture/DESIGN_RULES.md`;
6. si el trabajo afecta a transferencias, leer `docs/HUMAN_HANDOFF.md`;
7. verificar HEAD remoto y workflows del SHA exacto;
8. comprobar configuración remota cuando el resultado dependa de Worker, KV, Cloud Run, Supabase o Telnyx.

Documentos como `GEMINI_PHASE3_PROGRESS.md`, diseños/reviews de Fase 2/3 y snapshots `SESSION_HANDOFF_*` son historial. No pueden usarse para afirmar que Gemini sigue no productivo.

### 2. Arquitectura operativa actual

El producto Gemini dispone de un Fast Path independiente:

```text
Telnyx
  │ webhook / señalización
  ▼
Gemini Fast Worker — Cloudflare
  │ admission + tenant/KV + credenciales + control/tools + diagnóstico
  │
  └─────────────► WSS etiquetado
                    │
                    ▼
              Fast Media Edge — Cloud Run
                │              │
        Telnyx media WSS   Gemini Live WSS
                │              │
                └──── audio ────┘
```

Aplicaciones:

```text
apps/gemini-control-plane
apps/gemini-media-edge
```

OpenAI conserva su producto/ruta independiente:

```text
apps/control-plane
apps/media-edge
```

No existe requisito actual de coexistencia OpenAI/Gemini dentro de la misma llamada.

#### `0%` de Cloud Run no significa `0%` de llamadas Fast

El deploy Gemini Fast crea una revisión con `--no-traffic` y un tag. Después el Worker recibe `GEMINI_FAST_CANARY_EDGE_URL` apuntando directamente a esa URL etiquetada.

Por tanto, para saber qué revisión atiende llamadas Fast hay que comprobar el binding del Worker. El reparto general de tráfico del servicio Cloud Run por sí solo no responde esa pregunta.

### 3. Reglas arquitectónicas que no puedes violar

1. **Cloudflare no transporta audio continuo.**
2. El hot path Gemini normal es Telnyx Media Edge ↔ Gemini Live; no introducir un hop remoto obligatorio por cada chunk o turno.
3. No tocar VAD, codecs, resampler, buffers o audio bridge para resolver un problema de control si no existe evidencia de que el problema esté allí.
4. OpenAI y Gemini son runtimes estructuralmente independientes.
5. No introducir SDK/runtime/secretos OpenAI en Gemini ni viceversa por comodidad.
6. Un efecto irreversible requiere validación determinista de tenant, identidad, schema, capability y estado aplicable.
7. Gemini interpreta lenguaje natural. En handoff, el kernel valida el enum de autoridad soportado y el grounding textual en el transcript snapshot; no reinterpreta el español mediante listas rígidas ni reconstruye actualmente por sí mismo una oferta previa para `CONFIRMED_OFFER`.
8. Una transferencia a humano aceptada entra en lifecycle terminal para la IA; no reanudar conversación normal silenciosamente.
9. Persistencia de diagnósticos/handoff no puede bloquear audio ni telephony crítica.
10. No usar timers/sleeps para ocultar carreras de estado cuando puede capturarse identidad/evidencia en el momento correcto.
11. El transcript/evidencia usados para autorizar un tool deben pertenecer al turno capturado; no leer estado mutable que pueda haber sido limpiado después de encolar el efecto.
12. Supabase puede ser compartido entre productos mientras los contratos sean neutrales; no crear N bases/failover por defecto.
13. No almacenar audio, secretos o transcripts crudos en diagnóstico por defecto.
14. Una prueba sintética, CI verde o health endpoint no sustituyen una validación E2E cuando el comportamiento es acústico/telefónico.
15. Distinguir explícitamente **limitación conocida** de **regresión nueva**.

### 4. Estado real alcanzado

El Gemini Fast Path ya ha atendido llamadas reales. No está en la antigua Fase 3 “no productiva”.

Implementado y desplegado en la línea estable:

- Fast Worker independiente en `apps/gemini-control-plane`;
- Fast Media Edge independiente en `apps/gemini-media-edge`;
- Gemini Live audio→audio con VAD/turn-taking Fast;
- tenant routing/configuración mediante KV antes de la llamada;
- diagnósticos bounded hacia `public.call_diagnostic_events`;
- transferencia humana Fast con auditoría en `public.human_handoff_events`;
- lifecycle de éxito/fallo/no-answer de transferencia;
- política de callback registrada para handoffs fallidos;
- corrección del seeding KV para no crear placeholders cuando existen claves reales.

#### Autorización de handoff sin listas rígidas

Baseline `794ff32f...` corrigió dos problemas:

1. eliminó el uso de catálogos lingüísticos tipo `sí|vale|adelante|...` para decidir semántica;
2. eliminó la carrera por la que `turnComplete` podía limpiar `callerTranscript` antes de que el `transfer_call` asíncrono lo usara.

Gemini clasifica semánticamente la intención; la política Fast valida que el enum de autoridad sea soportado y que `caller_authority_evidence` esté realmente grounded en el transcript capturado. El runtime toma un snapshot antes de que el estado mutable pueda limpiarse.

La suite Fast incluye una regresión específica para `inputTranscription + transfer_call + turnComplete` en el mismo ciclo.

### 5. Limitaciones y deuda abiertas

Mantener aquí sólo el resumen. Los propietarios del detalle son:

- **Handoff / ringback / TTS terminal / contrato semántico:** `docs/HUMAN_HANDOFF.md`.
- **Deploy Fast / preflight canary:** `docs/runbooks/Deployment.md`.

Estado resumido:

- ringback local determinista para el caller: abierto;
- audibilidad E2E del TTS terminal tras `NO_ANSWER`/fallo: abierta;
- gate final de `Gemini Fast Canary Deploy`: el `jq` final sigue desalineado con el contrato actual de `/internal/preflight`; no interpretar ese rojo por sí solo como fallo del hot path.

### 6. Primera misión

La primera misión técnica recomendada es **validar en una llamada real el fix de autorización semántica + transcript snapshot** antes de continuar ampliando cambios de transferencia.

Prueba controlada:

1. realizar una llamada Gemini Fast real;
2. pedir handoff con lenguaje natural, sin adaptar la frase a listas antiguas;
3. si Gemini ofrece transferencia, responder con una confirmación natural;
4. comprobar que no reaparece un bucle de `HUMAN_HANDOFF_AUTHORIZATION_BLOCKED`;
5. correlacionar `call_diagnostic_events` y, si el handoff se acepta, `human_handoff_events`;
6. distinguir autorización correcta de los problemas todavía abiertos de ringback/TTS.

Después de esa E2E, corregir el gate `Gemini Fast Canary Deploy` **sin tocar el runtime de llamadas**:

1. comparar `.github/workflows/gemini-fast-canary-deploy.yml` con `apps/gemini-control-plane/src/fast-preflight.ts` y su test;
2. mantener el retry bounded existente para respuestas temporales 401/503;
3. actualizar la aserción `jq` al contrato real (`tenantRouting: KV_RUNTIME_ONLY` y campos actuales);
4. mantener el preflight sin dependencias de tenant/teléfono productivos;
5. ejecutar CI y el deploy canary;
6. exigir `bootstrap == VERIFIED` y `websocketUpgrade == VERIFIED` antes de declarar el gate reparado.

Después, las siguientes prioridades de UX son ringback determinista y TTS terminal observable/audible, manteniendo esos cambios en control path siempre que sea posible.

### 7. Validación y comandos obligatorios

Para documentación/Control Plane legado:

```bash
npm run docs:check
npm test
npm run check
```

Para `apps/gemini-control-plane`, ejecutar su `npm run check`/tests/CI correspondiente. Para `apps/gemini-media-edge`, ejecutar `npm run check` + `npm test` y cualquier CI Fast requerido por el cambio.

Distinguir siempre:

```text
IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E
```

En cambios acústicos o telefónicos, añadir además evidencia de llamada real antes de cerrar el problema.

### 8. Qué NO hacer

- no reintroducir listas rígidas de palabras para interpretar aceptación/rechazo;
- no volver a Google STT/semantic preselection como gate obligatorio de cada turno Fast sin nueva decisión arquitectónica;
- no introducir latencia en audio para resolver problemas de handoff/control;
- no asumir que `0%` de tráfico general Cloud Run desactiva la URL etiquetada usada por el Worker;
- no declarar ringback o failure TTS resueltos sin escucharlos/observarlos E2E;
- no usar documentos de fase antiguos como estado actual;
- no exponer secretos ni números de destino reales en documentación pública cuando un placeholder sea suficiente;
- no cambiar modelo/VAD/audio estable como efecto colateral de una limpieza de control o documentación.

### 9. Cierre de sesión

Antes de terminar una sesión relevante:

1. actualizar `PROJECT_STATUS.md` si cambió estado operativo;
2. actualizar este handoff si cambió la siguiente misión o una restricción crítica;
3. actualizar el runbook/ADR correspondiente cuando cambie procedimiento o arquitectura;
4. registrar evidencia suficiente para distinguir código, CI, deploy y E2E;
5. comprobar `npm run docs:check` cuando se modifiquen documentos canónicos;
6. dejar claro qué limitaciones siguen abiertas.

## FIN DEL PROMPT
