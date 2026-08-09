# FASE 3 — ToolGateway

> Estado: EN CURSO  
> Inicio: 2026-08-09  
> Fuente canónica: `docs/architecture/SYSTEM_ARCHITECTURE.md`  
> Reglas aplicables: `docs/architecture/DESIGN_RULES.md`

## 1. Objetivo

FASE 3 introduce la frontera única y controlada entre el modelo Realtime y cualquier acción empresarial.

```text
Model tool call
      ↓
ToolGateway
      ↓
Tenant policy / allowlist
      ↓
Argument validation
      ↓
ToolExecutor / Business Module
      ↓
Provider / External System
      ↓
Structured result
      ↓
Model response
```

El modelo nunca es autoridad de permisos y ninguna integración empresarial puede saltarse `ToolGateway`.

## 2. Principios obligatorios

- Toda operación tiene `tenant_id`.
- Tool desconocida: fail-closed.
- Tool conocida pero no autorizada para el tenant: fail-closed.
- Argumentos se validan antes de ejecutar.
- Errores de executor se contienen y devuelven de forma estructurada.
- READ y WRITE quedan diferenciados desde el contrato.
- El dominio de ToolGateway no importa SDKs externos.
- La allowlist procede de `TenantConfiguration`, nunca del modelo.
- F3-B introduce una primera READ segura; no conecta todavía calendario, CRM ni operaciones WRITE.

## 3. F3-A — Core ToolGateway — IMPLEMENTADO

Archivo:

```text
apps/control-plane/src/tool-gateway.ts
```

Contratos principales:

```text
ToolContext
ToolRequest
ToolDefinition
TenantToolPolicy
ToolResult
ToolGateway
```

Flujo de ejecución:

```text
request
  ↓
¿tenant_id válido?
  ├─ no → TOOL_NOT_ALLOWED
  ↓
¿tool registrada?
  ├─ no → TOOL_NOT_FOUND
  ↓
¿tool permitida para tenant?
  ├─ no → TOOL_NOT_ALLOWED
  ↓
validate(arguments)
  ├─ error → INVALID_ARGUMENTS
  ↓
execute(...)
  ├─ error → EXECUTION_FAILED
  ↓
ToolSuccess
```

## 4. Seguridad por tenant

`TenantConfiguration` contiene ahora la allowlist del tenant de validación:

```text
clinica-estetica-madrid
  tools.allowed = [get_business_information]
```

`CallSession` recibe esa lista durante el bootstrap y además la contrasta contra la `TenantConfiguration` canónica. Una lista enviada a `/start` no puede ampliar permisos por encima de la configuración del tenant.

No existe fallback a permisos globales ni a otro tenant.

## 5. READ vs WRITE

Cada `ToolDefinition` declara:

```text
access: READ | WRITE
```

La primera tool E2E es exclusivamente READ:

```text
get_business_information
```

Devuelve información autorizada procedente de la configuración del tenant:

```text
business_name
assistant_name
years_in_operation
source = tenant_configuration
```

El tenant de validación almacena `yearsInOperation = 20`. Este dato se usa deliberadamente como **dato de verificación tool-only**: no se incluye en el saludo, en las instrucciones base de Realtime ni en la descripción de la tool. Solo llega al modelo después de ejecutar `get_business_information` y recibir su `function_call_output`.

No modifica ningún sistema.

## 6. Pruebas contractuales F3-A

Tests reproducibles:

```text
apps/control-plane/src/tool-gateway.test.mjs
```

Casos:

- F3-T01 tool autorizada ejecuta con contexto de tenant;
- F3-T02 tool desconocida falla cerrado;
- F3-T03 tool conocida pero no autorizada falla cerrado;
- F3-T04 ausencia de `tenant_id` impide ejecución;
- F3-T05 argumentos inválidos no llegan al executor;
- F3-T06 fallo del executor queda contenido;
- F3-T07 definiciones duplicadas se rechazan.

Resultado inicial registrado:

```text
# tests 7
# pass 7
# fail 0
```

## 7. Compatibilidad con cierre semántico v9

La primera etapa de cada turno sigue siendo obligatoriamente:

```text
User turn
  ↓
conversation_intent
```

Solo cuando el resultado es `CONTINUE` se crea una segunda respuesta:

```text
CONTINUE
  ↓
response.create
  tool_choice=auto
  tools=allowlist del tenant
  ↓
¿tool necesaria?
  ├─ no → respuesta hablada normal
  └─ sí → ToolGateway
              ↓
         function_call_output
              ↓
         respuesta hablada
```

`END_AMBIGUOUS` y `END_CLEAR` no habilitan herramientas empresariales y conservan la política v9 existente.

OpenAI Realtime permite que `response.create` defina `tools` y `tool_choice` para una respuesta concreta, por lo que las tools de negocio no sustituyen al clasificador semántico de sesión.

## 8. F3-B — integración CallSession — IMPLEMENTADA, E2E PENDIENTE

Implementado:

- `TenantConfiguration.tools.allowed`;
- propagación de allowlist al `CallSession`;
- defensa adicional: `/start` no puede ampliar la allowlist canónica;
- tools empresariales disponibles únicamente después de `CONTINUE`;
- `get_business_information` como primera READ;
- ejecución mediante `ToolGateway`;
- retorno mediante `function_call_output`;
- nueva respuesta hablada basada en el resultado;
- estado `closing` impide nuevas operaciones empresariales.

Eventos de observabilidad:

```text
tool_enabled_response_requested
tool_gateway_request
tool_gateway_result
```

Cada evento incluye `call_id`, `tenant_id` y tool cuando aplica.

## 9. Prueba E2E F3-T08 — primera READ

Después de confirmar que `/health` muestra F3, realizar una llamada normal. Tras el saludo de Carolina preguntar:

```text
Carolina, ¿cuántos años lleva funcionando la clínica?
```

Esperado:

```text
conversation_intent = CONTINUE
→ tool_enabled_response_requested
→ get_business_information
→ tool_gateway_request
→ tool_gateway_result ok=true access=READ
→ function_call_output contiene years_in_operation = 20
→ Carolina responde que la clínica lleva 20 años funcionando
```

La prueba solo se considera PASS si Carolina responde **20 años** y existe evidencia de `tool_gateway_request/result`. El valor 20 no está disponible en el prompt base, por lo que esta prueba proporciona evidencia audible de la ejecución de la READ tool.

## 10. Health esperado

```json
{
  "phase": "F3",
  "tool_gateway": true,
  "tool_gateway_policy": "tenant_allowlist_fail_closed",
  "configured_tenant_id": "clinica-estetica-madrid",
  "configured_allowed_tools": ["get_business_information"],
  "first_read_tool": "get_business_information",
  "tracing": "f3-tool-gateway-v1"
}
```

## 11. Gate F3 preliminar

- [x] contrato `ToolGateway` independiente de SDKs externos;
- [x] autorización por tenant fail-closed;
- [x] validación previa a ejecución;
- [x] errores estructurados;
- [x] diferenciación READ/WRITE;
- [x] pruebas contractuales iniciales 7/7 PASS;
- [x] integración de código con `CallSession`/Realtime;
- [x] allowlist derivada de `TenantConfiguration`;
- [x] primera tool READ implementada;
- [x] observabilidad de tool calls implementada;
- [ ] deploy F3-B confirmado;
- [ ] F3-T08 READ E2E PASS;
- [ ] prueba de regresión de cierre semántico tras activar ToolGateway;
- [ ] documentación reconciliada al cierre.

## 12. Siguiente paso

```text
Cloudflare deploy automático
→ /health = F3 / f3-tool-gateway-v1
→ ejecutar F3-T08 preguntando los años de funcionamiento
→ revisar tool_gateway_request/result
→ comprobar una despedida END_CLEAR como regresión v9
→ evaluar cierre de F3 o siguiente bloque
```
