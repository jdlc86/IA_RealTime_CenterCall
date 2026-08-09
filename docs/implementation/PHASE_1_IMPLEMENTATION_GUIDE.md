# FASE 1 — Baseline, observabilidad y TenantResolver

> Estado: EN CURSO
> Inicio: 2026-08-09
> Prerrequisito: FASE 0 cerrada PASS.

## 1. Objetivo

FASE 1 convierte el E2E de voz validado en un bootstrap multi-tenant observable y medible.

La definición canónica de arquitectura establece:

```text
F1 = Baseline + observabilidad + TenantResolver
```

El objetivo funcional principal es que una llamada deje de depender de un tenant fijo de desarrollo y se resuelva mediante contexto confiable de telefonía:

```text
called_number
   ↓
TenantResolver
   ↓
tenant_id
   ↓
Call Bootstrap / RoutingDecision
```

No se añade todavía lógica específica de clínica, restaurante, citas o reservas.

## 2. Reglas aplicables

- El dominio no importa SDKs externos.
- El tenant se resuelve desde routing confiable, inicialmente `called_number → tenant_id`.
- Toda sesión tiene `tenant_id`.
- No comienza conversación específica de negocio antes de completar Tenant Binding.
- La personalización futura se hará mediante `TenantConfiguration`, módulos y providers, nunca forks o condicionales de cliente.
- No se optimiza latencia sin baseline.
- Ningún gate se cierra sin evidencia.

## 3. Bloques de trabajo

### F1-A — TenantResolver

Contrato de dominio independiente del carrier:

```text
TenantRoutingContext { calledNumber }
        ↓
TenantResolver.resolve(...)
        ↓
TenantResolution { tenantId, calledNumber, source }
```

Implementación inicial: `StaticTenantResolver`, alimentado por configuración `TENANT_ROUTES_JSON`.

Configuración inicial de desarrollo:

```text
+34910789057 → dev-clinic
```

`DEFAULT_TENANT_ID` puede conservarse temporalmente para compatibilidad/diagnóstico, pero no debe ser la fuente de routing una vez integrado F1-A.

### F1-B — Integración con CallOrchestrator

En `call.initiated` inbound:

1. obtener `payload.to` como número llamado confiable;
2. resolver tenant mediante `TenantResolver`;
3. si no existe ruta, no iniciar conversación específica del negocio;
4. registrar resolución y decisión;
5. transferir a Realtime únicamente con tenant binding conocido;
6. propagar `tenant_id` al bootstrap de la sesión.

No se permite:

```text
incoming call → env.DEFAULT_TENANT_ID → routing
```

como diseño final de F1.

### F1-C — Tenant binding hacia OpenAI / CallSession

El `tenant_id` resuelto debe quedar asociado a la llamada y disponible para:

- construcción futura de `TenantConfiguration`;
- `RealtimeSessionConfiguration`;
- logs y métricas;
- autorización de tools en fases posteriores.

OpenAI o el texto del caller nunca son autoridad para elegir tenant.

### F1-D — Baseline

Registrar como mínimo por llamada:

- `call_received_at`;
- tiempo Telnyx webhook → comando transfer;
- tiempo `realtime.call.incoming` → `/accept` completado;
- tiempo `/accept` → sideband `CallSession` conectado;
- setup total observable hasta sesión lista;
- duración total de llamada;
- resultado de cierre.

Para cada métrica agregable se documentarán muestras y, cuando haya volumen suficiente, p50/p95.

FASE 0 aceptó latencia perceptual; F1 debe crear baseline cuantitativo sin inventar valores retrospectivos.

### F1-E — Observabilidad

Logs estructurados deben incluir cuando aplique:

```text
call_id
call_control_id
call_session_id
tenant_id
called_number
routing_source
elapsed_ms
result/status
```

No se registran secretos ni contenido sensible innecesario.

Eventos mínimos nuevos:

```text
tenant_resolution_started
tenant_resolution_succeeded
tenant_resolution_failed
call_bootstrap_started
call_bootstrap_ready
```

Los eventos existentes de Telnyx/OpenAI/CallSession continúan siendo parte del trazado.

## 4. Manejo de errores

### Número sin tenant

```text
called_number sin ruta
→ tenant_resolution_failed
→ no seleccionar tenant por defecto silenciosamente
→ fallback/terminate controlado
```

En entorno dev se podrá mantener un fallback explícito y observable únicamente si está documentado y marcado como tal. Producción debe fallar cerrado.

### Configuración inválida

`TENANT_ROUTES_JSON` inválido o con números duplicados debe producir error de configuración visible; no se debe elegir un tenant arbitrario.

## 5. Pruebas F1

### F1-T01 — número conocido

```text
+34910789057 → dev-clinic
```

Esperado: resolución exacta por `called_number`.

### F1-T02 — normalización

El mismo E.164 con caracteres de presentación tolerados debe resolver al mismo tenant.

### F1-T03 — número desconocido

Esperado: `null`/ruta no encontrada y fallback controlado; nunca tenant incorrecto.

### F1-T04 — duplicados de configuración

Esperado: error de configuración.

### F1-T05 — llamada E2E con tenant binding

Llamada real al número configurado:

```text
Telnyx call.initiated
→ TenantResolver
→ tenant_resolution_succeeded tenant_id=dev-clinic
→ transfer OpenAI
→ realtime.call.incoming
→ CallSession
```

### F1-T06 — aislamiento básico

Cuando exista un segundo número de prueba, confirmar que cada número produce su tenant correspondiente y que no hay fallback cruzado.

## 6. Gate F1

FASE 1 se puede cerrar cuando:

- [ ] `TenantResolver` está implementado como contrato independiente.
- [ ] routing inbound usa `called_number → tenant_id`.
- [ ] una ruta desconocida no termina asignada silenciosamente a otro tenant.
- [ ] `tenant_id` queda unido al bootstrap/sesión.
- [ ] logs de tenant resolution y bootstrap están disponibles.
- [ ] baseline cuantitativo inicial de setup está documentado.
- [ ] pruebas unitarias/contractuales aplicables están implementadas o existe evidencia equivalente.
- [ ] prueba E2E real confirma tenant binding.
- [ ] documentación y arquitectura están reconciliadas.

## 7. Estado inicial

Completado al abrir F1:

- [x] FASE 0 cerrada PASS.
- [x] creado `apps/control-plane/src/tenant-resolver.ts`;
- [x] definidos `TenantResolver`, `TenantRoutingContext` y `TenantResolution`;
- [x] creada implementación inicial `StaticTenantResolver` sin SDK externo;
- [x] parser de `TENANT_ROUTES_JSON` con validación y detección de duplicados;
- [x] ruta de desarrollo declarada en Wrangler: `+34910789057 → dev-clinic`.

Siguiente tarea inmediata:

```text
Integrar TenantResolver en CallOrchestrator
→ sustituir DEFAULT_TENANT_ID como fuente de routing
→ emitir logs de tenant resolution
```
