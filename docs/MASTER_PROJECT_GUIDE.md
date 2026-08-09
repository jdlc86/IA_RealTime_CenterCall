# IA_RealTime_CenterCall — MASTER PROJECT GUIDE

> **Path estable de compatibilidad. NO RENOMBRAR NI ELIMINAR.**

Este archivo existe como puerta de entrada permanente a la documentación maestra del proyecto. El antiguo `MASTER_PROJECT_GUIDE.md` fue renombrado durante la evolución documental; para evitar volver a perder la referencia, este path queda reservado de forma estable.

## Fuente de verdad

La arquitectura normativa vigente está en:

- [`docs/architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md)

El estado operativo actual de fases está en:

- [`docs/PROJECT_STATUS.md`](./PROJECT_STATUS.md)

El índice oficial y orden de autoridad documental está en:

- [`docs/README.md`](./README.md)

Las reglas no negociables de implementación están en:

- [`docs/architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md)

## Roadmap canónico

Según `SYSTEM_ARCHITECTURE.md` v2.1:

```text
F0 Voz E2E
  ↓
F1 Baseline + observabilidad + TenantResolver
  ↓
F2 Latencia + barge-in
  ↓
F3 ToolGateway
  ↓
F4 Clínica + validación multi-negocio
  ↓
F5 Persistencia/post-call
  ↓
F6 Handoff humano
  ↓
F7 Concurrencia
  ↓
F8 Hardening producción
```

## Regla de mantenimiento

1. Este archivo no se elimina ni se renombra.
2. Si cambia la ubicación de la arquitectura canónica, se actualiza únicamente el enlace de este archivo.
3. Las definiciones de fases se toman de `SYSTEM_ARCHITECTURE.md`.
4. El progreso/cierre de fases se toma de `PROJECT_STATUS.md` y de la evidencia en `docs/tests/`.
5. Una guía de implementación puede ampliar una fase, pero no redefinir el roadmap sin actualizar la arquitectura canónica o un ADR posterior.
