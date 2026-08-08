# IA_RealTime_CenterCall — Design Rules

> **Versión:** 2.0  
> **Estado:** vigente y normativo

Estas reglas son obligatorias salvo ADR que las modifique explícitamente.

- **RA-001** — El dominio no importa SDKs externos.
- **RA-002** — Toda integración externa tiene contrato/provider/adaptador.
- **RA-003** — Cloudflare queda fuera del audio path.
- **RA-004** — Toda herramienta empresarial entra por `ToolGateway` antes de llegar a módulos/providers.
- **RA-005** — No se amplía el media plane sin benchmark + ADR.
- **RA-006** — No se optimiza sin baseline.
- **RA-007** — Ningún gate se cierra sin evidencia.
- **RA-008** — Nuevas features preservan sustituibilidad de Twilio/OpenAI.
- **RA-009** — Ningún secreto se almacena en Git.
- **RA-010** — El modelo nunca es autoridad de permisos.
- **RA-011** — El Core no contiene lógica específica de clínica/restaurante/etc.
- **RA-012** — El modelo no inventa disponibilidad ni confirma operaciones sin fuente de verdad.
- **RA-013** — Toda sesión/operación empresarial tiene `tenant_id`.
- **RA-014** — Los módulos no dependen de SDKs/modelos de datos de sistemas externos.
- **RA-015** — El tenant se resuelve desde routing de entrada; inicialmente `called_number → tenant_id`.
- **RA-016** — La personalización se realiza mediante `TenantConfiguration`, módulos y providers; nunca mediante forks o condicionales específicos por cliente.
- **RA-017** — No comienza conversación específica de negocio antes de completar Call Bootstrap + Tenant Binding.
- **RA-018** — `RealtimeSessionConfiguration` es un contrato propio; el adaptador realtime traduce al formato del proveedor.
- **RA-019** — GitHub es la fuente de verdad; cambios manuales en Cloudflare solo se permiten como diagnóstico excepcional y deben reconciliarse en GitHub.
- **RA-020** — El flujo normal de build/deploy es cloud-first mediante integración GitHub → Cloudflare Workers Builds.

## Definition of Done arquitectónica

Una feature no está terminada si viola una regla aplicable, carece de prueba, manejo de error, timeout cuando corresponda, observabilidad suficiente o documentación actualizada.
