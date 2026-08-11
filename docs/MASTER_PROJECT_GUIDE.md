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

## Checkpoint operativo — 2026-08-11

El estado detallado y autoritativo permanece en `PROJECT_STATUS.md`. Como resumen de navegación:

- Cloudflare KV es la fuente de configuración rápida por tenant, incluido prompt/persona, allowlist y `assistant.waitingPhrases`.
- `ToolGateway` aplica allowlist y contexto de tenant antes de acceder a datos empresariales.
- Supabase ya está integrado mediante `SupabaseAdapter` para lecturas iniciales de servicios/tratamientos, profesionales y horarios; por tanto la persistencia empresarial ya está EN CURSO.
- El router semántico clasifica `NONE | BUSINESS_INFO | SERVICES | PROFESSIONALS | HOURS` y ha sido endurecido para que consultas de tratamientos/servicios/catálogo/precio/duración se enruten a `SERVICES` incluso ante clasificaciones genéricas recuperables.
- Las frases de espera para consultas externas están implementadas; la sincronización fue corregida para evitar cortes y debe revalidarse E2E junto con el último cambio del router.
- El autodiagnóstico activable mediante `DEBUG_KEY=true|false` es prioridad de hardening, pero sigue PENDIENTE DE IMPLEMENTACIÓN; no debe asumirse disponible hasta que exista evidencia en código/pruebas.
- Las ramas de trabajo ya absorbidas se consolidan contra `main`; ramas divergentes antiguas se conservan como histórico y no se fuerzan sobre la arquitectura vigente.

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

La fase de producto `F9 App de gestión web/escritorio` está registrada en `PROJECT_STATUS.md` como extensión de roadmap y debe mantenerse coherente con la arquitectura canónica cuando se actualice su siguiente versión.

## Regla de mantenimiento

1. Este archivo no se elimina ni se renombra.
2. Si cambia la ubicación de la arquitectura canónica, se actualiza únicamente el enlace de este archivo.
3. Las definiciones de fases se toman de `SYSTEM_ARCHITECTURE.md`.
4. El progreso/cierre de fases se toma de `PROJECT_STATUS.md` y de la evidencia en `docs/tests/`.
5. Una guía de implementación puede ampliar una fase, pero no redefinir el roadmap sin actualizar la arquitectura canónica o un ADR posterior.
6. No marcar una funcionalidad como validada únicamente porque exista código: debe distinguirse entre IMPLEMENTADA, VALIDADA y PENDIENTE DE EVIDENCIA E2E.
