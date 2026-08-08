# Architecture Decision Records

Los ADR registran decisiones arquitectónicas aceptadas. La arquitectura vigente se resume en `../architecture/SYSTEM_ARCHITECTURE.md`.

## Índice vigente

- ADR-001 — Speech-to-speech nativo.
- ADR-002 — Direct SIP.
- ADR-003 — Cloudflare como Control Plane.
- ADR-004 — MCP fuera del audio path.
- ADR-005 — FASE 0 voz E2E primero.
- ADR-006 — Independencia de proveedores.
- ADR-007 — Twilio como carrier inicial.
- ADR-008 — Core agnóstico al negocio.
- ADR-009 — Tenant + Module/Provider.
- ADR-010 — Número llamado como resolución inicial de tenant.
- ADR-011 — Call Bootstrap + Tenant Binding.
- ADR-012 — `RealtimeSessionConfiguration` independiente del proveedor.
- ADR-013 — Lifecycle de llamada del dominio.
- ADR-014 — Desarrollo y despliegue cloud-first.

## ADR-014 — Desarrollo y despliegue cloud-first

- **Estado:** Accepted.
- **Problema:** depender de un PC local añade configuración manual, divergencias y un punto operativo innecesario.
- **Decisión:** GitHub es la fuente de verdad y Cloudflare Workers Builds realiza build/deploy desde el repositorio. El entorno local es opcional.
- **Motivación:** reproducibilidad, menor fricción y capacidad de trabajar desde navegador.
- **Consecuencias:** configuración de build, secretos y observabilidad deben ser administrables desde servicios cloud; cambios manuales en el editor de Cloudflare deben reconciliarse en GitHub.
- **Alternativas descartadas:** PC local como mecanismo obligatorio de build/deploy; edición directa en Cloudflare como fuente de verdad.

Los ADR 001–013 proceden de la especificación v1.6 y se irán materializando en archivos individuales cuando necesiten evolución. No se modifica una decisión aceptada únicamente editando este índice: cualquier cambio sustantivo requiere un ADR nuevo o superseding.
