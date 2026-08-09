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

### F1-A — TenantResolver — IMPLEMENTADO

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

`DEFAULT_TENANT_ID` se conserva temporalmente únicamente por compatibilidad histórica, pero ya no es fuente de routing del CallOrchestrator.

### F1-B — Integración con CallOrchestrator — IMPLEMENTADO, E2E PENDIENTE

En `call.initiated` inbound:

1. se obtiene `payload.to` como número llamado confiable;
2. se ejecuta `TenantResolver`;
3. se registran `tenant_resolution_started` y resultado;
4. si existe ruta, el CallOrchestrator selecciona OpenAI Realtime con tenant binding conocido;
5. si no existe ruta, no se aplica tenant por defecto y la llamada se rechaza mediante Telnyx `CALL_REJECTED`;
6. el webhook se responde con HTTP 200 tras aceptar la decisión, evitando reintentos innecesarios de entrega;
7. `DEFAULT_TENANT_ID` no participa en la decisión operativa.

Flujo vigente:

```text
Telnyx call.initiated
        ↓
payload.to
        ↓
StaticTenantResolver
        ↓
     ¿ruta?
     /    \
   no      sí
   ↓       ↓
reject   tenant_id
            ↓
       RoutingDecision
            ↓
     OpenAI Realtime SIP
```

### F1-C — Tenant binding hacia OpenAI / CallSession — PARCIAL

Para conservar el binding durante el salto Telnyx → OpenAI, el comando `transfer` añade headers SIP internos:

```text
X-IA-Tenant-ID
X-IA-Called-Number
X-IA-Routing-Source
```

OpenAI expone los headers del INVITE en `realtime.call.incoming`; el webhook valida la presencia de los tres antes de `/accept`.

```text
TenantResolver
   ↓
Telnyx transfer custom_headers
   ↓
SIP INVITE OpenAI
   ↓
realtime.call.incoming.sip_headers
   ↓
Call Bootstrap tenant binding
```

Si falta el binding esperado, el bootstrap falla cerrado con `tenant_binding_missing`; no se sustituye silenciosamente por `DEFAULT_TENANT_ID`.

Pendiente de F1-C:

- persistir/propagar `tenant_id` dentro de `CallSession` Durable Object;
- usar posteriormente ese binding para construir `TenantConfiguration` y `RealtimeSessionConfiguration` específicas.

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

### F1-E — Observabilidad — PARCIAL

Logs estructurados incluyen cuando aplica:

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

Eventos F1 implementados:

```text
tenant_resolution_started
tenant_resolution_succeeded
tenant_resolution_failed
call_bootstrap_started
call_bootstrap_ready
call_bootstrap_tenant_binding_missing
```

Los eventos existentes de Telnyx/OpenAI/CallSession continúan siendo parte del trazado.

## 4. Manejo de errores

### Número sin tenant

```text
called_number sin ruta
→ tenant_resolution_failed
→ no seleccionar tenant por defecto
→ Telnyx reject CALL_REJECTED
```

FASE 1 adopta fail-closed para routing desconocido. Ya no existe fallback silencioso a `dev-clinic`.

### Binding SIP ausente

```text
realtime.call.incoming sin X-IA-Tenant-ID / X-IA-Called-Number / routing source
→ call_bootstrap_tenant_binding_missing
→ no /accept
```

### Configuración inválida

`TENANT_ROUTES_JSON` inválido o con números duplicados produce error visible; no se elige un tenant arbitrario.

`/health` publica únicamente estado de validez y número de rutas; no expone secretos.

## 5. Pruebas F1

### F1-T01 — número conocido

```text
+34910789057 → dev-clinic
```

Esperado: resolución exacta por `called_number`.

### F1-T02 — normalización

El mismo E.164 con caracteres de presentación tolerados debe resolver al mismo tenant.

### F1-T03 — número desconocido

Esperado: ruta no encontrada, `tenant_resolution_failed` y rechazo controlado; nunca tenant incorrecto.

### F1-T04 — duplicados de configuración

Esperado: error de configuración.

### F1-T05 — llamada E2E con tenant binding

Llamada real al número configurado:

```text
Telnyx call.initiated
→ TenantResolver
→ tenant_resolution_succeeded tenant_id=dev-clinic
→ transfer OpenAI con headers de binding
→ realtime.call.incoming
→ call_bootstrap_started tenant_id=dev-clinic
→ /accept
→ CallSession
→ call_bootstrap_ready
```

### F1-T06 — aislamiento básico

Cuando exista un segundo número de prueba, confirmar que cada número produce su tenant correspondiente y que no hay fallback cruzado.

## 6. Health esperado tras despliegue F1-B

```json
{
  "phase": "F1",
  "tenant_resolver": "StaticTenantResolver",
  "tenant_routing_source": "called_number",
  "tenant_routes_valid": true,
  "tenant_routes_count": 1,
  "default_tenant_used_for_routing": false,
  "tenant_binding_transport": "sip_custom_headers",
  "tracing": "f1-tenant-routing-v1"
}
```

## 7. Gate F1

FASE 1 se puede cerrar cuando:

- [x] `TenantResolver` está implementado como contrato independiente.
- [x] routing inbound usa `called_number → tenant_id` en código.
- [x] una ruta desconocida no termina asignada silenciosamente a otro tenant en código.
- [ ] `tenant_id` queda unido al `CallSession` Durable Object.
- [x] logs de tenant resolution y bootstrap están implementados.
- [ ] baseline cuantitativo inicial de setup está documentado.
- [ ] pruebas unitarias/contractuales aplicables están implementadas o existe evidencia equivalente.
- [ ] prueba E2E real confirma tenant binding.
- [ ] documentación y arquitectura están reconciliadas al cierre.

## 8. Estado actual

Completado:

- [x] FASE 0 cerrada PASS.
- [x] creado `apps/control-plane/src/tenant-resolver.ts`;
- [x] definidos `TenantResolver`, `TenantRoutingContext` y `TenantResolution`;
- [x] creada implementación inicial `StaticTenantResolver` sin SDK externo;
- [x] parser de `TENANT_ROUTES_JSON` con validación y detección de duplicados;
- [x] ruta de desarrollo declarada en Wrangler: `+34910789057 → dev-clinic`;
- [x] `CallOrchestrator` usa `payload.to → TenantResolver`;
- [x] eliminado `DEFAULT_TENANT_ID` como fuente de routing;
- [x] routing desconocido falla cerrado mediante rechazo Telnyx;
- [x] tenant binding propagado Telnyx → OpenAI mediante headers SIP internos;
- [x] webhook OpenAI valida el binding antes de aceptar la llamada;
- [x] `/health` actualizado a F1 y expone estado de TenantResolver sin datos sensibles.

Commit principal de integración F1-B:

```text
e90576f60f4e9aeb98a435a285658d93d577b911
```

Siguiente tarea inmediata:

```text
Despliegue automático Cloudflare
→ comprobar /health f1-tenant-routing-v1
→ llamada E2E F1-T05
→ confirmar headers/binding
→ propagar tenant_id al CallSession Durable Object
```
