# IA_RealTime_CenterCall — Design Rules

> **Versión:** 2.1
> **Estado:** vigente y normativo
> **Última revisión:** 2026-08-22

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
- **RA-020** — Todo deploy parte de un SHA publicado y CI-verde. Puede ejecutarse mediante Workers Builds o Wrangler autorizado, pero la versión efectiva, el porcentaje de tráfico y la reconciliación con GitHub son obligatorios.
- **RA-021 — One state owner per concern.** Cada estado mutable, permiso o transición importante tiene una sola autoridad. Un port expone una capacidad; no crea un segundo owner.
- **RA-022 — Capability first, provider second.** Dominio y `CallSession` solicitan capacidades (`checkAvailability`, `createReservation`, `transferCall`, `terminateCall`); no invocan SDKs, endpoints, RPC ni wire formats externos.
- **RA-023 — Provider details at the edge.** OpenAI, Telnyx, Supabase y Cloudflare se traducen únicamente en adapters/ports de borde. Las capas neutrales consumen eventos y comandos propios.
- **RA-024 — Sin estado privado entre generaciones.** Una capa `CallSession` no alcanza internals de otra mediante `this as any`, prototipos, flags heredados o métodos privados. La coordinación entre capas usa runtimes/ports neutrales.
- **RA-025 — Ordering por evidencia, no por tiempo.** Carreras de voz y lifecycle se resuelven con identidad de evento, `item_id`, `response_id`, ownership y estados explícitos. No se añaden `sleep`, delays ni ventanas heurísticas para tapar desorden de eventos.
- **RA-026 — La intención conversacional pertenece al modelo.** No se enumeran todas las frases posibles del usuario para simular comprensión. Los matchers léxicos existentes no se amplían sin justificar que representan un protocolo cerrado.
- **RA-027 — Determinismo solo en invariantes.** Permisos, validación, idempotencia, tenant binding, confirmación, concurrencia, seguridad y lifecycle son deterministas. La interpretación abierta y la formulación natural siguen siendo model-owned dentro de esos límites.
- **RA-028 — Habla protegida atómica.** Saludo, recuperación y otros mensajes marcados como protegidos no admiten barge-in. Durante el saludo se suspende el VAD, se descarta el audio solapado y solo `assistant_audio_stopped` libera la escucha. Un buffer borrado solicita replay acotado; no se acepta como finalización.
- **RA-029 — Una respuesta activa y una decisión semántica por turno.** Ninguna capa puede crear respuestas o consumir tools en paralelo sin pasar por los owners de respuesta, turno y autorización.
- **RA-030 — Confirmación empresarial basada en backend.** El modelo nunca afirma reserva, cancelación, transferencia o escritura hasta recibir evidencia estructurada de éxito. Una confirmación anterior no se reutiliza después de cambiar fecha, hora, capacidad o alternativa.
- **RA-031 — Concurrencia adjudicada en commit.** La disponibilidad conversacional es informativa. PostgreSQL y las invariantes de persistencia deciden el ganador al confirmar; el perdedor recibe una explicación clara y una nueva elección, nunca una reserva ficticia.
- **RA-032 — Handoff inclusivo.** Necesidades de bebés, movilidad, audición u otras adaptaciones se derivan con lenguaje cuidadoso y orientado a asegurar una buena experiencia; nunca se presentan como exclusión o discriminación.
- **RA-033 — Seguridad por intención y fronteras.** La extracción de prompt, manipulación de instrucciones/tools y abusos reiterados se gobiernan por políticas de seguridad y sanciones durables. No se depende exclusivamente de una lista de palabras ni se exponen prompts, secretos o wire interno.
- **RA-034 — Diagnóstico mínimo y redactado.** Se conserva únicamente trazabilidad técnica necesaria —transcripción redactada, estados, tools y decisiones— con retención corta. No se persisten secretos ni datos personales sin necesidad.
- **RA-035 — Una fuente documental por decisión.** Arquitectura estable vive aquí/ADR; estado operativo en `PROJECT_STATUS.md`; relevo en `SESSION_HANDOFF.md`; procedimientos en runbooks. No se copian cronologías completas entre documentos.

## Definition of Done arquitectónica

Una feature no está terminada si viola una regla aplicable, carece de prueba de comportamiento y, cuando cambia una frontera, de guard estructural. También requiere manejo de error, observabilidad proporcional y actualización de la única fuente documental que posea la decisión.

`CI verde`, `desplegado` y `validado E2E` son estados distintos. Ninguno sustituye a los demás.
