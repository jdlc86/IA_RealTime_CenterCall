# IA_RealTime_CenterCall — estado operativo

> Snapshot documental: 2026-08-27  
> Rama estable: `rebuild/v39-stable-baseline`  
> Baseline verificado al iniciar esta revisión: `794ff32f954c89b80cf3e8973b6bb7ae8b42a5fb`  
> PR de larga duración: PR #85, OPEN / DRAFT contra `main`  
> Arquitectura Gemini vigente: [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

Este archivo describe el **estado actual**, no el plan histórico que llevó hasta él. Antes de actuar sobre producción se debe volver a verificar HEAD, workflows, bindings y configuración remota.

No confundir:

```text
IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E
```

## Resumen ejecutivo

El producto Gemini ya no está en una fase “no productiva” de diseño. Existe una ruta Fast independiente que ha atendido llamadas reales:

```text
Telnyx
  → Gemini Fast Worker (Cloudflare)
  → Fast Media Edge etiquetado (Cloud Run)
  → Gemini 3.1 Flash Live
```

La ruta conserva la separación control/media:

- el **Fast Worker** posee admission, tenant routing/KV, configuración, autorización de efectos, señalización/control y persistencia de diagnósticos;
- el **Fast Media Edge** posee los sockets de audio Telnyx/Gemini, VAD/turn-taking Gemini, barge-in, playback y ejecución realtime local necesaria;
- Cloudflare **no transporta audio continuo**;
- OpenAI no forma parte del hot path Gemini.

## Estado por área

| Área | Implementado | CI | Producción | E2E / evidencia |
|---|---:|---:|---:|---|
| Separación estructural OpenAI/Gemini | ✅ | ✅ | ✅ estructura desplegable | repositorio con apps independientes |
| Gemini Fast Worker | ✅ | ✅ | ✅ | health y llamadas reales |
| Gemini Fast Media Edge | ✅ | ✅ | ✅ vía revisión etiquetada | readiness + llamadas reales |
| Audio Telnyx ↔ Gemini Live | ✅ | ✅ | ✅ | conversación real validada |
| Tenant routing/config por KV | ✅ | ✅ | ✅ | tenant real resuelto antes de llamada |
| Transferencia humana Fast | ✅ | ✅ | ✅ | transferencias exitosas y fallidas auditadas |
| Auditoría `human_handoff_events` | ✅ | ✅ | ✅ | estados de handoff observados en Supabase |
| Diagnóstico `call_diagnostic_events` | ✅ | ✅ | ✅ | eventos Fast/Gemini persistidos fuera del hot path |
| Autorización lingüística de handoff sin listas rígidas | ✅ | ✅ | ✅ desplegada en baseline `794ff32f...` | regresiones sintéticas; validar nuevamente en llamada real tras cada cambio relacionado |
| Snapshot de transcript antes de `turnComplete` | ✅ | ✅ | ✅ desplegado | test específico same-frame |
| Ringback audible para caller durante transfer | ❌ determinista no implementado | — | depende de early media | **limitación abierta** |
| TTS terminal audible tras `NO_ANSWER`/fallo | implementación existe | tests parciales | comportamiento observado no fiable | **limitación abierta** |
| Canary deploy preflight final | endpoint existe | gate de workflow actualmente defectuoso | no bloquea que Worker/edge queden sincronizados | **deuda operativa abierta** |

## Baseline Gemini Fast actual

### Control plane

Aplicación:

```text
apps/gemini-control-plane
```

Worker:

```text
ia-realtime-centercall-gemini-fast
```

Responsabilidades principales:

- validar webhook Telnyx;
- resolver `tenant_by_phone:<E164>`;
- leer `tenant_config:<tenant>` y `tenant_capabilities:<tenant>` antes de la llamada;
- emitir admission/credenciales efímeras para Media Edge;
- exponer control de transferencia humana;
- recibir diagnósticos bounded del Media Edge y persistirlos en Supabase;
- permanecer fuera del audio continuo.

### Media plane

Aplicación:

```text
apps/gemini-media-edge
```

Fast path:

- Telnyx PCM → Gemini Live con el mínimo de transformaciones necesarias;
- Gemini audio → Telnyx;
- modelo baseline actual `gemini-3.1-flash-live-preview` mientras siga siendo el candidato validado por el runtime;
- VAD/turn-taking Gemini como baseline Fast;
- `Kore` como voz configurada actualmente por el Fast runtime;
- tool calls procesados dentro del contrato Fast sin introducir un hop remoto por cada turno.

## La aparente contradicción `Cloud Run 0%`

El workflow Fast despliega una revisión con:

```text
--no-traffic
--tag fast-<short-sha>
```

Después configura el Worker con:

```text
GEMINI_FAST_CANARY_EDGE_URL=wss://<tagged-revision>/telnyx/gemini
```

Por eso el reparto general del servicio Cloud Run puede seguir mostrando `0%` para la revisión Fast mientras **las llamadas admitidas por el Fast Worker se dirigen explícitamente a su URL etiquetada**.

Regla operativa:

> Para determinar qué Media Edge atiende la ruta Gemini Fast, verificar el binding del Worker y la URL etiquetada. No inferirlo sólo del porcentaje general de tráfico de Cloud Run.

## Transferencia humana — estado actual

La transferencia Fast tiene configuración por tenant y auditoría en `public.human_handoff_events`.

Estados relevantes incluyen:

```text
REQUESTED
ANNOUNCING
DIALING
ANSWERED
TRANSFERRED
NO_ANSWER
BUSY
FAILED
CALLBACK_REQUIRED
TERMINATED
```

Los fallos/no-answer pueden dejar `callback_required=true` y `callback_status=PENDING`. Esto demuestra que la necesidad de callback queda registrada; **no implica que exista todavía un proceso automático que ejecute la devolución de llamada**.

### Corrección de autorización lingüística — 2026-08-27

Baseline `794ff32f...` eliminó el patrón de listas rígidas de confirmaciones del handoff Fast.

La política actual:

1. Gemini interpreta semánticamente la intención del caller;
2. la tool declara la autoridad semántica necesaria para el efecto;
3. el kernel exige evidencia grounded en el turno capturado;
4. el kernel valida evidencia/estado, no una lista de frases españolas;
5. el transcript usado por la autorización se captura antes de encolar el tool call para que `turnComplete` no pueda borrarlo durante la ejecución asíncrona.

Esto evita volver al patrón histórico de enumerar `sí`, `vale`, `adelante`, etc. como sustituto de comprensión lingüística.

## Limitaciones abiertas de transferencia

### 1. Ringback del caller

El código actual no genera de forma determinista un tono de llamada local mientras Telnyx intenta el destino. La transferencia puede depender del early media de la red/terminación. Si no llega early media audible, el caller puede escuchar silencio durante el intento.

No declarar este punto resuelto hasta probar una estrategia explícita de ringback compatible con el lifecycle de transferencia.

### 2. Mensaje terminal tras fallo/no-answer

Existe TTS de fallo en el control de handoff, pero una llamada real mostró que el caller no oyó de forma fiable el mensaje posterior al timeout. La auditoría de lifecycle y el TTS audible son evidencias distintas.

No afirmar “se reproduce exactamente una vez” como hecho E2E hasta añadir observabilidad suficiente y repetir una llamada fallida controlada.

## Deuda operativa: preflight del workflow Fast Canary

El workflow `.github/workflows/gemini-fast-canary-deploy.yml` consigue actualmente:

- tests Fast;
- build inmutable;
- revisión etiquetada con `0%` de tráfico general;
- readiness de la revisión;
- sincronización del Worker con la URL etiquetada;
- health del Worker.

El último gate `Prove Worker to Media Edge bootstrap and HMAC` quedó rojo en las ejecuciones observadas durante el despliegue de `794ff32f...`.

Hay dos problemas documentados en ese gate:

1. el nonce efímero del preflight puede devolver temporalmente `503 PREFLIGHT_UNAVAILABLE` durante propagación del Worker;
2. la aserción final del workflow espera campos antiguos (`telnyxRouting`, `canaryCalledNumber`, `canaryTenant`) que el contrato actual de `routeFastGeminiPreflight` ya no devuelve. El endpoint actual devuelve `tenantRouting: KV_RUNTIME_ONLY` y prueba bootstrap/WSS sin variables productivas de tenant o teléfono.

Este fallo debe tratarse como **deuda del gate de despliegue** hasta corregir el workflow; no como prueba de que el audio Fast o el handoff hayan fallado.

## Supabase

Tablas operativas relevantes:

```text
public.call_diagnostic_events
public.human_handoff_events
```

Principios:

- diagnóstico no debe guardar audio, secretos ni transcripts crudos por defecto;
- persistencia de diagnóstico/handoff Fast debe ser asíncrona y no introducir latencia en audio;
- un fallo de auditoría no puede cambiar el destino ni autorizar un efecto que el kernel haya rechazado.

## Documentos históricos que no describen producción actual

Especialmente:

- `architecture/GEMINI_PHASE3_PROGRESS.md`;
- planes de Fase 2/3 basados en `GeminiCallSession`, STT autoritativo por turno, quarantine y semantic preselection obligatoria;
- snapshots de `SESSION_HANDOFF_*` fechados;
- partes de ADR-002 previas a ADR-004.

ADR-004 supersede el uso obligatorio de esos mecanismos en el Fast Path. No deben utilizarse para concluir que Gemini sigue “traffic-disabled”.

## Siguiente validación

Prioridad inmediata después de esta limpieza documental:

1. mantener la documentación canónica alineada con el Fast Path real;
2. corregir el gate final del workflow Fast Canary sin tocar el runtime de llamadas;
3. realizar una llamada de transferencia con lenguaje natural para confirmar en producción la autorización semántica/snapshot;
4. diseñar y validar ringback determinista del caller en el control path;
5. endurecer y observar el TTS terminal de fallo/no-answer;
6. mantener fuera de alcance cualquier cambio innecesario en VAD, codecs, resampler o puente de audio.

## Restricciones vigentes

- prioridad máxima: no introducir regresiones de latencia ni estabilidad;
- no añadir Cloudflare al audio continuo;
- no reintroducir semantic preselection o STT externo como gate obligatorio del Fast Path sin una nueva decisión arquitectónica;
- no resolver lenguaje natural mediante catálogos rígidos de frases;
- no mezclar OpenAI y Gemini dentro de una llamada sin ADR/requisito nuevo;
- no confundir ruta etiquetada de Cloud Run con reparto general de tráfico;
- verificar configuración remota antes de cambios de producción;
- documentar limitaciones observadas aunque el código/CI estén verdes.