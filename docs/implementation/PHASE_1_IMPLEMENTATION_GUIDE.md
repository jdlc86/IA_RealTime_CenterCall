# FASE 1 — Baseline, observabilidad y TenantResolver

> Estado: EN CURSO
> Inicio: 2026-08-09
> Prerrequisito: FASE 0 cerrada PASS.

## 1. Objetivo

FASE 1 convierte el E2E de voz validado en un bootstrap multi-tenant observable, medible y personalizado por configuración.

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

El número real de pruebas queda asociado a:

```text
+34910789057
   ↓
tenant_id = clinica-estetica-madrid
   ↓
Business = Clínica Estética Madrid
Assistant = Carolina
```

Configuración inicial del saludo:

```text
Buenas, soy Carolina, asistente virtual de la Clínica Estética Madrid. ¿En qué puedo ayudarte?
```

Este saludo tiene una función de validación arquitectónica: si se escucha al llamar al número configurado, existe evidencia audible de que el número fue resuelto al tenant correcto y que su `TenantConfiguration` llegó a la sesión Realtime.

## 3. F1-A — TenantResolver — IMPLEMENTADO

Contrato independiente del carrier:

```text
TenantRoutingContext { calledNumber }
        ↓
TenantResolver.resolve(...)
        ↓
TenantResolution { tenantId, calledNumber, source }
```

Implementación inicial: `StaticTenantResolver`, alimentado por `TENANT_ROUTES_JSON`.

Ruta vigente:

```text
+34910789057 → clinica-estetica-madrid
```

`DEFAULT_TENANT_ID` puede permanecer temporalmente por compatibilidad histórica, pero no participa en el routing operativo.

## 4. F1-B — CallOrchestrator — IMPLEMENTADO, E2E PENDIENTE

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

No existe fallback silencioso a otro tenant.

## 5. F1-C — Tenant binding y personalización — IMPLEMENTADO, E2E PENDIENTE

El binding se conserva en el salto Telnyx → OpenAI mediante headers SIP internos:

```text
X-IA-Tenant-ID
X-IA-Called-Number
X-IA-Routing-Source
```

El webhook `realtime.call.incoming` exige esos datos antes de `/accept`.

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

`CallSession` recibe y conserva:

```text
call_id
tenant_id
business_name
assistant_name
initial_greeting
```

El saludo solo se solicita una vez por `CallSession` mediante `greetingSent`, incluso si `/start` se reintentara.

## 6. Observabilidad F1

Eventos relevantes:

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

Los logs incluyen `tenant_id` cuando aplica y nunca exponen secretos.

## 7. Prueba E2E F1-T05 — tenant binding audible

Realizar una llamada al número configurado y no hablar inicialmente.

Esperado:

```text
Telnyx call.initiated
→ tenant_resolution_succeeded tenant_id=clinica-estetica-madrid
→ transfer OpenAI con headers SIP
→ realtime.call.incoming
→ call_bootstrap_started
→ /accept
→ CallSession tenant_id=clinica-estetica-madrid
→ realtime_sideband_connected
→ tenant_initial_greeting_requested
→ audio: "Buenas, soy Carolina, asistente virtual de la Clínica Estética Madrid. ¿En qué puedo ayudarte?"
```

PASS si:

- el nombre de negocio escuchado es Clínica Estética Madrid;
- la asistente se presenta como Carolina;
- la conversación continúa normalmente después del saludo;
- el cierre semántico v9 sigue funcionando;
- no aparece `tenant_binding_missing` ni `tenant_configuration_missing`.

## 8. Manejo de errores

Número desconocido:

```text
called_number sin ruta
→ tenant_resolution_failed
→ reject CALL_REJECTED
```

Tenant conocido sin configuración:

```text
tenant_id resuelto
→ tenant_configuration_not_found
→ reject
```

Binding SIP ausente:

```text
realtime.call.incoming sin headers internos requeridos
→ call_bootstrap_tenant_binding_missing
→ no /accept
```

## 9. Health esperado

Tras despliegue de esta iteración:

```json
{
  "phase": "F1",
  "tenant_resolver": "StaticTenantResolver",
  "tenant_routing_source": "called_number",
  "tenant_routes_valid": true,
  "tenant_routes_count": 1,
  "configured_tenant_id": "clinica-estetica-madrid",
  "configured_business_name": "Clínica Estética Madrid",
  "configured_assistant_name": "Carolina",
  "initial_tenant_greeting": true,
  "default_tenant_used_for_routing": false,
  "tenant_binding_transport": "sip_custom_headers",
  "tracing": "f1-tenant-greeting-v2"
}
```

## 10. Baseline pendiente

F1 debe registrar cuantitativamente:

- webhook Telnyx → transfer;
- `realtime.call.incoming` → `/accept`;
- `/accept` → sideband conectado;
- setup total hasta `call_bootstrap_ready`;
- duración de llamada y resultado de cierre.

No se inventan valores retrospectivos. p50/p95 se calcularán cuando haya suficiente evidencia.

## 11. Gate F1

- [x] `TenantResolver` independiente.
- [x] routing por `called_number → tenant_id`.
- [x] número desconocido falla cerrado.
- [x] `TenantConfiguration` mínima creada para el tenant de validación.
- [x] `tenant_id` propagado a `CallSession`.
- [x] saludo inicial derivado de configuración del tenant.
- [x] logs de tenant resolution/bootstrap implementados.
- [ ] despliegue de la iteración verificado.
- [ ] F1-T05 E2E confirma binding y saludo audible.
- [ ] baseline cuantitativo inicial documentado.
- [ ] pruebas contractuales/unitarias o evidencia equivalente.
- [ ] documentación y arquitectura reconciliadas al cierre.

## 12. Commits de esta iteración

```text
59a8c960985c4e6cb69d775df7630b0fdcb0d664  TenantConfiguration Estética Madrid
e860bc0477a879317e6daee7db65f90c260c5d5c  número → clinica-estetica-madrid
eba3ed47530924e99326c40175987571c8439a18  tenant binding + saludo en CallSession
d9d987566b764255d7e7892684d562c2871adbe2  bootstrap personalizado en Worker
```

Siguiente acción:

```text
esperar deploy Cloudflare
→ comprobar /health f1-tenant-greeting-v2
→ realizar F1-T05
```
