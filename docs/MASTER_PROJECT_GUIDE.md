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

## Checkpoint operativo — 2026-08-13

El estado detallado y autoritativo permanece en `PROJECT_STATUS.md`. Resumen vigente:

- Cloudflare KV sigue siendo la fuente de configuración rápida por tenant, incluido prompt/persona, allowlist y `assistant.waitingPhrases`.
- `ToolGateway` continúa como frontera de acceso a datos/acciones empresariales y aplica allowlist + tenant context.
- El Core sigue siendo multi-tenant y multi-vertical con `businessType = CLINIC | RESTAURANT`; no se permiten forks del Core por tenant.
- `TenantConfigurationV2` continúa integrada con fallback compatible a V1 y fail-closed cuando una V2 existente es inválida/deshabilitada.
- `restaurante-centro` permanece validado en runtime como `businessType=RESTAURANT`; clínica debe mantenerse estable durante la evolución del vertical restaurante.
- Human handoff sigue siendo transversal y diferido a F6; no debe simularse todavía.
- Supabase sigue operativo desde el Worker y el conector Supabase de ChatGPT vuelve a estar disponible en esta sesión para consultas directas inocuas/verificación.
- `DEBUG_KEY` + `public.call_diagnostic_events` continúan siendo la fuente de evidencia E2E correlacionada por `call_id`.
- CI de `control-plane` sigue validando tests + Wrangler dry-run antes de integrar cambios que afectan al Worker.

## Checkpoint RESTAURANT — reservas, identidad, consulta, cancelación y códigos públicos

A 2026-08-13, el dominio de reservas ha evolucionado desde un único flujo `RESERVATION` hacia operaciones explícitas:

```text
RESERVATION / CREATE
RESERVATION / QUERY
RESERVATION / CANCEL
```

El clasificador propone intención/operación, pero el Core mantiene autoridad sobre el lifecycle y los workflows activos.

### CREATE

El flujo principal sigue siendo backend-orchestrated:

```text
usuario habla
  ↓
conversation_intent clasifica RESERVATION/CREATE
  ↓
ReservationState incremental en backend
  ↓
party_size + starts_at normalizado
  → check_reservation_availability (READ, en paralelo)
  ↓
completar datos restantes
  ↓
resumen
  ↓
confirmación explícita
  ↓
recheck final
  ↓
manage_reservation (WRITE)
  ↓
BOOKED
  ↓
solo entonces Lucía puede afirmar que está confirmada
```

Reglas añadidas/fortalecidas:

- el workflow CREATE pasa a considerarse activo desde la primera intención inequívoca de reservar, aunque todavía no exista un draft completo;
- un `starts_at` todavía no normalizado no invalida todo el turno: se preservan los demás datos válidos y `starts_at` queda pendiente;
- un fallback degradado del clasificador no puede sacar una reserva activa hacia un flujo ajeno como `BUSINESS_INFO`;
- el `caller_phone` confiable proveniente de Telnyx es el contacto por defecto de la reserva para minimizar interacción; Lucía no debe pedir que el usuario repita ese mismo número;
- el usuario puede proporcionar explícitamente otro `reservation_phone`; esto no altera la identidad confiable ni autoriza marketing;
- la disponibilidad paralela nunca sustituye el recheck inmediatamente anterior al WRITE.

### QUERY

`QUERY` es una operación READ-only independiente. La búsqueda se inicia siempre por:

```text
tenant_id + caller_phone confiable
```

No se usa un número dictado como prueba de identidad. La respuesta pública no expone teléfonos ni UUID internos.

### CANCEL

`CANCEL` tiene workflow propio y soporta una, varias o todas las reservas verificadas del mismo caller:

```text
lookup por tenant + caller_phone
  ↓
mostrar candidatas BOOKED
  ↓
selección: una | varias | ALL
  ↓
resumen exacto
  ↓
confirmación explícita única
  ↓
recheck individual
  ↓
BOOKED → CANCELLED condicionado por reserva
  ↓
resultado por reserva
```

La cancelación múltiple fue validada en llamada real: 6 reservas del mismo `caller_phone` fueron canceladas con `failed_count=0`; una reserva de otro número quedó correctamente intacta.

### Truth Guard y lifecycle

El Truth Guard distingue evidencia por operación:

- afirmación de creación confirmada → requiere `BOOKED`;
- afirmación de cancelación confirmada → requiere `CANCELLED`.

El estado `CLOSING` es terminal: una vez iniciado el cierre no puede reactivarse marketing ni otro workflow.

### Códigos públicos de reserva

Las reservas disponen ahora de dos identificadores separados:

- `id` UUID interno: solo backend, joins, precondiciones y diagnósticos;
- `reservation_code` público: formato corto `R-######`, apto para voz y atención al cliente.

El UUID no debe formar parte del contrato conversacional. CREATE/QUERY/CANCEL exponen únicamente el código público cuando necesitan referenciar una reserva al usuario.

### Grounding temporal

La verbalización de fechas usa una política centralizada en `Europe/Madrid`. El backend determina si un timestamp corresponde a `HOY`, `MANANA` o fecha absoluta; Lucía no debe recalcular por su cuenta relativos como hoy/mañana.

## Checkpoint marketing conversacional

Marketing y reservas siguen siendo procesos independientes.

Reglas vigentes:

- rechazar marketing nunca bloquea una reserva;
- `reservation_phone` y `marketing_phone` pueden ser distintos;
- para alta/baja automática por voz, `marketing_phone` debe coincidir exactamente con `caller_phone` confiable;
- un número dictado verbalmente no sirve como prueba para `CALLER_ID_MATCH`;
- consentimiento explícito y verificación del canal son hechos distintos y se persisten por separado;
- una persona A llamando desde A no puede modificar automáticamente marketing para B;
- el backend mantiene historial de ofertas para evitar propuestas repetitivas; una decisión existente/cooldown puede suprimir la propuesta;
- en una llamada real se validó `MARKETING_GRANTED` mediante `CALLER_ID_MATCH` y se verificó la supresión posterior por decisión existente;
- una llamada nueva falló antes de BOOKED por problemas de reserva incremental; por tanto, la revalidación E2E del post-booking con número nuevo queda pendiente después de los últimos fixes de CREATE/contacto.

## Commits recientes relevantes

- `0f17d37083dbb7c6d7ff7cfe65005325e5afc6f4` — autoridad única de estado conversacional;
- `eb2db0cdfba78ca4e32bba3c83e5d0165622d137` — operación CANCEL independiente;
- `7d978454e57c653876999ef992be1982782d975b` — operación QUERY por caller_phone;
- `4a7b9751266b57f842f9f8d370d2bc402c5d2abd` — cancelación múltiple + Truth Guard sensible a operación;
- `47d7834ab94b73629768ff2219d07d27ce7f8f20` — grounding temporal centralizado;
- `0f81cb0e9cfe248be8f2acf47a3182ec34d76ccd` — `reservation_code` público persistido;
- `4a422c6cdc3a35087d3589b949c3334954eab3ae` — ReservationState incremental/sticky;
- `cb4c569b76cdf14ef2096930e4f46880fcf99226` — `caller_phone` confiable como contacto por defecto de CREATE.

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

## Regla de mantenimiento

1. Este archivo no se elimina ni se renombra.
2. Si cambia la ubicación de la arquitectura canónica, se actualiza únicamente el enlace de este archivo.
3. Las definiciones de fases se toman de `SYSTEM_ARCHITECTURE.md`.
4. El progreso/cierre de fases se toma de `PROJECT_STATUS.md` y de la evidencia en `docs/tests/`.
5. Una guía de implementación puede ampliar una fase, pero no redefinir el roadmap sin actualizar la arquitectura canónica o una decisión arquitectónica posterior.
6. No marcar una funcionalidad como validada únicamente porque exista código: debe distinguirse entre IMPLEMENTADA, VALIDADA y PENDIENTE DE EVIDENCIA E2E.
7. Las diferencias entre sectores se modelan mediante `businessType`, configuración, módulos y allowlists; nunca mediante forks del Core o condicionales específicos por tenant.
8. El handoff humano se implementa una sola vez como capacidad transversal; los verticales pueden aportar razones/reglas de escalado, pero no duplicar el mecanismo telefónico.
