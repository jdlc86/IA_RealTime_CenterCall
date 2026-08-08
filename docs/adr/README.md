# Architecture Decision Records

Los ADR registran decisiones arquitectónicas aceptadas. La arquitectura vigente se resume en `../architecture/SYSTEM_ARCHITECTURE.md`.

## Índice vigente

- ADR-001 — Speech-to-speech nativo.
- ADR-002 — Direct SIP.
- ADR-003 — Cloudflare como Control Plane.
- ADR-004 — MCP fuera del audio path.
- ADR-005 — FASE 0 voz E2E primero.
- ADR-006 — Independencia de proveedores.
- ADR-007 — Twilio como carrier inicial. **Superseded por ADR-015 para FASE 0.**
- ADR-008 — Core agnóstico al negocio.
- ADR-009 — Tenant + Module/Provider.
- ADR-010 — Número llamado como resolución inicial de tenant.
- ADR-011 — Call Bootstrap + Tenant Binding.
- ADR-012 — `RealtimeSessionConfiguration` independiente del proveedor.
- ADR-013 — Lifecycle de llamada del dominio.
- ADR-014 — Desarrollo y despliegue cloud-first.
- ADR-015 — Telnyx como proveedor telefónico inicial de FASE 0.
- ADR-016 — CallOrchestrator en el Control Plane.
- ADR-017 — Separación conceptual NumberProvider / TelephonyProvider.

## ADR-014 — Desarrollo y despliegue cloud-first

- **Estado:** Accepted.
- **Problema:** depender de un PC local añade configuración manual, divergencias y un punto operativo innecesario.
- **Decisión:** GitHub es la fuente de verdad y Cloudflare Workers Builds realiza build/deploy desde el repositorio. El entorno local es opcional.
- **Motivación:** reproducibilidad, menor fricción y capacidad de trabajar desde navegador.
- **Consecuencias:** configuración de build, secretos y observabilidad deben ser administrables desde servicios cloud; cambios manuales en el editor de Cloudflare deben reconciliarse en GitHub.
- **Alternativas descartadas:** PC local como mecanismo obligatorio de build/deploy; edición directa en Cloudflare como fuente de verdad.

## ADR-015 — Telnyx como proveedor telefónico inicial de FASE 0

- **Estado:** Accepted; supersedes ADR-007 para el carrier inicial de F0.
- **Problema:** durante la implementación, Twilio no ofreció numeración española adecuada para el flujo de prueba previsto.
- **Decisión:** Telnyx pasa a ser el proveedor telefónico inicial de FASE 0; Twilio permanece como alternativa soportable mediante `TelephonyProvider`.
- **Motivación:** disponibilidad de numeración +34 y capacidades de Programmable Voice/Voice API adecuadas para el mercado objetivo inicial.
- **Consecuencias:** la implementación F0 necesita webhook Telnyx y comandos/routing de Voice API; el dominio no debe importar tipos Telnyx.
- **Alternativas descartadas:** continuar F0 con número no español únicamente para mantener Twilio; acoplar la arquitectura a un único carrier.

## ADR-016 — CallOrchestrator en el Control Plane

- **Estado:** Accepted.
- **Problema:** el destino de una llamada puede depender de tenant, configuración, proveedor realtime, horario o handoff; esa decisión no debe quedar rígidamente codificada en el carrier.
- **Decisión:** introducir `CallOrchestrator` como componente de aplicación/control plane responsable de producir una `RoutingDecision` para cada llamada.
- **Motivación:** desacoplar Telnyx de OpenAI y permitir evolución a múltiples RealtimeProviders, humanos y fallbacks.
- **Consecuencias:** el Worker deberá procesar eventos del carrier antes del routing; el componente no puede contener reglas específicas de clínica/restaurante ni transportar audio.
- **Alternativas descartadas:** routing estático permanente Telnyx→OpenAI; lógica específica por tenant dentro del adaptador Telnyx.

## ADR-017 — NumberProvider separado conceptualmente de TelephonyProvider

- **Estado:** Accepted.
- **Problema:** adquisición/portabilidad de numeración y control/routing de llamadas son responsabilidades distintas aunque un proveedor comercial pueda ofrecer ambas.
- **Decisión:** modelarlas como capacidades separadas: `NumberProvider` para numeración y `TelephonyProvider` para lifecycle/routing de llamadas.
- **Motivación:** permitir números de un proveedor y transporte/control de otro sin afectar el Core.
- **Consecuencias:** no se asumirá en dominio que el carrier es necesariamente propietario del número.
- **Alternativas descartadas:** una única abstracción que mezcle siempre numeración y telefonía.

Los ADR 001–013 proceden de la especificación v1.6 y se irán materializando en archivos individuales cuando necesiten evolución. No se modifica una decisión aceptada únicamente editando este índice: cualquier cambio sustantivo requiere un ADR nuevo o superseding.
