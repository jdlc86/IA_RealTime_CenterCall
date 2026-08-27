# IA_RealTime_CenterCall — estado operativo

> Snapshot documental: 2026-08-28  
> Rama estable: `rebuild/v39-stable-baseline`  
> Baseline verificado al iniciar esta revisión: `794ff32f954c89b80cf3e8973b6bb7ae8b42a5fb`  
> PR de larga duración: PR #85, OPEN / DRAFT contra `main`  
> Arquitectura Gemini vigente: [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

Este archivo describe el **estado actual**. El detalle de contratos/procedimientos vive en sus documentos propietarios. Antes de actuar sobre producción se debe volver a verificar HEAD, workflows, bindings y configuración remota.

No confundir:

```text
IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E
```

## Resumen ejecutivo

El producto Gemini dispone de una ruta Fast independiente que ha atendido llamadas reales:

```text
Telnyx
  → Gemini Fast Worker (Cloudflare)
  → Fast Media Edge etiquetado (Cloud Run)
  → Gemini 3.1 Flash Live
```

La ruta conserva la separación control/media:

- el **Fast Worker** posee admission, tenant routing/KV, configuración, autorización/control y persistencia de diagnósticos;
- el **Fast Media Edge** posee los sockets de audio Telnyx/Gemini, VAD/turn-taking Gemini, barge-in, playback y coordinación realtime local;
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
| Auditoría `human_handoff_events` | ✅ | ✅ | ✅ | estados observados en Supabase |
| Diagnóstico `call_diagnostic_events` | ✅ | ✅ | ✅ | eventos persistidos fuera del hot path |
| Autorización semántica de handoff sin listas rígidas | ✅ | ✅ | ✅ baseline `794ff32f...` | regresiones sintéticas; **pendiente revalidación en llamada real** |
| Snapshot de transcript antes de `turnComplete` | ✅ | ✅ | ✅ baseline `794ff32f...` | test específico same-frame; **pendiente revalidación en llamada real** |
| Ringback audible durante transfer | no determinista | — | depende de early media | limitación abierta; ver `HUMAN_HANDOFF.md` |
| TTS terminal audible tras fallo/no-answer | acción implementada | tests parciales | audibilidad no fiable | limitación abierta; ver `HUMAN_HANDOFF.md` |
| Canary deploy preflight final | endpoint implementado | gate final desalineado | Worker/edge pueden quedar sincronizados antes del gate | deuda operativa; ver `runbooks/Deployment.md` |

## Baseline Gemini Fast actual

### Control plane

```text
apps/gemini-control-plane
Worker: ia-realtime-centercall-gemini-fast
```

Responsabilidades principales:

- validar webhook Telnyx;
- resolver `tenant_by_phone:<E164>`;
- leer `tenant_config:<tenant>` y `tenant_capabilities:<tenant>` antes de la llamada;
- emitir admission/credenciales efímeras para Media Edge;
- exponer control de transferencia humana;
- recibir diagnósticos bounded del Media Edge y persistirlos fuera del audio crítico.

### Media plane

```text
apps/gemini-media-edge
```

Fast path:

- Telnyx PCM → Gemini Live con el mínimo de transformaciones necesarias;
- Gemini audio → Telnyx;
- modelo baseline actual `gemini-3.1-flash-live-preview` mientras siga validado;
- VAD/turn-taking Gemini como baseline Fast;
- `Kore` como voz configurada actualmente;
- tool calls procesados dentro del contrato Fast sin introducir un hop remoto por cada turno.

## Routing por revisión etiquetada

El workflow Fast despliega una revisión con `--no-traffic` y tag `fast-<short-sha>`. Después el Worker se configura con:

```text
GEMINI_FAST_CANARY_EDGE_URL=wss://<tagged-revision>/telnyx/gemini
```

Por tanto, `0%` de tráfico general de Cloud Run **no implica** que esa revisión no atienda llamadas Fast. Para determinar la revisión efectiva hay que verificar el binding del Worker.

## Transferencia humana — resumen de estado

El contrato y las limitaciones pertenecen a [`HUMAN_HANDOFF.md`](./HUMAN_HANDOFF.md).

Baseline `794ff32f...`:

1. elimina listas rígidas de confirmaciones;
2. hace que Gemini clasifique semánticamente `EXPLICIT_REQUEST` / `CONFIRMED_OFFER`;
3. exige `caller_authority_evidence` grounded en el transcript snapshot;
4. captura el transcript antes de encolar la ejecución asíncrona para evitar la carrera con `turnComplete`.

Frontera exacta: la política Fast valida **enum + grounding**; no vuelve a interpretar la frase ni mantiene actualmente `offerPending` para probar por sí sola una oferta previa.

Limitaciones abiertas de ringback/TTS y divergencia de prompt heredada: ver `HUMAN_HANDOFF.md`.

## Deuda operativa de deploy — resumen

El detalle pertenece a [`runbooks/Deployment.md`](./runbooks/Deployment.md).

La causa demostrada que mantiene inválido el gate final Fast Canary es que el `jq` del workflow todavía espera campos históricos (`telnyxRouting`, `canaryCalledNumber`, `canaryTenant`) que `/internal/preflight` ya no devuelve. El contrato actual devuelve `tenantRouting: KV_RUNTIME_ONLY` y verifica bootstrap/HMAC/WSS sin tenant productivo.

El workflow actual ya dispone de retry bounded para respuestas temporales 401/503; no documentar `set -e` como causa vigente sin nueva evidencia.

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

Los guardrails operativos de `call_diagnostic_events` se documentan en [`runbooks/CROSS_PLANE_CALL_DIAGNOSTICS.md`](./runbooks/CROSS_PLANE_CALL_DIAGNOSTICS.md).

## Documentos históricos que no describen producción actual

Especialmente:

- `architecture/GEMINI_PHASE3_PROGRESS.md`;
- planes de Fase 2/3 basados en `GeminiCallSession`, STT autoritativo por turno, quarantine y semantic preselection obligatoria;
- snapshots de `SESSION_HANDOFF_*` fechados;
- partes de ADR-002 previas a ADR-004.

ADR-004 supersede el uso obligatorio de esos mecanismos en el Fast Path.

## Siguiente validación

Prioridad inmediata:

1. **realizar una llamada de transferencia con lenguaje natural** para confirmar en producción que no reaparece el bucle de autorización y que el transcript snapshot funciona bajo tráfico real;
2. correlacionar esa llamada en `call_diagnostic_events` y, si hay handoff aceptado, `human_handoff_events`;
3. corregir después el `jq` final del gate Fast Canary sin tocar runtime de llamadas;
4. diseñar/validar ringback determinista del caller en el control path;
5. endurecer la observabilidad/audibilidad del TTS terminal;
6. mantener fuera de alcance cualquier cambio innecesario en VAD, codecs, resampler o puente de audio.

## Restricciones vigentes

- prioridad máxima: no introducir regresiones de latencia ni estabilidad;
- no añadir Cloudflare al audio continuo;
- no reintroducir semantic preselection o STT externo como gate obligatorio del Fast Path sin nueva decisión arquitectónica;
- no resolver lenguaje natural mediante catálogos rígidos de frases;
- no mezclar OpenAI y Gemini dentro de una llamada sin ADR/requisito nuevo;
- no confundir ruta etiquetada de Cloud Run con reparto general de tráfico;
- verificar configuración remota antes de cambios de producción;
- documentar limitaciones observadas aunque código/CI estén verdes.
