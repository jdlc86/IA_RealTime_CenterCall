# IA_RealTime_CenterCall — System Overview

> **Versión documental:** 2.0  
> **Estado:** vigente  
> **Fecha:** 2026-08-08

## 1. Qué es

IA_RealTime_CenterCall es una plataforma de atención telefónica con IA de voz en tiempo real. Un mismo despliegue puede atender múltiples negocios, cada uno asociado a uno o más números telefónicos y con su propia configuración, información, módulos y proveedores empresariales.

Ejemplo:

```text
Número A → clínica
Número B → restaurante
Número C → taller
        ↓
     mismo Core
```

## 2. Qué debe poder hacer

La plataforma debe poder:

- recibir llamadas PSTN reales;
- mantener conversación de voz natural y con interrupciones;
- resolver qué negocio ha sido llamado;
- cargar la configuración correcta de ese negocio antes del saludo;
- responder información autorizada;
- ejecutar acciones controladas como citas, reservas o pedidos;
- transferir a una persona cuando proceda;
- aislar datos, herramientas, credenciales y configuración entre tenants;
- cambiar proveedores de telefonía o IA con impacto mínimo en el dominio.

## 3. Arquitectura de alto nivel

```text
Cliente / PSTN
      │
      ▼
Proveedor telefónico (Twilio inicialmente)
      │ SIP/RTP
      ▼
OpenAI Realtime
      │
      │ tool calls / control
      ▼
Cloudflare Control Plane
      │
      ├── Call Bootstrap
      ├── TenantResolver
      ├── TenantConfiguration
      ├── RealtimeSessionConfiguration
      ├── ToolGateway
      ├── Business Modules
      └── Providers empresariales
```

**El audio no atraviesa Cloudflare.** El media path permanece directo entre telefonía y OpenAI Realtime.

## 4. Multi-tenant

El tenant se resuelve inicialmente mediante el número llamado:

```text
called_number → TenantResolver → tenant_id → TenantConfiguration
```

La personalización no debe crear forks ni variantes del programa por cliente. Se realiza con configuración, módulos y providers.

## 5. Primer vertical

La clínica es el primer vertical de validación. Debe poder consultar y gestionar citas mediante una fuente de verdad externa. Posteriormente la misma plataforma debe poder configurarse para un restaurante u otro negocio sin modificar el Core para ese cliente concreto.

## 6. Infraestructura inicial

- **GitHub:** fuente de verdad y control de versiones.
- **Cloudflare Workers Builds:** CI/CD cloud-first.
- **Cloudflare Worker:** control plane.
- **Twilio:** número, PSTN y SIP inicial.
- **OpenAI Realtime:** conversación speech-to-speech.

El ordenador local no forma parte de la arquitectura ni del flujo normal de despliegue.

## 7. Estado actual

FASE activa: **FASE 0 — Voz E2E**.

Ya validado:

- repositorio conectado a Cloudflare Workers Builds;
- despliegue automático desde GitHub;
- Worker público operativo;
- endpoint `/health` validado.

Siguiente hito: configurar secretos/OpenAI Realtime, webhook y SIP con Twilio para completar la primera llamada real.

## 8. Documentos relacionados

- Arquitectura completa: [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md)
- Reglas: [`architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md)
- FASE 0: [`implementation/PHASE_0_IMPLEMENTATION_GUIDE.md`](./implementation/PHASE_0_IMPLEMENTATION_GUIDE.md)
- Pruebas F0: [`tests/PHASE0.md`](./tests/PHASE0.md)
