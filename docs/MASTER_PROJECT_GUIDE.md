# IA_RealTime_CenterCall — MASTER PROJECT GUIDE

> **Path estable de compatibilidad. NO RENOMBRAR NI ELIMINAR.**

Este archivo existe como puerta de entrada permanente a la documentación maestra del proyecto. El antiguo `MASTER_PROJECT_GUIDE.md` fue renombrado durante la evolución documental; para evitar volver a perder la referencia, este path queda reservado de forma estable.

## Fuente de verdad

La arquitectura normativa vigente está en:

- [`docs/architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md)

La decisión de verticales de negocio `CLINIC | RESTAURANT` está en:

- [`docs/architecture/BUSINESS_VERTICALS.md`](./architecture/BUSINESS_VERTICALS.md)

El estado operativo actual de fases está en:

- [`docs/PROJECT_STATUS.md`](./PROJECT_STATUS.md)

El índice oficial y orden de autoridad documental está en:

- [`docs/README.md`](./README.md)

Las reglas no negociables de implementación están en:

- [`docs/architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md)

## Checkpoint operativo — 2026-08-12

El estado detallado y autoritativo permanece en `PROJECT_STATUS.md`. Como resumen de navegación:

- Cloudflare KV es la fuente de configuración rápida por tenant, incluido prompt/persona, allowlist y `assistant.waitingPhrases`.
- `ToolGateway` aplica allowlist y contexto de tenant antes de acceder a datos empresariales.
- Se adopta formalmente el concepto de **vertical de negocio**: un Core común y agnóstico con `businessType = CLINIC | RESTAURANT`. Clínica y restaurante comparten infraestructura, seguridad, tenant context y ToolGateway, pero no se fuerzan a compartir el mismo modelo operacional.
- `TenantConfigurationV2` está integrada en `main` con namespace `ia-rtcc:v2:tenant:<tenant_id>`, prioridad V2, fallback compatible a V1 cuando V2 no existe y fail-closed si una V2 existente es inválida/deshabilitada.
- El tenant sintético `restaurante-centro` fue migrado a V2 y **VALIDADO EN RUNTIME** mediante el endpoint diagnóstico: `schemaVersion=2` y `businessType=RESTAURANT`. La clínica permanece temporalmente compatible con V1 para reducir riesgo durante la transición.
- El vertical `CLINIC` evoluciona hacia tratamientos/servicios, profesionales, citas y pacientes. El vertical `RESTAURANT` evoluciona prioritariamente hacia menú, disponibilidad, capacidad/party size y reservas. `AppointmentModule` y `ReservationModule` se mantienen separados.
- El endpoint `GET /debug/tenant/<tenantId>` está integrado y protegido por `DEBUG_KEY`; solo devuelve metadatos no sensibles. Existe una deuda técnica P2 conocida: `verticalConfigPresent` se deriva actualmente de `schemaVersion===2` y no demuestra por sí solo que el campo estuviera presente en el KV original. Esto debe corregirse antes de usar ese indicador como evidencia de configuración vertical completa.
- Supabase ya está integrado mediante `SupabaseAdapter` para lecturas iniciales de servicios/tratamientos, profesionales y horarios; por tanto la persistencia empresarial ya está EN CURSO.
- El router semántico actual clasifica `NONE | BUSINESS_INFO | SERVICES | PROFESSIONALS | HOURS`; su evolución deberá separar dominios comunes de dominios habilitados por vertical para evitar un clasificador global acoplado a todos los sectores.
- Las frases de espera para consultas externas están implementadas y la llamada E2E de validación confirmó el flujo `SERVICES → get_services → resultado externo → respuesta final` sin errores diagnósticos.
- El autodiagnóstico activable mediante `DEBUG_KEY=true|false` está **VALIDADO E2E EN LLAMADA REAL**. `DEBUG_KEY` se controla desde Cloudflare Dashboard; `wrangler.jsonc` usa `keep_vars: true` y no impone el flag.
- La persistencia diagnóstica en `public.call_diagnostic_events` está validada con eventos reales correlacionados por `call_id`. La llamada de validación `rtc_u7_EBmNR0PocXNS4T49HKewE` registró, entre otros, `DEBUG_CONFIGURED(enabled=true)`, `CALL_SESSION_STARTED`, `USER_TURN_RECEIVED`, `INTENT_CLASSIFIED(SERVICES)`, `BACKEND_QUERY_STARTED`, `BACKEND_QUERY_COMPLETED(get_services, 406 ms)`, `EXTERNAL_RESULT_READY_FOR_SPEECH`, `FINAL_RESPONSE_REQUESTED` y `SIDEBAND_CLOSED`, sin eventos de severidad `error`.
- El acceso backend a Supabase requiere `SUPABASE_SECRET_KEY` presente en runtime; `/health` confirmó `supabase_secret_key: true` antes de la validación final. La escritura diagnóstica usa la clave moderna mediante `apikey`, sin tratar `sb_secret_...` como JWT Bearer.
- CI de `control-plane` está activo en GitHub Actions y valida tests + Wrangler dry-run en PRs que afectan al Worker.
- Las ramas de trabajo ya absorbidas se consolidan contra `main`; ramas divergentes antiguas se conservan como histórico y no se fuerzan sobre la arquitectura vigente.

## Roadmap canónico

Según `SYSTEM_ARCHITECTURE.md` v2.2:

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
F5 Persistencia empresarial + Supabase + post-call
  ↓
F6 Handoff humano
  ↓
F7 Concurrencia
  ↓
F8 Hardening producción
  ↓
F9 App de gestión web/escritorio
```

La separación por vertical ya tiene base de configuración V2 y evidencia runtime para `RESTAURANT`. Antes de ampliar F5 con operaciones WRITE se corregirá la deuda P2 del diagnóstico y se continuará con dominios separados: clínica hacia citas/pacientes y restaurante hacia disponibilidad/reservas, compartiendo Core, autorización, auditoría y persistencia común cuando corresponda.

## Regla de mantenimiento

1. Este archivo no se elimina ni se renombra.
2. Si cambia la ubicación de la arquitectura canónica, se actualiza únicamente el enlace de este archivo.
3. Las definiciones de fases se toman de `SYSTEM_ARCHITECTURE.md`.
4. El progreso/cierre de fases se toma de `PROJECT_STATUS.md` y de la evidencia en `docs/tests/`.
5. Una guía de implementación puede ampliar una fase, pero no redefinir el roadmap sin actualizar la arquitectura canónica o una decisión arquitectónica posterior.
6. No marcar una funcionalidad como validada únicamente porque exista código: debe distinguirse entre IMPLEMENTADA, VALIDADA y PENDIENTE DE EVIDENCIA E2E.
7. Las diferencias entre sectores se modelan mediante `businessType`, configuración, módulos y allowlists; nunca mediante forks del Core o condicionales específicos por tenant.
