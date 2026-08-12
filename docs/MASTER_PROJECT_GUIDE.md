# IA_RealTime_CenterCall — MASTER PROJECT GUIDE

> **Path estable de compatibilidad. NO RENOMBRAR NI ELIMINAR.**

Este archivo existe como puerta de entrada permanente a la documentación maestra del proyecto. El antiguo `MASTER_PROJECT_GUIDE.md` fue renombrado durante la evolución documental; para evitar volver a perder la referencia, este path queda reservado de forma estable.

## Fuente de verdad

La arquitectura normativa vigente está en:

- [`docs/architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md)

La decisión de verticales de negocio `CLINIC | RESTAURANT` está en:

- [`docs/architecture/BUSINESS_VERTICALS.md`](./architecture/BUSINESS_VERTICALS.md)

La decisión de **handoff humano como capacidad transversal del Core y fase futura F6** está detallada en:

- [`docs/architecture/HUMAN_HANDOFF.md`](./architecture/HUMAN_HANDOFF.md)

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
- **Human handoff es transversal:** tanto clínica como restaurante podrán escalar a una persona mediante una capacidad común del Core. Su implementación queda expresamente diferida a F6; el desarrollo actual no debe simular transferencias inexistentes ni asumir que la IA será siempre el único canal de resolución.
- El endpoint `GET /debug/tenant/<tenantId>` está integrado y protegido por `DEBUG_KEY`; solo devuelve metadatos no sensibles.
- Supabase está integrado mediante `SupabaseAdapter` para persistencia/lecturas empresariales. La aplicación continúa operativa con su `SUPABASE_SECRET_KEY`; el conector Supabase de ChatGPT presenta una incidencia externa de autorización/disponibilidad y no debe confundirse con el acceso del Worker a producción.
- Las frases de espera para consultas externas están implementadas y la clínica validó el patrón de consulta en paralelo con voz.
- El autodiagnóstico activable mediante `DEBUG_KEY=true|false` está **VALIDADO E2E EN LLAMADA REAL**.
- La persistencia diagnóstica en `public.call_diagnostic_events` está validada con eventos reales correlacionados por `call_id`.
- CI de `control-plane` está activo en GitHub Actions y valida tests + Wrangler dry-run en PRs que afectan al Worker.

## Checkpoint RESTAURANT — reservas y caller ID confiable

A 2026-08-12, el flujo de reserva del restaurante ha pasado de “en desarrollo protegido” a **VALIDADO E2E en llamada real**. El detalle completo está en `docs/PROJECT_STATUS.md`.

Resumen:

- inventario de prueba: 3 mesas de 4 plazas + 2 mesas de 2 plazas;
- `check_reservation_availability` ejecuta READ en paralelo mientras Lucía continúa recogiendo datos;
- el estado de reserva se mantiene en backend y ya no depende del patrón fallido de un segundo `response.create` forzando `manage_reservation`;
- si no hay disponibilidad, el diseño busca alternativas verificadas cercanas;
- antes del WRITE se hace revalidación final de disponibilidad;
- Lucía solo puede decir “reserva confirmada” si el backend devuelve evidencia `BOOKED`;
- llamada real validada con `RESERVATION_AVAILABILITY_COMPLETED`, recheck final y `RESERVATION_BACKEND_BOOKED`;
- se corrigió la identidad telefónica: el número llamado del restaurante nunca puede reutilizarse como `caller_phone`;
- `payload.from` del webhook Telnyx, una vez verificada su firma, se propaga explícitamente como identidad confiable hasta Realtime/CallSession;
- una llamada real posterior almacenó manualmente verificado el número real del llamante como `customer_phone`.

Commits de referencia:

- `b74e05645702ffbea9ed8ac303498e1a7a1f2f1d` — backend reservation orchestrator + disponibilidad paralela;
- `8c830bd06cea0fcf1d1cf498069f126268b50153` — `session.type=realtime`;
- `dd0a173af6cc56562cf4e8f558e64483797b4de2` — fail-closed contra DID del tenant;
- `c61bdafe8aba7828660bbcea8080b3063cdb3e8d` — propagación confiable de `payload.from` Telnyx.

**Siguiente bloque funcional:** consentimiento comercial conversacional usando `CALLER_ID_MATCH`. La regla central ya está fijada: solo el `caller_phone` confiable puede autorizar o revocar automáticamente promociones para ese mismo número. El número dictado verbalmente no sirve como evidencia para este mecanismo. Handoff humano sigue diferido a F6.

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

F6 implementará el handoff humano transversal mediante contratos del Core/CallOrchestrator y `TelephonyProvider`, con configuración por tenant. Hasta entonces se mantiene como decisión arquitectónica documentada, no como capacidad activa.

La separación por vertical ya tiene base de configuración V2 y evidencia runtime para `RESTAURANT`. La evolución de F5 continúa con dominios separados: clínica hacia citas/pacientes y restaurante hacia consentimiento/post-call después de haber validado el núcleo de reservas, compartiendo Core, autorización, auditoría y persistencia común cuando corresponda.

## Regla de mantenimiento

1. Este archivo no se elimina ni se renombra.
2. Si cambia la ubicación de la arquitectura canónica, se actualiza únicamente el enlace de este archivo.
3. Las definiciones de fases se toman de `SYSTEM_ARCHITECTURE.md`.
4. El progreso/cierre de fases se toma de `PROJECT_STATUS.md` y de la evidencia en `docs/tests/`.
5. Una guía de implementación puede ampliar una fase, pero no redefinir el roadmap sin actualizar la arquitectura canónica o una decisión arquitectónica posterior.
6. No marcar una funcionalidad como validada únicamente porque exista código: debe distinguirse entre IMPLEMENTADA, VALIDADA y PENDIENTE DE EVIDENCIA E2E.
7. Las diferencias entre sectores se modelan mediante `businessType`, configuración, módulos y allowlists; nunca mediante forks del Core o condicionales específicos por tenant.
8. El handoff humano se implementa una sola vez como capacidad transversal; los verticales pueden aportar razones/reglas de escalado, pero no duplicar el mecanismo telefónico.
