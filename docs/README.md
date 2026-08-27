# IA_RealTime_CenterCall — índice documental

> Estado: vigente  
> Última revisión: 2026-08-27  
> Runtime Gemini operativo: Fast Worker → Fast Media Edge etiquetado → Gemini Live

La documentación distingue explícitamente **estado actual**, **decisiones arquitectónicas**, **runbooks** e **historial**. Un documento de fase o una ADR antigua puede seguir siendo útil para reconstruir una decisión sin describir el runtime que atiende llamadas hoy.

## Lectura mínima para trabajar sobre el sistema actual

1. [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — qué está implementado, desplegado, validado y qué sigue abierto.
2. [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md) — prompt operativo para continuar el trabajo en otra sesión.
3. [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md) — separación estable entre control plane y media plane.
4. [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md) — topología actual OpenAI/Gemini y flujo Gemini Fast.
5. [`architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md) — decisión que gobierna el runtime Gemini de baja latencia.
6. [`architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md) — invariantes no negociables.
7. [`HUMAN_HANDOFF.md`](./HUMAN_HANDOFF.md) — transferencia a humano, auditoría y limitaciones conocidas.
8. [`DOCUMENTATION_MAINTENANCE.md`](./DOCUMENTATION_MAINTENANCE.md) — cómo mantener una única fuente de verdad.

[`MASTER_PROJECT_GUIDE.md`](./MASTER_PROJECT_GUIDE.md) conserva la visión funcional y de producto. No debe usarse por sí solo para inferir qué runtime está desplegado actualmente.

## Arquitectura actual en una frase

Para el producto Gemini que atiende las llamadas configuradas para este camino:

```text
Telnyx
  ↕ señalización/webhook
Gemini Fast Worker (Cloudflare)
  ↕ admission, tenant/KV, credenciales, tools/control, diagnósticos
Fast Media Edge etiquetado (Cloud Run)
  ↕ audio Telnyx                   ↕ Gemini Live
Telnyx media                Gemini 3.1 Flash Live
```

El Worker está deliberadamente fuera del transporte continuo de audio.

### Importante: `0%` de tráfico general de Cloud Run

El despliegue Fast crea una revisión de Cloud Run con `--no-traffic` y una URL etiquetada. **Eso no significa que la ruta Gemini esté inactiva.** El Fast Worker recibe la URL WSS etiquetada en `GEMINI_FAST_CANARY_EDGE_URL` y dirige las llamadas admitidas directamente a esa revisión.

Por tanto:

```text
0% tráfico general del servicio Cloud Run
≠
0 llamadas Gemini Fast
```

Para saber qué revisión usa una llamada hay que comprobar el binding del Fast Worker, no sólo el reparto general de tráfico de Cloud Run.

## OpenAI y Gemini

Los runtimes son estructuralmente independientes:

```text
apps/control-plane          + apps/media-edge          → producto/ruta OpenAI legado
apps/gemini-control-plane   + apps/gemini-media-edge   → producto/ruta Gemini
```

No se debe copiar automáticamente una decisión específica de OpenAI al producto Gemini ni introducir dependencia OpenAI en la ruta Gemini Fast. Los contratos de dominio/Supabase pueden compartirse sólo cuando sean realmente neutrales al proveedor.

## Autoridad documental

En caso de contradicción, usar este orden:

```text
ADR posterior aplicable
  → architecture/DESIGN_RULES.md
  → SYSTEM_OVERVIEW.md / architecture/SYSTEM_ARCHITECTURE.md
  → PROJECT_STATUS.md
  → SESSION_HANDOFF.md
  → runbooks / documentación de implementación / tests
  → documentos de fase, reviews y snapshots fechados
```

Un documento marcado como `ARCHIVADO`, `HISTÓRICO`, `SUPERADO` o equivalente no puede utilizarse para afirmar el estado operativo actual.

## Estado frente a evidencia

No usar estas palabras como sinónimos:

```text
IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E
```

Además, una capacidad E2E puede tener limitaciones de UX conocidas. Ejemplo actual: una transferencia puede alcanzar Telnyx correctamente mientras el ringback que oye el caller o el TTS terminal de fallo sigan necesitando hardening.

## Verificación documental

Desde `apps/control-plane`:

```bash
npm run docs:check
npm test
npm run check
```

`docs:check` valida documentos canónicos, enlaces locales y el contrato mínimo de relevo. Es una comprobación de coherencia documental; no sustituye tests del runtime Gemini, despliegue ni una llamada E2E.

## Historial útil — no estado actual

Entre otros, los siguientes archivos sirven para reconstruir la evolución del diseño:

- [`architecture/GEMINI_PHASE3_PROGRESS.md`](./architecture/GEMINI_PHASE3_PROGRESS.md) — progreso de la arquitectura previa al Fast Path; debe leerse como histórico.
- [`architecture/ADR-002-GEMINI-EXTERNAL-MEDIA-PLANE.md`](./architecture/ADR-002-GEMINI-EXTERNAL-MEDIA-PLANE.md) — decisión inicial del media plane; partes de sus gates fueron superadas por ADR-004 y la implementación actual.
- [`SESSION_HANDOFF_PROMPT_2026-08-22.md`](./SESSION_HANDOFF_PROMPT_2026-08-22.md) — snapshot anterior.
- [`SESSION_HANDOFF_2026-08-19.md`](./SESSION_HANDOFF_2026-08-19.md) — estado previo a la separación/fast path.
- [`DEVELOPMENT_LOG.md`](./DEVELOPMENT_LOG.md) — cronología extensa.

Consultar estos archivos para contexto, nunca como instrucciones operativas sin contrastarlos con `PROJECT_STATUS.md`.