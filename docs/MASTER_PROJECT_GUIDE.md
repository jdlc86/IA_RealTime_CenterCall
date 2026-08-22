# IA_RealTime_CenterCall — Master Project Guide

> Ruta estable de compatibilidad. No renombrar ni eliminar.
> Última revisión: 2026-08-22

Este archivo es un índice, no una copia de la arquitectura ni del estado del proyecto.

## Continuar el trabajo

Leer en este orden:

1. [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md) — prompt y misión actual.
2. [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — realidad operativa y despliegue.
3. [`architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md) — restricciones no negociables.
4. [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md) — topología y contratos estables.
5. Los archivos y tests del componente concreto que vaya a modificarse.

Antes de escribir, comprobar siempre el worktree, la rama, el HEAD remoto, PR #85 y el CI de ese SHA. Los hashes incluidos en documentación son snapshots, nunca sustituyen a GitHub como fuente de verdad.

## Coordenadas estables

```text
repo       jdlc86/IA_RealTime_CenterCall
rama      rebuild/v39-stable-baseline
PR        #85 (base main)
entrypoint apps/control-plane/src/index-v6.ts
Worker    ia-realtime-centercall
Supabase  vutekfkbtvfogouwcfvc
diagnóstico public.call_diagnostic_events
```

Baseline de recuperación deliberadamente inmóvil:

```text
stable/pre-gemini-2026-08-19
→ ce23ac070558825ea909cbd7eb973b249bfe0a9e
```

No hacer rollback ciego a ese snapshot: se utiliza para comparar una regresión demostrada.

## Principio operativo

```text
evidencia → owner correcto → cambio mínimo → pruebas → CI del SHA
→ deploy exacto → E2E cuando el problema es de voz/event ordering
```

Mantener separados los estados `IMPLEMENTADO`, `CI VERDE`, `DESPLEGADO` y `VALIDADO E2E`.

La política de mantenimiento de documentación está en [`DOCUMENTATION_MAINTENANCE.md`](./DOCUMENTATION_MAINTENANCE.md).
