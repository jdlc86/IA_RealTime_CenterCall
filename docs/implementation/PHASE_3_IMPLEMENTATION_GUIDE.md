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
- F3 no introduce todavía lógica específica de clínica ni integración CRM/calendario.

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

La autorización se resuelve mediante allowlist explícita por tenant:

```text
TenantToolPolicy {
  tenantId,
  allowedTools[]
}
```

No existe fallback a permisos globales ni a otro tenant.

## 5. READ vs WRITE

Cada `ToolDefinition` declara:

```text
access: READ | WRITE
```

En F3-A esta clasificación ya forma parte del resultado estructurado. Las políticas adicionales para WRITE se ampliarán antes de conectar operaciones que modifiquen sistemas externos.

## 6. Pruebas contractuales F3-A

Se añadieron tests reproducibles:

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

Resultado de ejecución inicial:

```text
# tests 7
# pass 7
# fail 0
```

## 7. Compatibilidad con cierre semántico v9

La sesión actual utiliza una primera etapa obligatoria `conversation_intent` para cada turno. Esta política no se eliminará para introducir herramientas empresariales.

La integración F3 con Realtime seguirá el patrón:

```text
User turn
  ↓
conversation_intent (obligatoria)
  ↓
CONTINUE
  ↓
segunda response.create
  ↓
tool_choice=auto + tools permitidas del tenant
  ↓
si hay tool call → ToolGateway
  ↓
function_call_output
  ↓
respuesta hablada
```

OpenAI Realtime permite que `response.create` sobrescriba `tools` y `tool_choice` para una respuesta concreta. De este modo se preserva la clasificación semántica v9 y se habilitan tools únicamente en la segunda etapa.

## 8. Próximo bloque — F3-B

Integrar `ToolGateway` en `CallSession`:

1. propagar la allowlist desde `TenantConfiguration`;
2. habilitar tools empresariales solo después de `CONTINUE`;
3. procesar tool calls mediante `ToolGateway`;
4. devolver `function_call_output` al modelo;
5. añadir logs correlacionados con `call_id`, `tenant_id`, tool, acceso y resultado;
6. mantener intacta la lógica END_AMBIGUOUS / END_CLEAR.

## 9. Gate F3 preliminar

- [x] contrato `ToolGateway` independiente de SDKs externos;
- [x] autorización por tenant fail-closed;
- [x] validación previa a ejecución;
- [x] errores estructurados;
- [x] diferenciación READ/WRITE;
- [x] pruebas contractuales iniciales 7/7 PASS;
- [ ] integración con `CallSession`/Realtime;
- [ ] allowlist derivada de `TenantConfiguration`;
- [ ] tool real de lectura E2E;
- [ ] observabilidad E2E de tool calls;
- [ ] pruebas de regresión de cierre semántico;
- [ ] documentación reconciliada al cierre.
