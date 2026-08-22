# IA_RealTime_CenterCall — System Architecture

> **Arquitectura oficial v2.3**
> **Estado:** vigente
> **Última revisión:** 2026-08-22
> **Carácter:** normativo

Este documento es la referencia canónica de arquitectura. Si otro documento contradice este, prevalece este documento salvo ADR posterior que lo modifique explícitamente.

## 1. Principios

1. Media plane mínimo.
2. Cloudflare no transporta audio.
3. Core/Conversation Platform agnóstico al sector.
4. Multi-tenant desde el modelo de dominio.
5. Configuración por negocio, no forks por cliente.
6. Proveedores externos detrás de contratos/adaptadores.
7. El modelo conversa; los sistemas empresariales son la fuente de verdad.
8. Toda operación empresarial originada por el modelo pasa por ToolGateway.
9. GitHub es la fuente de verdad del software y documentación.
10. Desarrollo/deploy normal cloud-first mediante Cloudflare Workers Builds.
11. El carrier y la numeración no deben condicionar la lógica del Core.
12. El destino de una llamada se decide en el Control Plane mediante un `CallOrchestrator`.
13. Cloudflare mantiene configuración operativa rápida de la conversación; Supabase mantiene el estado empresarial cambiante y persistente.
14. La app de negocio y Carolina comparten la misma fuente de verdad empresarial, pero obtienen `tenant_id` por mecanismos de confianza diferentes.
15. Ninguna credencial maestra del negocio se usa como credencial directa de Supabase ni se expone una `service_role` en clientes.

## 2. Arquitectura física

```text
                            ┌────────────────────┐
                            │       GitHub       │
                            │ código + docs      │
                            └─────────┬──────────┘
                                      │ push
                                      ▼
                            ┌────────────────────┐
                            │ CI + Deploy gate   │
                            │ SHA exacto         │
                            └─────────┬──────────┘
                                      │
                                      ▼
┌─────────────┐      PSTN       ┌──────────────────────┐
│   Cliente   │◄───────────────►│ Telnyx               │
└─────────────┘                  │ Number + Voice API   │
                                 └──────────┬───────────┘
                                            │ webhook de control
                                            ▼
                                 ┌──────────────────────┐
                                 │ Cloudflare Worker    │
                                 │ Conversation Platform│
                                 │ + CallOrchestrator   │
                                 └──────────┬───────────┘
                                            │ decide routing
                                            ▼
                                 ┌──────────────────────┐
                                 │ OpenAI Realtime      │
                                 │ speech-to-speech     │
                                 └──────────┬───────────┘
                                            │
                 ┌──────────────────────────┼──────────────────────┐
                 ▼                          ▼                      ▼
           Tenant config               ToolGateway          Observabilidad
                                            │
                                            ▼
                                   Business Modules
                                            │
                                            ▼
                                   Providers/Adapters
                                            │
                                            ▼
                                   Supabase / sistemas
                                      empresariales
```

La futura app web/escritorio accede al mismo estado empresarial mediante una API autenticada de la plataforma, no mediante credenciales privilegiadas embebidas en el cliente.

Telnyx es el proveedor telefónico inicial. Twilio queda como alternativa futura compatible mediante `TelephonyProvider`.

## 3. Media plane

Objetivo arquitectónico del audio una vez establecida la llamada:

```text
PSTN → Telnyx/TelephonyProvider → RealtimeProvider → Telnyx/TelephonyProvider → PSTN
```

Cloudflare, bases de datos, ToolGateway, TenantResolver y sistemas empresariales quedan fuera del transporte continuo de audio. El Control Plane puede participar en señalización, bootstrap, routing y comandos de llamada sin convertirse en relay de audio.

Cualquier cambio que añada un relay de audio requiere benchmark, justificación y ADR.

## 4. Control plane y CallOrchestrator

El Control Plane vive inicialmente en Cloudflare Workers y contiene progresivamente:

- recepción/verificación de webhooks de Telnyx y OpenAI;
- `CallOrchestrator`;
- Call Bootstrap;
- TenantResolver;
- carga de TenantConfiguration;
- construcción de RealtimeSessionConfiguration;
- selección del destino realtime/humano;
- ToolGateway;
- autorización y políticas;
- autenticación/autorización de la futura app;
- módulos de negocio;
- selección de providers;
- observabilidad;
- handoff futuro.

### CallOrchestrator

Responsabilidad: decidir el destino y bootstrap de una llamada usando contexto confiable de telefonía y tenant.

```text
Telnyx webhook
    ↓
CallOrchestrator
    ↓
TenantResolver
    ↓
TenantConfiguration
    ↓
RoutingDecision
    ├── OpenAI Realtime
    ├── otro RealtimeProvider
    ├── HumanHandoff
    └── fallback/terminate
```

El `CallOrchestrator` no contiene lógica específica de clínica/restaurante ni reglas empresariales de citas/reservas.

## 5. Flujo de establecimiento de llamada

```text
incoming PSTN call
    ↓
Telnyx Voice API event
    ↓
Cloudflare / CallOrchestrator
    ↓
called_number / route
    ↓
TenantResolver
    ↓
tenant_id
    ↓
TenantConfiguration
    ↓
RoutingDecision
    ↓
RealtimeSessionConfiguration
    ↓
RealtimeProvider
    ↓
ACTIVE
```

Para OpenAI Realtime vía SIP, el destino se expresa conceptualmente como `sip:<OPENAI_PROJECT_ID>@sip.api.openai.com;transport=tls`. El Project ID se mantiene como configuración y no se hardcodea en documentación ni lógica del dominio.

La IA no puede iniciar un saludo específico del negocio antes de completar el tenant binding.

## 6. Multi-tenant y personalización

Modelo inicial:

```text
Número A → tenant_id=clinica_madrid
Número B → tenant_id=restaurante_centro
```

`TenantConfiguration` contiene configuración operativa de conversación:

```text
TenantConfiguration
├── tenant_id
├── BusinessProfile
├── instructions/persona
├── idioma/voz/VAD
├── módulos habilitados
├── permisos de tools
├── providers
├── telefonía
└── handoff
```

`BusinessProfile` contiene información descriptiva relativamente estable. No sustituye a `TenantConfiguration` ni a la base empresarial. Pacientes, citas, reservas, agenda y otros datos transaccionales no pertenecen a `TenantConfiguration`.

No se permiten condicionales de Core específicos de cliente como `if tenant === "clinica_madrid"`.

## 7. Separación de datos: Cloudflare y Supabase

### 7.1 Cloudflare: plano de ejecución/configuración rápida

Cloudflare conserva la información necesaria para establecer y gobernar la conversación con baja latencia:

- `tenant_id` y routing;
- identidad/nombre del negocio;
- nombre y persona del asistente;
- prompt/instructions;
- voz, idioma y VAD;
- tools y módulos autorizados;
- providers y políticas;
- configuración de telefonía/handoff;
- estado efímero de llamada y control cuando corresponda.

Principio: **Cloudflare sabe cómo debe funcionar el negocio durante la conversación.**

### 7.2 Supabase PostgreSQL: estado empresarial persistente

Supabase es la persistencia empresarial inicial seleccionada, detrás de contratos/adaptadores. Contendrá progresivamente:

```text
tenants / referencias empresariales persistentes
patients
services
professionals
schedules
appointments
reservations (cuando aplique)
business operational data
audit_events / trazabilidad empresarial según diseño posterior
```

Todas las entidades multi-tenant que corresponda incluyen `tenant_id`. El aislamiento se aplica en la API/módulos y adicionalmente mediante políticas de base de datos/RLS cuando proceda.

Principio: **Supabase sabe cuál es el estado actual del negocio.**

No se introduce Supabase en el camino crítico de bootstrap de voz salvo necesidad arquitectónica posterior explícitamente justificada.

### 7.3 Fuente de verdad compartida

Carolina y la futura app leen/escriben el mismo estado empresarial:

```text
Carolina / Realtime                    App web/escritorio
       │                                      │
       ▼                                      ▼
 ToolGateway                           Platform API/Auth
       │                                      │
       └──────────────┬───────────────────────┘
                      ▼
               Business Modules
                      ↓
               SupabaseAdapter
                      ↓
            Supabase PostgreSQL
```

Una modificación confirmada por la app debe ser visible posteriormente para Carolina y viceversa.

## 8. Identidad de tenant y credencial maestra de la app

La llamada y la app obtienen el tenant mediante raíces de confianza distintas:

```text
LLAMADA
called_number/routing confiable
→ TenantResolver
→ tenant_id

APP
credencial maestra del negocio
→ Authentication Service / Platform API
→ tenant_id autenticado
→ sesión/token de corta duración
```

### Tarjeta maestra

Al cliente se le podrá entregar una tarjeta maestra con una credencial secreta de alta entropía asociada al negocio. Esa credencial sirve para demostrar identidad ante la plataforma, **no como contraseña directa de Supabase**.

Flujo objetivo:

```text
Tarjeta maestra / App
        ↓ credencial
Cloudflare Authentication Service
        ↓ validación + tenant binding
sesión/token corto
        ↓
App API
        ↓ autorización por tenant/scope
Business Modules
        ↓
SupabaseAdapter
        ↓
Supabase
```

El token de sesión puede expresar `tenant_id`, identidad de usuario/dispositivo, scopes/permisos y expiración. La credencial maestra debe poder revocarse y rotarse. No se almacena en texto plano; se almacena/verifica mediante representación criptográfica apropiada. Las credenciales privilegiadas de Supabase permanecen exclusivamente en backend.

La tarjeta maestra es bootstrap/autenticación fuerte del negocio, no autorización ilimitada permanente. En fases posteriores podrán añadirse usuarios, roles, dispositivos y MFA sin alterar el modelo de tenant.

## 9. Contratos arquitectónicos

### TelephonyProvider
Aísla Telnyx, Twilio u otros carriers/Voice APIs/SIP providers.

### NumberProvider
Responsabilidad separada para adquisición/portabilidad/asociación de numeración.

### RealtimeProvider
Aísla OpenAI Realtime u otro proveedor de conversación realtime.

### TenantResolver
Convierte contexto de routing confiable en `tenant_id`. Inicialmente la clave principal es `called_number`.

### RealtimeSessionConfiguration
Contrato independiente del proveedor realtime. Expresa persona, voice, language, VAD, tools permitidas, políticas conversacionales y metadata de llamada/tenant.

### ToolGateway
Frontera única desde el modelo hacia acciones empresariales.

```text
Model tool call
      ↓
ToolGateway
      ↓
ToolExecutor
      ↓
Business Module
      ↓
Provider/Adapter
      ↓
Supabase / External System
```

### SupabaseAdapter
Aísla PostgreSQL/Supabase de los módulos de dominio. Los módulos no dependen directamente del SDK de Supabase. Permite sustituir el sistema fuente sin reescribir `CallSession`, ToolGateway o reglas de negocio.

### Platform API / App Authentication
Frontera de acceso para la futura app. Convierte una identidad autenticada en contexto de tenant y scopes autorizados. La app nunca elige libremente un `tenant_id` para ampliar acceso.

## 10. Módulos de negocio

Módulos compartidos previstos:

- BusinessInformationModule;
- PatientModule;
- AppointmentModule;
- ReservationModule;
- OrderModule;
- HumanHandoffModule.

Los módulos contienen reglas reutilizables y no SDKs de terceros. Tanto ToolGateway como Platform API reutilizan estos módulos cuando realizan la misma operación empresarial, evitando dos implementaciones divergentes de citas/pacientes.

## 11. Estado de llamada

Estados principales:

```text
RECEIVED → BOOTSTRAPPING → ROUTING → ACCEPTING → ACTIVE → COMPLETED
             │               │           │           │
             └──────────────► FAILED ◄────┴───────────┘
ACTIVE → HANDOFF → COMPLETED / FAILED
```

Estados conversacionales derivados durante ACTIVE:

`LISTENING · THINKING · SPEAKING · TOOL_WAIT · INTERRUPTED`

## 12. Seguridad y aislamiento

- secretos nunca en Git;
- tenant de llamada derivado de routing confiable, no del texto libre del caller/modelo;
- tenant de app derivado de autenticación validada, no de un campo libre enviado por el cliente;
- tools autorizadas por tenant;
- credenciales/providers aislados por tenant;
- todas las consultas empresariales deben quedar acotadas al tenant;
- RLS/controles de base de datos como defensa adicional, no única barrera;
- ninguna `service_role` o secreto backend de Supabase en app web/escritorio;
- credencial maestra revocable y rotatable; no texto plano en persistencia;
- tokens/sesiones de app de duración limitada y con scopes;
- logs con redacción de datos sensibles;
- pruebas cross-tenant obligatorias para voz, API y persistencia;
- el modelo nunca decide permisos;
- ninguna operación WRITE se confirma sin resultado válido del sistema fuente;
- minimizar datos personales/sanitarios hasta definir controles de privacidad y necesidad real.

## 13. Arquitectura de desarrollo y despliegue

```text
rama publicada + PR
   ↓
CI del SHA exacto: tests + Workers runtime + dry-runs
   ↓
Workers Builds o Wrangler autorizado
   ↓
versión Cloudflare
   ↓
promoción verificada al porcentaje de tráfico esperado
   ↓
health/version + E2E cuando el cambio afecta voz/event ordering
```

El mecanismo de despliegue no cambia la fuente de verdad: producción debe corresponder a un SHA publicado en GitHub. Una versión subida al histórico no está desplegada hasta que recibe tráfico.

La app web/escritorio tendrá su propio pipeline de build/release definido en su fase específica.

## 14. Fases

```text
F0 Voz E2E
  ↓
F1 Baseline + observabilidad + TenantResolver
  ↓
F2 Latencia + barge-in
  ↓
F3 ToolGateway
  ↓
F4 Clínica + validación multi-negocio
  ↓
F5 Persistencia empresarial + Supabase + post-call
  ↓
F6 Handoff humano
  ↓
F7 Concurrencia
  ↓
F8 Hardening producción
  ↓
F9 App de gestión web/escritorio
```

### F9 — App de gestión web/escritorio

Objetivo: entregar al negocio una interfaz de gestión que comparta la misma fuente de verdad que los asistentes de voz.

Alcance previsto:

- autenticación/bootstrap mediante tarjeta maestra;
- intercambio seguro por sesión/token corto;
- revocación/rotación de credenciales;
- usuarios/roles posteriores sin romper tenant binding;
- consulta y edición de pacientes según permisos;
- agenda, servicios, profesionales y citas;
- altas/cambios/cancelaciones mediante Platform API;
- actualización consistente con las operaciones realizadas por Carolina;
- aislamiento multi-tenant y pruebas negativas/cross-tenant;
- auditoría de operaciones sensibles;
- experiencia web y, si se confirma, empaquetado de escritorio sobre la misma API.

La app no accede con credenciales privilegiadas directamente a Supabase. La lógica empresarial reutiliza los mismos Business Modules/contratos del backend.

**Dependencia:** aunque F9 sea la fase de producto de la app, F4/F5 deben diseñar desde ahora contratos y esquema de datos reutilizables por ella. No se pospone el diseño correcto de API/dominio hasta F9.

## 15. Estado actual

El restaurante es el vertical activo en producción. ToolGateway, persistencia Supabase, handoff, concurrencia y hardening están implementados en distintos grados; el estado verificable y la próxima E2E viven únicamente en [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md). OpenAI continúa como único realtime provider activo.
