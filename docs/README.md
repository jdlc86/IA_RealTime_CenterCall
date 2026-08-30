# IA_RealTime_CenterCall — índice documental

> Estado: vigente
> Arquitectura ejecutable: Gemini Fast Worker → Fast Media Edge → Gemini Live

## Lectura mínima

1. [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — estado verificable.
2. [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md) — relevo para otra sesión.
3. [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md) — vista operativa.
4. [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md) — arquitectura normativa.
5. [`architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md) — decisión del Fast Path.
6. [`architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md) — invariantes.
7. [`HUMAN_HANDOFF.md`](./HUMAN_HANDOFF.md) — transferencia humana.
8. [`../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx`](../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx) — seguridad viva.
9. [`DOCUMENTATION_MAINTENANCE.md`](./DOCUMENTATION_MAINTENANCE.md) — mantenimiento documental.
10. [`MASTER_PROJECT_GUIDE.md`](./MASTER_PROJECT_GUIDE.md) — visión funcional.

## Arquitectura en una frase

```text
Telnyx webhook → Gemini Fast Worker → Fast Media Edge ↔ Gemini Live
                       │                    ↕
                       └─ control/tools     Telnyx media WSS
```
Cloudflare no transporta audio continuo. El producto retirado y los prototipos
anteriores no forman parte del árbol vigente; Git conserva su historial.

## Autoridad de despliegue

`Gemini Fast Canary Deploy` es el único workflow que puede desplegar el sistema
completo. Valida la revisión etiquetada antes de sincronizar Worker, retirar tags
antiguos y promocionar esa misma revisión.

## Estados

```text
IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E
```

Las afirmaciones remotas se verifican contra GitHub, Cloudflare, Cloud Run,
Supabase y Telnyx; no se infieren de documentos antiguos.

## Verificación

Desde `apps/gemini-control-plane`:

```bash
npm run docs:check
npm run check
```

Desde `apps/gemini-media-edge`:

```bash
npm run check
npm test
```
