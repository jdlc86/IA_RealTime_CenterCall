# IA_RealTime_CenterCall — visión del sistema

> Estado: vigente
> Última revisión: 2026-08-22

## Producto

Plataforma multi-tenant de atención telefónica con IA de voz en tiempo real. El runtime actual atiende el vertical restaurante: información, reservas, consentimiento, handoff inclusivo, cierre natural y protección frente a abuso.

## Topología actual

```text
Caller/PSTN
  ↕
Telnyx ── SIP/RTP ── OpenAI Realtime
  │                     ↕ control + tools
  └── webhooks ── Cloudflare Worker + CallSession Durable Object
                         │
                         ├── TENANT_CONFIG (KV)
                         ├── ports/runtimes neutrales
                         └── Supabase (estado empresarial y diagnóstico redactado)
```

Cloudflare es control plane y no retransmite audio continuo. OpenAI es el único realtime provider activo. Telnyx es el carrier actual; Twilio permanece como integración alternativa/futura mediante fronteras de telefonía.

## Responsabilidades

- `CallSession`/runtimes: lifecycle, turn ownership, respuesta activa, herramientas y liveness de una llamada.
- `TenantConfiguration`: comportamiento y capacidades autorizadas del negocio.
- Ports/adapters: traducción de OpenAI, Telnyx y Supabase en el borde.
- Supabase: reservas, concurrencia, estado empresarial y trazas técnicas redactadas.
- Modelo: comprensión y expresión conversacional natural dentro de permisos y herramientas autorizadas.
- Código determinista: seguridad, autorización, validación, idempotencia, confirmaciones, concurrencia y transiciones de lifecycle.

## Invariantes visibles

- El saludo inicial es atómico; ruido o voz solapada no lo interrumpen.
- Un turno admite una autoridad semántica y una respuesta activa.
- Ninguna reserva se afirma sin éxito del backend y confirmación vigente.
- La capacidad simultánea se adjudica al confirmar en PostgreSQL.
- Las necesidades especiales se ofrecen a handoff con lenguaje inclusivo.
- Extracción de prompt/manipulación de instrucciones se trata como incidente de seguridad.
- La trazabilidad conserva solo texto redactado, estados, tools y decisiones durante una retención corta.

## Dónde profundizar

- Arquitectura: [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md)
- Reglas: [`architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md)
- Estado operativo: [`PROJECT_STATUS.md`](./PROJECT_STATUS.md)
- Relevo: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md)
