# Glosario

> **Estado:** vigente
> **Última revisión:** 2026-08-29

- **Call Bootstrap:** preparación de una llamada antes de iniciar comportamiento específico de negocio.
- **CallSession:** contexto lógico de una llamada (`call_id`, `tenant_id`, `called_number`, estado, IDs de proveedores); su implementación y owner son específicos de cada producto realtime.
- **Control Plane:** lógica de control/orquestación. OpenAI y Gemini tienen planos de control ejecutables independientes.
- **Media Plane:** camino del audio. No atraviesa Cloudflare en la arquitectura oficial.
- **Gemini Fast Worker:** Worker Cloudflare independiente que posee admission, tenant/KV, credenciales, autorización/control, handoff y diagnóstico Gemini Fast.
- **Fast Media Edge:** servicio Cloud Run que posee sockets Telnyx/Gemini, audio y coordinación realtime local del producto Gemini.
- **Tenant:** negocio aislado dentro de la plataforma.
- **TenantResolver:** contrato que resuelve contexto de routing hacia `tenant_id`.
- **TenantConfiguration:** configuración operativa completa del tenant.
- **BusinessProfile:** información descriptiva relativamente estable del negocio.
- **RealtimeSessionConfiguration:** configuración neutral sólo cuando la semántica sea realmente compartida; cada runtime posee su setup/wire específico.
- **TelephonyProvider:** abstracción del carrier/proveedor telefónico.
- **RealtimeProvider:** abstracción del proveedor de IA realtime.
- **ToolGateway:** frontera autorizada entre el modelo y acciones empresariales.
- **ToolExecutor:** contrato interno de una tool concreta.
- **Business Module:** reglas reutilizables de una capacidad (citas, reservas, pedidos, etc.).
- **Capacidad transversal:** función común del kernel —por ejemplo seguridad, handoff, lifecycle o comunicaciones— consumida por varios verticales sin duplicarse por tenant/provider.
- **Capacidad vertical:** regla u operación propia de un sector/tenant —por ejemplo reservas de restaurante o citas clínicas— detrás de contratos comunes.
- **Tool contract:** declaración cerrada de schema, autoridad, efecto, capability, evidencia, handler y contexto; las mutaciones añaden idempotencia, confirmación e invariantes.
- **Provider/Adapter:** implementación que conecta un módulo con un sistema externo.
- **Gate:** criterios obligatorios para declarar terminada una fase.
- **Barge-in:** capacidad del usuario de interrumpir a la IA mientras habla.
- **Cloud-first:** desarrollo/deploy normal desde servicios cloud, sin requerir PC local.
