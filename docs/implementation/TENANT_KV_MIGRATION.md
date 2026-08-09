# Migración de TenantConfiguration a Cloudflare KV

> Estado: CUTOVER COMPLETADO — VALIDACIÓN MULTI-NEGOCIO PENDIENTE
> Fecha: 2026-08-09
> Alcance: configuración operativa multi-negocio
> Fuente arquitectónica: `docs/architecture/SYSTEM_ARCHITECTURE.md`

## 1. Objetivo

Eliminar la configuración específica de negocios embebida en TypeScript y usar Cloudflare Workers KV como única fuente activa de configuración de tenant y routing telefónico, sin interrumpir las llamadas existentes.

Separación vigente:

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

No existe una clave global `current_tenant`, un `DEFAULT_TENANT_ID` ni un fallback que pueda absorber tráfico de otros negocios.

Cada negocio tiene una configuración independiente y cada ruta telefónica apunta explícitamente a un `tenant_id`.

```text
+34910789057
  -> clinica-estetica-madrid
  -> configuración Clínica Estética Madrid

+34XXXXXXXXX
  -> otro-negocio
  -> configuración independiente
```

Un número desconocido debe fallar cerrado.

## 3. Namespace

Binding del Worker:

```text
TENANT_CONFIG
```

Namespace físico usado actualmente:

```text
ia-realtime-centercall-tenant-config
```

El Worker consume el binding y no conoce ni depende del nombre físico del namespace.

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

Valor validado:

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

`business.facts` contiene datos configuracionales relativamente estables. No se utiliza para pacientes, citas, agenda, tratamientos/servicios operativos ni otra información transaccional; esos datos pertenecen al plano empresarial persistente en Supabase.

## 5. Implementación activa

`apps/control-plane/src/tenant-kv.ts` define:

- normalización del número llamado;
- generación de keys;
- validación de `schemaVersion`;
- validación de `tenantId` esperado;
- estado `active/disabled`;
- allowlist sin duplicados;
- fail-closed ante rutas desconocidas, tenants inexistentes o payload inválido;
- repositorio `KvTenantRepository`.

El bootstrap Telnyx resuelve `called_number -> tenant_id` mediante KV. El webhook de OpenAI vuelve a validar la asociación `called_number -> tenant_id` antes de aceptar la configuración y arrancar `CallSession`.

`CallSession` no consulta ningún mapa TypeScript de tenants. Recibe por bootstrap los datos autorizados necesarios para la llamada, incluidos `business_facts` y `allowed_tools`.

## 6. Cutover realizado

La transición se ejecutó de forma segura:

```text
1. binding TENANT_CONFIG provisionado
2. configuración y ruta de la clínica cargadas
3. lectura KV validada en /health
4. llamada real validada manteniendo origen anterior
5. KvTenantRepository conectado al bootstrap
6. CallSession desacoplado del mapa estático
7. KV activado como fuente real
8. llamada real posterior al cutover validada
9. saludo de Carolina correcto
10. get_business_information devolvió years_in_operation=20
11. cierre de llamada conservó funcionamiento
12. origen estático retirado
```

Se eliminaron del runtime/configuración:

- `DEFAULT_TENANT_ID`;
- `TENANT_ROUTES_JSON`;
- `TENANT_CONFIG_SOURCE`;
- `TENANT_KV_VALIDATED`;
- `tenant-configuration.ts` y su mapa `TENANTS`;
- `StaticTenantResolver`;
- tests del resolver estático;
- wrapper temporal de diagnóstico KV.

`wrangler.jsonc` vuelve a apuntar directamente a `src/index.ts`.

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

Workers KV se utiliza únicamente para configuración de lectura frecuente y escritura infrecuente. Es eventualmente consistente, por lo que:

- un cambio administrativo no se considera instantáneo globalmente;
- una llamada ya iniciada conserva su configuración de bootstrap;
- modificaciones críticas de routing se realizan de forma controlada;
- no se usa KV para citas, locks, contadores transaccionales ni operaciones que requieran atomicidad.

El repositorio utiliza inicialmente `cacheTtl=30` segundos.

## 9. Validación multi-negocio pendiente

Antes de cerrar F4 se creará un segundo tenant sintético o de prueba, por ejemplo:

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

Gate:

```text
Número clínica -> solo clínica
Número negocio B -> solo negocio B
Número desconocido -> rechazo
Tenant A nunca puede leer configuración de Tenant B
```

Las pruebas contractuales KV ya cubren aislamiento y fail-closed en código; faltan las pruebas E2E sobre infraestructura real para cerrar el gate.

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
- [x] namespace provisionado confirmado;
- [x] claves de Clínica Estética Madrid cargadas;
- [x] lectura KV validada en Worker;
- [x] Call Bootstrap migrado a KV;
- [x] CallSession desacoplado del mapa estático;
- [x] llamada real post-cutover validada;
- [x] origen estático eliminado;
- [ ] segundo negocio E2E validado;
- [ ] número desconocido E2E fail-closed validado.
