# IA_RealTime_CenterCall — índice documental

> Estado: vigente
> Última revisión: 2026-08-29
> Runtime Gemini operativo: Fast Worker → Fast Media Edge etiquetado → Gemini Live

La documentación distingue explícitamente **estado actual**, **decisiones arquitectónicas**, **runbooks** e **historial**. Un documento de fase o una ADR antigua puede seguir siendo útil para reconstruir una decisión sin describir el runtime que atiende llamadas hoy.

## Lectura mínima para trabajar sobre el sistema actual

1. [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — qué está implementado, desplegado, validado y qué sigue abierto.
2. [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md) — prompt operativo para continuar el trabajo en otra sesión.
3. [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md) — resumen canónico de los dos productos realtime y sus fronteras.
4. [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md) — topología actual OpenAI/Gemini y flujo Gemini Fast.
5. [`architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md) — decisión que gobierna el runtime Gemini de baja latencia.
6. [`architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md) — invariantes no negociables.
7. [`HUMAN_HANDOFF.md`](./HUMAN_HANDOFF.md) — transferencia a humano, autorización semántica y limitaciones conocidas.
8. [`../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx`](../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx) — inventario, decisiones y backlog vivo de seguridad.
9. [`DOCUMENTATION_MAINTENANCE.md`](./DOCUMENTATION_MAINTENANCE.md) — cómo mantener una única fuente de verdad.
10. [`runbooks/CALLER_SECURITY_REMEDIATION.md`](./runbooks/CALLER_SECURITY_REMEDIATION.md) — revisión, decay y reset administrado de reputación del caller.

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

Para saber qué revisión usa una llamada hay que comprobar el binding del Fast Worker, no sólo el reparto general de tráfico de Cloud Run.

## OpenAI y Gemini

Los runtimes son estructuralmente independientes:

```text
apps/control-plane          + apps/media-edge          → producto/ruta OpenAI
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
  → runbook/documento propietario del componente
  → documentos de fase, reviews y snapshots fechados
```

Un documento marcado como `ARCHIVADO`, `HISTÓRICO`, `SUPERADO` o equivalente no puede utilizarse para afirmar el estado operativo actual.

## Estado frente a evidencia

No usar estas palabras como sinónimos:

```text
IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E
```

Este índice no duplica incidencias operativas. Consultar `PROJECT_STATUS.md` para el resumen vivo y el documento propietario para el detalle: `HUMAN_HANDOFF.md` para transferencia, `runbooks/Deployment.md` para deploy/preflight, `runbooks/CROSS_PLANE_CALL_DIAGNOSTICS.md` para investigación de llamadas y `runbooks/CALLER_SECURITY_REMEDIATION.md` para falsos positivos/reset.

## Verificación documental

Desde `apps/control-plane`:

```bash
npm run docs:check
npm test
npm run check
```

`docs:check` valida documentos canónicos, enlaces locales y el contrato mínimo de relevo. Es una comprobación estructural; no valida por sí solo verdad operacional o coherencia semántica entre documentos. Las afirmaciones sobre producción deben contrastarse con código/workflows/sistemas remotos.

## Historial

Los diseños intermedios, planes de fase, handoffs fechados y cronologías superadas se retiraron del árbol vigente. Git conserva su contenido y autoría. Los ADR aceptados permanecen porque registran decisiones; su cabecera indica cuándo una decisión fue implementada o superada en parte.

Para reconstruir una decisión antigua, consultar el historial Git del archivo o del commit relevante, nunca restaurarlo como una segunda fuente de estado actual.
