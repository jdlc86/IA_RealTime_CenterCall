# Glosario

- **Call Bootstrap:** preparación de una llamada antes de iniciar comportamiento específico de negocio.
- **CallSession:** contexto lógico de una llamada (`call_id`, `tenant_id`, `called_number`, estado, IDs de proveedores).
- **Control Plane:** lógica de control/orquestación; inicialmente en Cloudflare Workers.
- **Media Plane:** camino del audio. No atraviesa Cloudflare en la arquitectura oficial.
- **Tenant:** negocio aislado dentro de la plataforma.
- **TenantResolver:** contrato que resuelve contexto de routing hacia `tenant_id`.
- **TenantConfiguration:** configuración operativa completa del tenant.
- **BusinessProfile:** información descriptiva relativamente estable del negocio.
- **RealtimeSessionConfiguration:** contrato propio para configurar una sesión realtime sin acoplarse a OpenAI.
- **TelephonyProvider:** abstracción del carrier/proveedor telefónico.
- **RealtimeProvider:** abstracción del proveedor de IA realtime.
- **ToolGateway:** frontera autorizada entre el modelo y acciones empresariales.
- **ToolExecutor:** contrato interno de una tool concreta.
- **Business Module:** reglas reutilizables de una capacidad (citas, reservas, pedidos, etc.).
- **Provider/Adapter:** implementación que conecta un módulo con un sistema externo.
- **Gate:** criterios obligatorios para declarar terminada una fase.
- **Barge-in:** capacidad del usuario de interrumpir a la IA mientras habla.
- **Cloud-first:** desarrollo/deploy normal desde servicios cloud, sin requerir PC local.
