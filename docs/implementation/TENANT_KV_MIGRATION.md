# Migración de TenantConfiguration a Cloudflare KV

> Estado: EN CURSO
> Fecha: 2026-08-09
> Alcance: configuración operativa multi-negocio
> Fuente arquitectónica: `docs/architecture/SYSTEM_ARCHITECTURE.md`

## 1. Objetivo

Eliminar progresivamente la configuración específica de negocios embebida en TypeScript y moverla a Cloudflare Workers KV sin interrumpir las llamadas existentes.

Separación objetivo:

```text
Worker / código
  -> lógica común

Cloudflare KV / TENANT_CONFIG
  -> routing de números a tenant
  -> configuración operativa de cada tenant

Cloudflare Secrets
  -> secretos privados de infraestructura

Supabase
  -> estado empresarial cambiante: pacientes, citas, agenda, servicios, etc.
```

## 2. Principio multi-tenant

No existe una clave global `current_tenant` ni un tenant por defecto que pueda absorber tráfico de otros negocios.

Cada negocio tiene una configuración independiente y cada ruta telefónica apunta explícitamente a un `tenant_id`.

```text
+34910789057
  -> clinica-estetica-madrid
  -> configuración Clínica Estética Madrid

+34XXXXXXXXX
  -> restaurante-centro
  -> configuración Restaurante Centro
```

Un número desconocido debe fallar cerrado.

## 3. Namespace

Binding del Worker:

```text
TENANT_CONFIG
```

En desarrollo y producción se usarán namespaces separados aunque el binding conserve el mismo nombre.

Cloudflare permite enlazar un namespace KV mediante `wrangler.jsonc`. Durante la migración el binding se provisiona antes de activar KV como fuente de verdad.

## 4. Esquema de claves v1

Prefijo estable:

```text
ia-rtcc:v1
```

### Ruta telefónica

```text
ia-rtcc:v1:route:phone:<E164>
```

Ejemplo:

```text
ia-rtcc:v1:route:phone:+34910789057
```

Valor:

```json
{
  "schemaVersion": 1,
  "tenantId": "clinica-estetica-madrid",
  "status": "active"
}
```

### Configuración del tenant

```text
ia-rtcc:v1:tenant:<tenant_id>
```

Ejemplo:

```text
ia-rtcc:v1:tenant:clinica-estetica-madrid
```

Valor inicial:

```json
{
  "schemaVersion": 1,
  "tenantId": "clinica-estetica-madrid",
  "status": "active",
  "business": {
    "displayName": "Clínica Estética Madrid",
    "facts": {
      "years_in_operation": 20
    }
  },
  "assistant": {
    "name": "Carolina",
    "greeting": "Buenas, soy Carolina, asistente virtual de la Clínica Estética Madrid. ¿En qué puedo ayudarte?",
    "language": "es-ES"
  },
  "realtime": {
    "voice": "marin",
    "vad": {
      "threshold": 0.5,
      "prefixPaddingMs": 300,
      "silenceDurationMs": 500,
      "idleTimeoutMs": 10000
    }
  },
  "tools": {
    "allowed": ["get_business_information"]
  }
}
```

Los datos de `business.facts` son extensibles por negocio. No deben usarse para información transaccional como citas o pacientes.

## 5. Validación

`apps/control-plane/src/tenant-kv.ts` define:

- normalización del número llamado;
- generación de keys;
- validación de `schemaVersion`;
- validación de `tenantId` esperado;
- estado `active/disabled`;
- allowlist sin duplicados;
- fail-closed ante rutas desconocidas, tenants inexistentes o payload inválido;
- repositorio `KvTenantRepository`.

La configuración cargada para `tenant-a` no puede declarar internamente `tenant-b`.

## 6. Estrategia de migración sin caída

La migración se hace en dos etapas.

### Etapa A — infraestructura y carga

1. provisionar binding `TENANT_CONFIG`;
2. desplegar sin cambiar todavía la fuente activa;
3. cargar ruta y configuración de `clinica-estetica-madrid`;
4. validar lectura y estructura;
5. ejecutar pruebas multi-tenant/negativas.

Durante esta etapa:

```text
TENANT_CONFIG_SOURCE=static
```

El sistema telefónico continúa utilizando la configuración existente.

### Etapa B — cutover

1. integrar `KvTenantRepository` en TenantResolver/Call Bootstrap;
2. eliminar la dependencia de configuración estática dentro de `CallSession`;
3. cambiar `TENANT_CONFIG_SOURCE=kv`;
4. comprobar `/health` y una llamada real;
5. probar número desconocido;
6. probar segundo negocio;
7. retirar `TENANT_ROUTES_JSON`, `DEFAULT_TENANT_ID` y el mapa TypeScript de tenants.

No se elimina el origen anterior antes de verificar KV en producción.

## 7. Orden seguro al crear un negocio

Para evitar una ruta que apunte temporalmente a un tenant inexistente:

```text
1. escribir tenant config
2. validar tenant config
3. escribir route:phone
4. validar resolución
5. habilitar número
```

Para retirar un negocio:

```text
1. desactivar route
2. confirmar que no entra tráfico nuevo
3. desactivar tenant
4. conservar/auditar datos según política
```

## 8. Consistencia de KV

Workers KV está optimizado para lecturas frecuentes y escrituras infrecuentes. Es eventualmente consistente: una modificación puede tardar en propagarse a otros puntos de presencia.

Para configuración se adopta inicialmente `cacheTtl=30` segundos. Por tanto:

- un cambio administrativo no se considera instantáneo globalmente;
- una llamada ya iniciada conserva su configuración de bootstrap;
- modificaciones críticas de routing se realizan de forma controlada;
- no se usa KV para citas, locks, contadores transaccionales ni operaciones que requieran atomicidad.

## 9. Segundo negocio de validación

Antes de cerrar la migración se creará un tenant sintético distinto, por ejemplo:

```text
restaurante-centro
```

Debe tener:

- número/ruta diferente;
- nombre comercial diferente;
- asistente diferente;
- greeting diferente;
- facts diferentes;
- allowlist independiente.

Gate mínimo:

```text
Número clínica -> solo clínica
Número restaurante -> solo restaurante
Número desconocido -> rechazo
Tenant A nunca puede leer configuración de Tenant B
```

## 10. Secretos

Nunca se almacenan en `TENANT_CONFIG`:

- `OPENAI_API_KEY`;
- `OPENAI_WEBHOOK_SECRET`;
- `TELNYX_API_KEY`;
- credenciales privilegiadas de Supabase;
- claves de firma/autenticación de la plataforma.

Esas credenciales permanecen en Cloudflare Secrets.

## 11. Gate de migración KV

- [x] esquema de keys multi-tenant definido;
- [x] parser/validador v1 implementado;
- [x] `KvTenantRepository` implementado;
- [x] tests contractuales multi-tenant añadidos;
- [x] binding `TENANT_CONFIG` declarado;
- [x] modo de transición conserva origen estático;
- [ ] namespace provisionado por deploy confirmado;
- [ ] claves de Clínica Estética Madrid cargadas;
- [ ] lectura KV validada en Worker;
- [ ] Call Bootstrap migrado a KV;
- [ ] CallSession desacoplado del mapa estático;
- [ ] segundo negocio E2E validado;
- [ ] número desconocido E2E fail-closed;
- [ ] origen estático eliminado.
