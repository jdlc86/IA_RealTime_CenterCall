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
- Las frases de espera para consultas externas están implementadas y la llamada E2E de validación confirmó el flujo `SERVICES → get_services → resultado externo → respuesta final` sin errores diagnósticos.
- El autodiagnóstico activable mediante `DEBUG_KEY=true|false` está **VALIDADO E2E EN LLAMADA REAL**. `DEBUG_KEY` se controla desde Cloudflare Dashboard; `wrangler.jsonc` usa `keep_vars: true` y no impone el flag.
- La persistencia diagnóstica en `public.call_diagnostic_events` está validada con eventos reales correlacionados por `call_id`. La llamada de validación `rtc_u7_EBmNR0PocXNS4T49HKewE` registró, entre otros, `DEBUG_CONFIGURED(enabled=true)`, `CALL_SESSION_STARTED`, `USER_TURN_RECEIVED`, `INTENT_CLASSIFIED(SERVICES)`, `BACKEND_QUERY_STARTED`, `BACKEND_QUERY_COMPLETED(get_services, 406 ms)`, `EXTERNAL_RESULT_READY_FOR_SPEECH`, `FINAL_RESPONSE_REQUESTED` y `SIDEBAND_CLOSED`, sin eventos de severidad `error`.
- El acceso backend a Supabase requiere `SUPABASE_SECRET_KEY` presente en runtime; `/health` confirmó `supabase_secret_key: true` antes de la validación final. La escritura diagnóstica usa la clave moderna mediante `apikey`, sin tratar `sb_secret_...` como JWT Bearer.
- La corrección de configuración/autenticación fue integrada en `main` mediante squash de la PR #1; commit resultante `4ba0fe41b399b0e7534e7afca334e887d3f9a412`.
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
