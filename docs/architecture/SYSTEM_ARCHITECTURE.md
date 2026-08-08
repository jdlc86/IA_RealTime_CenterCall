# IA_RealTime_CenterCall — System Architecture

> **Arquitectura oficial v2.0**  
> **Estado:** vigente  
> **Fecha:** 2026-08-08  
> **Carácter:** normativo

Este documento es la referencia canónica de arquitectura. Si otro documento contradice este, prevalece este documento salvo ADR posterior que lo modifique explícitamente.

## 1. Principios

1. Media plane mínimo.
2. Cloudflare no transporta audio.
3. Core agnóstico al sector.
4. Multi-tenant desde el modelo de dominio.
5. Configuración por negocio, no forks por cliente.
6. Proveedores externos detrás de contratos/adaptadores.
7. El modelo conversa; los sistemas empresariales son la fuente de verdad.
8. Toda operación empresarial pasa por ToolGateway.
9. GitHub es la fuente de verdad del software y documentación.
10. Desarrollo/deploy normal cloud-first mediante Cloudflare Workers Builds.

## 2. Arquitectura física

```text
                            ┌────────────────────┐
                            │       GitHub       │
                            │ código + docs      │
                            └─────────┬──────────┘
                                      │ push
                                      ▼
                            ┌────────────────────┐
                            │ Cloudflare Builds  │
                            │ build + deploy     │
                            └─────────┬──────────┘
                                      │
                                      ▼
┌─────────────┐    PSTN/SIP    ┌────────────────────┐
│   Cliente   │◄──────────────►│ Twilio / carrier   │
└─────────────┘                 └─────────┬──────────┘
                                         │ SIP/RTP
                                         ▼
                               ┌────────────────────┐
                               │ OpenAI Realtime    │
                               │ speech-to-speech   │
                               └─────────┬──────────┘
                                         │ control/tools
                                         ▼
                               ┌────────────────────┐
                               │ Cloudflare Worker  │
                               │ Control Plane      │
                               └─────────┬──────────┘
                                         │
                 ┌───────────────────────┼──────────────────────┐
                 ▼                       ▼                      ▼
           Tenant config            ToolGateway          Observabilidad
                                         │
                                         ▼
                                Business Modules
                                         │
                                         ▼
                                Providers/Adapters
                                         │
                                         ▼
                               Sistemas empresariales
```

## 3. Media plane

Ruta oficial del audio:

```text
PSTN → TelephonyProvider/SIP → OpenAI Realtime → TelephonyProvider/SIP → PSTN
```

Cloudflare, D1, MCP, ToolGateway, TenantResolver y los sistemas empresariales quedan fuera del transporte de audio.

Cualquier cambio que añada un relay de audio requiere benchmark, justificación y ADR.

## 4. Control plane

El Control Plane vive inicialmente en Cloudflare Workers y contiene progresivamente:

- recepción/verificación de webhooks;
- Call Bootstrap;
- TenantResolver;
- carga de TenantConfiguration;
- construcción de RealtimeSessionConfiguration;
- ToolGateway;
- autorización y políticas;
- módulos de negocio;
- selección de providers;
- observabilidad;
- persistencia futura;
- handoff futuro.

## 5. Flujo de establecimiento de llamada

Producción multi-tenant:

```text
incoming call
    ↓
called_number / route
    ↓
TenantResolver
    ↓
tenant_id
    ↓
TenantConfiguration
    ↓
RealtimeSessionConfiguration
    ↓
RealtimeProvider.accept/configure
    ↓
ACTIVE
    ↓
conversación
```

La IA no puede iniciar un saludo específico del negocio antes de completar el tenant binding.

En FASE 0 se usa un tenant fijo de desarrollo, pero se conserva el binding conceptual:

```text
incoming call
    ↓
DEFAULT_TENANT_ID
    ↓
configuración F0
    ↓
RealtimeSessionConfiguration
    ↓
OpenAI accept/configure
```

## 6. Multi-tenant y personalización

Modelo inicial:

```text
Número A → tenant_id=clinica_madrid
Número B → tenant_id=restaurante_centro
```

`TenantConfiguration` contiene la configuración operativa completa:

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

`BusinessProfile` contiene información descriptiva relativamente estable. No sustituye a `TenantConfiguration`.

No se permiten condicionales de Core específicos de cliente como `if tenant === "clinica_madrid"`.

## 7. Contratos arquitectónicos

### TelephonyProvider

Aísla Twilio u otros carriers/SIP providers.

### RealtimeProvider

Aísla OpenAI Realtime u otro proveedor de conversación realtime.

### TenantResolver

Convierte contexto de routing en `tenant_id`. Inicialmente la clave principal es `called_number`.

### RealtimeSessionConfiguration

Contrato propio e independiente del proveedor realtime. Expresa, al menos:

- instructions/persona;
- voice;
- language;
- VAD;
- tools permitidas;
- políticas conversacionales;
- metadata de `call_id`/`tenant_id`.

El adaptador OpenAI traduce este contrato al payload concreto de OpenAI.

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
Provider
      ↓
External System
```

`AppointmentTool`, `ReservationTool`, etc. son implementaciones de `ToolExecutor`, no capas arquitectónicas independientes.

## 8. Módulos de negocio

Módulos compartidos previstos:

- BusinessInformationModule;
- AppointmentModule;
- ReservationModule;
- OrderModule;
- HumanHandoffModule.

Los módulos contienen reglas reutilizables y no SDKs de terceros.

Ejemplo:

```text
AppointmentTool
    ↓
AppointmentModule
    ↓
AppointmentProvider
    ↓
Agenda externa
```

`AppointmentModule` usa conceptos genéricos como `service`, `resource`, `slot`, `customer` y `appointment`; no conceptos clínicos obligatorios como `doctor` o `patient`.

## 9. Estado de llamada

Estados principales del dominio:

```text
RECEIVED → BOOTSTRAPPING → ACCEPTING → ACTIVE → COMPLETED
             │                 │           │
             └──────────────► FAILED ◄─────┘
                                         │
ACTIVE → HANDOFF → COMPLETED / FAILED
```

Estados conversacionales derivados durante ACTIVE:

`LISTENING · THINKING · SPEAKING · TOOL_WAIT · INTERRUPTED`

## 10. Seguridad y aislamiento

- secretos nunca en Git;
- tenant derivado de routing confiable, no del texto libre del caller/modelo;
- tools autorizadas por tenant;
- credenciales/providers aislados por tenant;
- logs con redacción de datos sensibles;
- pruebas cross-tenant obligatorias;
- el modelo nunca decide permisos;
- ninguna operación WRITE se confirma sin resultado válido del sistema fuente.

## 11. Arquitectura de desarrollo y despliegue

```text
GitHub main
   ↓
Cloudflare Workers Builds
   ↓
instalación dependencias
   ↓
wrangler deploy
   ↓
Worker público
```

El ordenador local es opcional y no forma parte del flujo normal de operación o despliegue.

Worker actual:

```text
ia-realtime-centercall
https://ia-realtime-centercall.julopezcardona.workers.dev
```

## 12. Fases

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
F5 Persistencia/post-call
  ↓
F6 Handoff humano
  ↓
F7 Concurrencia
  ↓
F8 Hardening producción
```

Los detalles operativos viven en `docs/implementation/` y la evidencia de gates en `docs/tests/`.

## 13. Estado actual

FASE 0 en curso.

Validado:

- GitHub → Cloudflare Workers Builds;
- Worker desplegado automáticamente;
- `/health` operativo;
- nombre de Worker alineado con Cloudflare;
- `workers_dev` y `preview_urls` declarados explícitamente.

Pendiente inmediato:

- OPENAI_API_KEY como secreto;
- webhook OpenAI;
- OPENAI_WEBHOOK_SECRET;
- SIP OpenAI ↔ Twilio;
- primera llamada real;
- Gate F0.
