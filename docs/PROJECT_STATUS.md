# IA_RealTime_CenterCall — PROJECT STATUS

> **Estado operativo actual del proyecto**  
> **Fecha:** 2026-08-13  
> Este documento registra progreso y cierre de fases. La definición de arquitectura y del roadmap pertenece a `docs/architecture/SYSTEM_ARCHITECTURE.md`.

## Estado de fases

```text
F0 Voz E2E                                   ✅ CERRADA — PASS
F1 Baseline + observabilidad + TenantResolver ✅ CERRADA — PASS con baseline cuantitativo CANCELADO por decisión de proyecto
F2 Latencia + barge-in                       ✅ CERRADA SIN CAMBIOS DE OPTIMIZACIÓN — comportamiento actual aceptado
F3 ToolGateway                               🟡 EN CURSO — integración E2E activa
F4 Clínica + validación multi-negocio        🟡 EN CURSO — RESTAURANT validado con número/routing independiente
F5 Persistencia empresarial + Supabase + post-call 🟡 EN CURSO — reservas RESTAURANT avanzadas; marketing conversacional parcialmente validado
F6 Handoff humano                            ⬜ NO INICIADA — decisión transversal documentada
F7 Concurrencia                              ⬜ NO INICIADA
F8 Hardening producción                      🟡 EN CURSO
F9 App de gestión web/escritorio             ⬜ NO INICIADA
```

## Checkpoint operativo RESTAURANT — 2026-08-13

### Estado validado E2E

- routing telefónico independiente y persona conversacional Lucía: VALIDADO;
- `businessType=RESTAURANT` en configuración V2: VALIDADO EN RUNTIME;
- inventario de prueba: tres mesas de 4 plazas y dos mesas de 2 plazas;
- `check_reservation_availability` como READ gobernada por allowlist;
- CREATE backend-orchestrated con disponibilidad en paralelo y recheck final: VALIDADO E2E;
- confirmación verbal protegida por evidencia backend `BOOKED`: VALIDADO;
- propagación confiable de `payload.from` Telnyx hasta `caller_phone`: VALIDADA;
- `CONVERSATION_STATE_AUTHORITY` evita que workflows especializados bypassen lifecycle/core routing: VALIDADO en llamadas reales;
- CLOSING terminal sin reactivar marketing/otros flujos: VALIDADO en llamada real;
- QUERY por `tenant_id + caller_phone`: IMPLEMENTADA;
- CANCEL individual/múltiple/ALL por `tenant_id + caller_phone`: VALIDADA E2E;
- una cancelación real de 6 reservas del mismo número finalizó con `cancelled_count=6`, `failed_count=0`;
- una reserva asociada a otro teléfono quedó correctamente intacta tras `CANCEL ALL`: VALIDADO;
- Truth Guard distingue `BOOKED` y `CANCELLED`: VALIDADO con tests y evidencia posterior de cancelación;
- `reservation_code` público corto tipo `R-######`: IMPLEMENTADO y persistido para reservas existentes;
- grounding temporal centralizado en `Europe/Madrid`: IMPLEMENTADO; evita contradicciones tipo “mañana 13” cuando es día 13.

### Diseño vigente de reservas

El dominio distingue explícitamente:

```text
RESERVATION / CREATE
RESERVATION / QUERY
RESERVATION / CANCEL
```

El clasificador propone semántica, pero el Core/lifecycle decide qué workflow puede consumir el turno.

#### CREATE

```text
conversation_intent → RESERVATION/CREATE
  ↓
ReservationState incremental
  ↓
party_size + starts_at normalizado
  → check_reservation_availability (READ paralelo)
  ↓
completar datos restantes
  ↓
resumen
  ↓
confirmación explícita
  ↓
recheck final
  ↓
manage_reservation
  ↓
BOOKED
  ↓
confirmación verbal autorizada
```

Cambios recientes de robustez:

- el workflow CREATE se activa desde la primera intención inequívoca de reservar, incluso con draft vacío;
- `starts_at` no normalizado ya no invalida todo el turno: se preservan los demás campos válidos;
- mientras CREATE está activo, un fallback degradado no puede escapar a `BUSINESS_INFO`;
- el `caller_phone` confiable se usa automáticamente como contacto de reserva para minimizar interacción;
- Lucía no debe pedir que el usuario repita el mismo número si el caller confiable existe;
- el usuario puede indicar explícitamente otro `reservation_phone`; sigue siendo un dato de contacto, no identidad ni autorización de marketing.

La última corrección de uso automático del `caller_phone` como contacto está IMPLEMENTADA y con CI verde, pero queda PENDIENTE una nueva llamada E2E que confirme que Lucía ya no solicita el teléfono durante CREATE.

#### QUERY

QUERY es READ-only y parte de `tenant_id + caller_phone` confiable. No utiliza un número verbal como prueba de identidad y no expone UUID ni teléfonos en la respuesta conversacional.

#### CANCEL

```text
lookup BOOKED por tenant + caller_phone
  ↓
mostrar candidatas
  ↓
selección una | varias | ALL
  ↓
resumen
  ↓
confirmación explícita única
  ↓
recheck individual
  ↓
BOOKED → CANCELLED condicionado
  ↓
resultado por reserva
```

No se simula atomicidad: cada reserva tiene su propia precondición y resultado. Si una cambia antes del WRITE, las demás pueden cancelarse y debe informarse el resultado exacto.

### Identificadores públicos

Las reservas tienen:

- `id`: UUID técnico interno, no verbalizable;
- `reservation_code`: código público corto `R-######`.

CREATE/QUERY/CANCEL deben exponer únicamente `reservation_code` al usuario. El UUID queda reservado para backend, joins, precondiciones y diagnósticos.

### Grounding temporal

La política de fecha relativa se centraliza en `Europe/Madrid`. El backend determina la etiqueta temporal autorizada; Lucía no debe derivar por su cuenta “hoy/mañana/ayer”.

## Identidad telefónica confiable

La fuente de identidad telefónica automática sigue siendo:

```text
Telnyx payload.from
  ↓ firma Ed25519 verificada
Worker
  ↓ normalización
from + X-IA-Caller-Number
  ↓
CallSession caller_phone
```

El DID llamado del tenant nunca puede aceptarse como `caller_phone`.

Para QUERY/CANCEL, `caller_phone` es la clave primaria de identidad dentro del tenant. Para CREATE se usa además como contacto por defecto, salvo que el usuario indique expresamente otro teléfono.

## Consentimiento comercial conversacional

Reserva y marketing son dominios separados. Rechazar marketing nunca impide reservar.

Reglas vigentes:

- `reservation_phone` y `marketing_phone` pueden ser distintos;
- alta/baja automática por voz solo para el mismo `caller_phone` confiable;
- el teléfono dictado no sirve como evidencia `CALLER_ID_MATCH`;
- una llamada desde A no puede modificar automáticamente marketing para B;
- consentimiento explícito y verificación del canal se persisten por separado;
- el backend mantiene historial de ofertas/cooldown para no repetir propuestas de forma insistente;
- una decisión existente puede suprimir la propuesta;
- se validó una alta real con `MARKETING_GRANTED` + `CALLER_ID_MATCH` y una llamada posterior suprimió correctamente la oferta por decisión existente.

Pendiente de nueva evidencia E2E: desde un número realmente nuevo, completar CREATE hasta `BOOKED` con los últimos fixes y verificar que la política post-booking evalúa/realiza la propuesta de marketing cuando corresponde.

## Supabase y observabilidad

- Cloudflare Worker → Supabase: ✅ operativo.
- Conector Supabase de ChatGPT: ✅ disponible de nuevo en esta sesión para consultas directas.
- `public.call_diagnostic_events` continúa como fuente principal de trazas por `call_id`.
- No registrar secretos, audio ni PII innecesaria.

## Commits recientes relevantes

- `0f17d37083dbb7c6d7ff7cfe65005325e5afc6f4` — autoridad de estado conversacional;
- `eb2db0cdfba78ca4e32bba3c83e5d0165622d137` — CANCEL como operación independiente;
- `7d978454e57c653876999ef992be1982782d975b` — QUERY por caller_phone;
- `4a7b9751266b57f842f9f8d370d2bc402c5d2abd` — cancelación múltiple + Truth Guard por operación;
- `47d7834ab94b73629768ff2219d07d27ce7f8f20` — grounding temporal;
- `0f81cb0e9cfe248be8f2acf47a3182ec34d76ccd` — `reservation_code` público;
- `4a422c6cdc3a35087d3589b949c3334954eab3ae` — CREATE incremental/sticky;
- `cb4c569b76cdf14ef2096930e4f46880fcf99226` — caller_phone confiable como contacto por defecto.

## F3 — ToolGateway

Continúa como frontera única de acciones empresariales. Mantiene `tenant_id` obligatorio, allowlist explícita, fail-closed, validación de argumentos y separación READ/WRITE.

## F4 — Multi-negocio

La configuración V2 soporta `BusinessType = CLINIC | RESTAURANT`, con routing independiente y configuración por tenant. La clínica debe permanecer estable mientras evoluciona restaurante; no se permiten forks del Core ni condicionales específicos por tenant.

## F5 — Restaurante: reservas, consentimiento y post-call

Reservas dispone ya de evidencia E2E positiva para CREATE base y CANCEL múltiple. QUERY, códigos públicos, grounding temporal y las últimas mejoras de CREATE están implementadas. F5 sigue abierta por validaciones E2E pendientes de los cambios recientes, consentimiento comercial completo y siguientes dominios post-call.

## F6 — Handoff humano

**NO INICIADA.** La decisión arquitectónica sigue fijada como capacidad transversal del Core. No existe `transfer_to_human` activo, no se simula transferencia y no se promete disponibilidad humana desconocida.

## F8 — Observabilidad/hardening

`DEBUG_KEY` + `call_diagnostic_events` continúan siendo la fuente de evidencia E2E. CI de control-plane exige tests + Wrangler dry-run antes de merge.

## F9 — App de gestión

La futura app compartirá Business Modules y persistencia con voz. Para restaurante deberá administrar inventario/capacidad, disponibilidad, reservas, códigos públicos y operaciones administrativas definidas posteriormente.

## Roadmap vigente

```text
F5 Persistencia/operaciones empresariales
 ↓
F6 Handoff humano transversal
 ↓
F7 Concurrencia
 ↓
F8 Hardening producción
 ↓
F9 App de gestión
```

## Próximo paso operativo

1. Ejecutar una nueva llamada CREATE desde un número nuevo tras `cb4c569...` y confirmar que Lucía no pide el teléfono cuando existe `caller_phone` confiable.
2. En esa misma llamada, completar hasta `BOOKED` y verificar la política post-booking de marketing para un número sin historial.
3. Revisar por `call_id` que no reaparezcan `RESERVATION_CLASSIFIER_PAYLOAD_INVALID`, escapes degradados a `BUSINESS_INFO` ni falsas confirmaciones.
4. Mantener QUERY/CANCEL y clínica estables mientras se valida el nuevo CREATE.
5. Mantener F6 únicamente documentada por ahora.
