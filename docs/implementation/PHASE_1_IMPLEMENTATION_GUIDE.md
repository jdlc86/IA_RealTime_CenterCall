# FASE 1 — Baseline, observabilidad y TenantResolver

> Estado: CERRADA — PASS
> Inicio: 2026-08-09
> Cierre: 2026-08-09
> Prerrequisito: FASE 0 cerrada PASS.

## 1. Objetivo

FASE 1 convierte el E2E de voz validado en un bootstrap multi-tenant observable y personalizado por configuración.

```text
called_number
   ↓
TenantResolver
   ↓
tenant_id
   ↓
TenantConfiguration
   ↓
RealtimeSessionConfiguration + CallSession
```

La personalización pertenece a configuración del tenant; no se crean forks ni condicionales de Core por cliente.

## 2. Tenant de validación F1

```text
+34910789057
   ↓
tenant_id = clinica-estetica-madrid
   ↓
Business = Clínica Estética Madrid
Assistant = Carolina
```

Saludo validado:

```text
Buenas, soy Carolina, asistente virtual de la Clínica Estética Madrid. ¿En qué puedo ayudarte?
```

## 3. TenantResolver — IMPLEMENTADO Y VALIDADO

Implementación: `StaticTenantResolver`, alimentado por `TENANT_ROUTES_JSON`.

Ruta vigente:

```text
+34910789057 → clinica-estetica-madrid
```

No existe fallback silencioso a otro tenant. Un número desconocido resuelve `null` y el orquestador aplica fail-closed.

Las pruebas contractuales reproducibles están registradas en `docs/tests/PHASE1.md`: 7/7 PASS, incluyendo normalización, número desconocido, entrada inválida, rutas duplicadas y parser de configuración.

## 4. CallOrchestrator — IMPLEMENTADO, E2E VALIDADO

En `call.initiated` inbound:

```text
payload.to
   ↓
StaticTenantResolver
   ↓
¿ruta conocida?
   ├─ NO → tenant_resolution_failed → Telnyx reject
   └─ SÍ → tenant_id → TenantConfiguration → transfer OpenAI
```

## 5. Tenant binding y personalización — E2E VALIDADO

El binding se conserva Telnyx → OpenAI mediante headers SIP internos:

```text
X-IA-Tenant-ID
X-IA-Called-Number
X-IA-Routing-Source
```

Después:

```text
tenant_id
   ↓
getTenantConfiguration(...)
   ↓
Clínica Estética Madrid / Carolina
   ↓
RealtimeSessionConfiguration
   ↓
CallSession Durable Object
   ↓
saludo inicial automático
```

`CallSession` conserva `call_id`, `tenant_id`, `business_name`, `assistant_name` e `initial_greeting`.

## 6. Observabilidad F1

Eventos relevantes implementados:

```text
tenant_resolution_started
tenant_resolution_succeeded
tenant_resolution_failed
call_orchestrator_route_selected
call_bootstrap_started
realtime_call_incoming
realtime_accept_result
call_session_start_requested
realtime_sideband_connected
tenant_initial_greeting_requested
call_bootstrap_ready
```

## 7. F1-T05 — tenant binding audible — PASS

Fecha: 2026-08-09.

Validación manual E2E mediante llamada real:

```text
Número: +34910789057
Tenant: clinica-estetica-madrid
Business: Clínica Estética Madrid
Assistant: Carolina
Saludo automático: PASS
Nombre de clínica: PASS
Nombre de asistente: PASS
Continuidad tras saludo: PASS
```

Conclusión: routing por número, tenant binding, carga de `TenantConfiguration` y personalización audible funcionan E2E para el tenant de validación.

## 8. Pruebas contractuales/negativas — PASS

Evidencia reproducible en `docs/tests/PHASE1.md`.

Resultado:

```text
# tests 7
# pass 7
# fail 0
```

Invariante principal validada:

```text
+34999999999
→ StaticTenantResolver.resolve(...)
→ null
```

No existe fallback accidental a `clinica-estetica-madrid` a nivel contractual del resolver.

## 9. Baseline cuantitativo — CANCELADO

El baseline cuantitativo de latencias inicialmente previsto para F1 queda **CANCELADO POR DECISIÓN DE PROYECTO** el 2026-08-09.

No se considera FAIL ni pendiente y no bloquea el Gate F1. No se inventan valores retrospectivos de p50/p95.

La observabilidad necesaria para realizar mediciones en una fase futura permanece disponible.

## 10. Gate F1 — CERRADO PASS

- [x] `TenantResolver` independiente.
- [x] routing por `called_number → tenant_id`.
- [x] número desconocido falla cerrado.
- [x] `TenantConfiguration` mínima creada para el tenant de validación.
- [x] `tenant_id` propagado a `CallSession`.
- [x] saludo inicial derivado de configuración del tenant.
- [x] logs de tenant resolution/bootstrap implementados.
- [x] despliegue verificado mediante llamada real.
- [x] F1-T05 E2E confirma binding y saludo audible.
- [x] pruebas contractuales/negativas: 7/7 PASS.
- [x] baseline cuantitativo retirado formalmente del Gate por decisión de proyecto.
- [x] documentación reconciliada con la evidencia disponible.

**Resultado Gate F1: PASS.**

## 11. Decisión de cierre

FASE 1 queda formalmente **CERRADA — PASS**.

La evidencia disponible demuestra el objetivo funcional de la fase para el tenant de validación: resolución por número, fail-closed contractual, propagación de identidad de tenant, configuración por tenant, personalización audible y observabilidad del bootstrap.

Limitación explícita: no se ha realizado una prueba PSTN E2E con un segundo número desconocido/segundo tenant. El comportamiento fail-closed del `TenantResolver` está cubierto mediante prueba contractual reproducible. Esto no se considera bloqueante para el cierre acordado de F1.

## 12. Commits relevantes

```text
59a8c960985c4e6cb69d775df7630b0fdcb0d664  TenantConfiguration Estética Madrid
e860bc0477a879317e6daee7db65f90c260c5d5c  número → clinica-estetica-madrid
eba3ed47530924e99326c40175987571c8439a18  tenant binding + saludo en CallSession
d9d987566b764255d7e7892684d562c2871adbe2  bootstrap personalizado en Worker
dde03c063059889c7ff9517a2203b65f20f2e178  evidencia contractual TenantResolver
```

## 13. Siguiente paso

```text
FASE 0 — CERRADA PASS
FASE 1 — CERRADA PASS
→ iniciar FASE 2 según el plan maestro vigente
```
