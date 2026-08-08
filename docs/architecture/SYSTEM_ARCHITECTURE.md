# IA_RealTime_CenterCall — System Architecture

> **Arquitectura oficial v2.1**  
> **Estado:** vigente  
> **Fecha:** 2026-08-08  
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
8. Toda operación empresarial pasa por ToolGateway.
9. GitHub es la fuente de verdad del software y documentación.
10. Desarrollo/deploy normal cloud-first mediante Cloudflare Workers Builds.
11. El carrier y la numeración no deben condicionar la lógica del Core.
12. El destino de una llamada se decide en el Control Plane mediante un `CallOrchestrator`.

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
                                  Sistemas empresariales
```

Telnyx es el proveedor telefónico inicial de FASE 0. Twilio queda como alternativa futura compatible mediante `TelephonyProvider`.

## 3. Media plane

Objetivo arquitectónico del audio una vez establecida la llamada:

```text
PSTN → Telnyx/TelephonyProvider → RealtimeProvider → Telnyx/TelephonyProvider → PSTN
```

Cloudflare, D1, MCP, ToolGateway, TenantResolver y los sistemas empresariales quedan fuera del transporte continuo de audio.

El Control Plane puede participar en señalización, bootstrap, routing y comandos de llamada sin convertirse en relay de audio.

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
- módulos de negocio;
- selección de providers;
- observabilidad;
- persistencia futura;
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

Producción multi-tenant objetivo:

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

Para OpenAI Realtime vía SIP, el destino se expresa conceptualmente como:

```text
sip:<OPENAI_PROJECT_ID>@sip.api.openai.com;transport=tls
```

El Project ID se mantiene como configuración y no se hardcodea en documentación ni lógica del dominio.

La IA no puede iniciar un saludo específico del negocio antes de completar el tenant binding.

En FASE 0 se usa un tenant fijo de desarrollo, pero se conserva el binding conceptual.

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

Aísla Telnyx, Twilio u otros carriers/Voice APIs/SIP providers. Debe encapsular, según capacidad disponible:

- recepción de eventos de llamada;
- identificación de número llamado;
- comandos de routing/dial/transfer;
- estado de llamada;
- detalles específicos de la API del carrier.

### NumberProvider

Responsabilidad separada para adquisición/portabilidad/asociación de numeración. Puede coincidir físicamente con `TelephonyProvider`, pero el Core no asume que sean el mismo proveedor.

### RealtimeProvider

Aísla OpenAI Realtime u otro proveedor de conversación realtime.

### TenantResolver

Convierte contexto de routing en `tenant_id`. Inicialmente la clave principal es `called_number`.

### RealtimeSessionConfiguration

Contrato propio e independiente del proveedor realtime. Expresa instructions/persona, voice, language, VAD, tools permitidas, políticas conversacionales y metadata de llamada/tenant.

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

## 8. Módulos de negocio

Módulos compartidos previstos:

- BusinessInformationModule;
- AppointmentModule;
- ReservationModule;
- OrderModule;
- HumanHandoffModule.

Los módulos contienen reglas reutilizables y no SDKs de terceros.

## 9. Estado de llamada

Estados principales del dominio:

```text
RECEIVED → BOOTSTRAPPING → ROUTING → ACCEPTING → ACTIVE → COMPLETED
             │               │           │           │
             └──────────────► FAILED ◄────┴───────────┘
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

## 13. Estado actual

FASE 0 en curso.

Validado/configurado:

- GitHub → Cloudflare Workers Builds;
- Worker desplegado automáticamente;
- `/health` operativo;
- OpenAI Project creado;
- OpenAI API Key creada y almacenada como secret en Cloudflare;
- webhook OpenAI `realtime.call.incoming` configurado;
- `OPENAI_WEBHOOK_SECRET` almacenado como secret en Cloudflare;
- Telnyx seleccionado como proveedor telefónico inicial;
- Voice API Application `IA-RealTime-CenterCall-F0` creada/configurada;
- configuración inbound iniciada;
- Outbound Voice Profile para Europa creado y asociado a la aplicación.

Descartado para F0:

- Twilio como carrier inicial por indisponibilidad de numeración española adecuada en el flujo probado;
- SIP Connection FQDN de Telnyx como ruta principal de esta implementación, tras evaluarla durante la configuración.

Pendiente inmediato:

- finalizar configuración de la Voice API Application;
- asociar un número +34;
- implementar webhook Telnyx en el Worker;
- ejecutar el comando/routing hacia OpenAI Realtime;
- validar `realtime.call.incoming` + `/accept`;
- primera llamada real;
- Gate F0.
