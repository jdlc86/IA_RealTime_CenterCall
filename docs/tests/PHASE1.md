# Test Plan / Evidence — FASE 1

> Estado: EN CURSO  
> Fecha de evidencia inicial: 2026-08-09

## TenantResolver — pruebas contractuales simuladas

Se añadieron pruebas reproducibles contra el módulo real `apps/control-plane/src/tenant-resolver.ts`.

Comando del repositorio:

```bash
cd apps/control-plane
npm test
```

El runner compila únicamente `tenant-resolver.ts` a `.test-dist/` mediante TypeScript y ejecuta las pruebas con `node:test`. No requiere Telnyx, OpenAI ni una llamada PSTN.

### Casos ejecutados

| Test | Caso | Resultado esperado | Resultado |
|---|---|---|---|
| F1-T01 | número conocido `+34910789057` | `clinica-estetica-madrid` | PASS |
| F1-T02 | número con caracteres de presentación `+34 910 789 057` | normaliza y resuelve `clinica-estetica-madrid` | PASS |
| F1-T03 | número desconocido `+34999999999` | `null`, sin fallback | PASS |
| F1-T03b | número vacío/inválido | `null`, fail-closed | PASS |
| F1-T04 | dos rutas que normalizan al mismo número | error de configuración | PASS |
| Parser-01 | `TENANT_ROUTES_JSON` válido | mapea a rutas de dominio | PASS |
| Parser-02 | JSON inválido o tenant ausente | error explícito | PASS |

### Resultado de ejecución

```text
1..7
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
```

**Resultado global:** PASS — 7/7.

## Invariante de seguridad validada

La prueba negativa principal confirma:

```text
called_number = +34999999999
→ StaticTenantResolver.resolve(...)
→ null
```

No ocurre:

```text
número desconocido
→ clinica-estetica-madrid
```

Por tanto, a nivel contractual de `TenantResolver`, no existe fallback accidental al tenant de la Clínica Estética Madrid.

## Alcance de esta evidencia

Esta evidencia valida el contrato y comportamiento puro de `TenantResolver` y su parser de configuración. No sustituye una prueba E2E de un número realmente desconocido entrando por Telnyx. El `CallOrchestrator` ya está diseñado para convertir una resolución `null` en rechazo controlado de la llamada; ese comportamiento E2E puede verificarse posteriormente si se dispone de una ruta de prueba adecuada.

## Archivos

```text
apps/control-plane/src/tenant-resolver.ts
apps/control-plane/src/tenant-resolver.test.mjs
apps/control-plane/package.json
```
