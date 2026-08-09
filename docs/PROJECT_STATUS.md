# IA_RealTime_CenterCall — PROJECT STATUS

> **Estado operativo actual del proyecto**  
> **Fecha:** 2026-08-09  
> Este documento registra progreso y cierre de fases. La definición de arquitectura y del roadmap pertenece a `docs/architecture/SYSTEM_ARCHITECTURE.md`.

## Estado de fases

```text
F0 Voz E2E                                   ✅ CERRADA — PASS
F1 Baseline + observabilidad + TenantResolver ✅ CERRADA — PASS con baseline cuantitativo CANCELADO por decisión de proyecto
F2 Latencia + barge-in                       ✅ CERRADA SIN CAMBIOS DE OPTIMIZACIÓN — comportamiento actual aceptado
F3 ToolGateway                               🟡 EN CURSO
F4 Clínica + validación multi-negocio        🟡 EN CURSO — base KV multi-tenant activa
F5 Persistencia empresarial + Supabase + post-call ⬜ NO INICIADA
F6 Handoff humano                            ⬜ NO INICIADA
F7 Concurrencia                              ⬜ NO INICIADA
F8 Hardening producción                      ⬜ NO INICIADA
F9 App de gestión web/escritorio             ⬜ NO INICIADA
```

## Evidencia de F0

FASE 0 quedó validada con pruebas reales de voz, incluyendo conversación prolongada, barge-in, silencios, cierre manual y por intención, llamadas consecutivas y estabilidad E2E. La evidencia detallada permanece en `docs/tests/PHASE0.md` y en la documentación de cierre por intención.

## Evidencia de F1

Validado:

- routing `called_number → tenant_id`;
- `+34910789057 → clinica-estetica-madrid`;
- tenant binding propagado hasta `CallSession`;
- saludo inicial personalizado validado mediante llamada real;
- comportamiento fail-closed para número desconocido a nivel contractual;
- observabilidad de tenant resolution/bootstrap.

El baseline cuantitativo de latencia/setup fue CANCELADO por decisión de proyecto y no es pendiente bloqueante.

El antiguo `StaticTenantResolver` fue retirado tras el cutover a `KvTenantRepository`; su responsabilidad permanece cubierta por las pruebas contractuales KV.

## Disposición de F2

Latencia + barge-in se cerró sin nuevas optimizaciones. El comportamiento ya demostrado fue aceptado y se priorizó no modificar un flujo de voz estable sin defecto reproducible.

## F3 — ToolGateway

FASE 3 está EN CURSO.

Implementado/validado hasta ahora:

- contrato `ToolGateway` independiente de SDKs externos;
- `tenant_id` obligatorio;
- allowlist explícita por tenant;
- fail-closed para tools desconocidas/no autorizadas;
- validación de argumentos antes de ejecutar;
- errores estructurados;
- clasificación `READ` / `WRITE`;
- pruebas contractuales iniciales 7/7 PASS;
- integración con `CallSession` y tools por tenant;
- primera READ `get_business_information`;
- F3-T08 validada funcionalmente E2E mediante dato tool-only `years_in_operation=20`.

Guía activa: `docs/implementation/PHASE_3_IMPLEMENTATION_GUIDE.md`.

## F4 — Configuración multi-negocio mediante Cloudflare KV

F4 ha comenzado con la migración de configuración de tenant a Cloudflare Workers KV.

Estado actual:

- binding `TENANT_CONFIG` activo;
- namespace físico `ia-realtime-centercall-tenant-config` provisionado;
- esquema versionado `ia-rtcc:v1`;
- claves independientes para routing telefónico y configuración del tenant;
- `KvTenantRepository` como resolver/config source activo;
- validación cruzada del binding SIP `called_number ↔ tenant_id`;
- `CallSession` desacoplado del antiguo mapa TypeScript;
- llamada real post-cutover validada: saludo correcto, dato tool-only de 20 años correcto y cierre de llamada conservado;
- `DEFAULT_TENANT_ID`, `TENANT_ROUTES_JSON`, `tenant-configuration.ts`, `StaticTenantResolver` y el probe temporal de migración eliminados.

Pendiente para cerrar el gate multi-negocio:

- segundo negocio E2E;
- número desconocido E2E fail-closed.

Documento operativo: `docs/implementation/TENANT_KV_MIGRATION.md`.

## Decisión arquitectónica de datos — 2026-08-09

Se adopta la separación:

```text
Cloudflare = configuración/ejecución rápida de conversación
Supabase PostgreSQL = estado empresarial persistente y cambiante
```

Cloudflare mantiene tenant routing, identidad/persona, prompt, voz/idioma/VAD, tools/permisos, providers y estado de control necesario para la llamada.

Supabase será la persistencia empresarial inicial para pacientes, servicios/tratamientos, profesionales, horarios, citas y demás estado operativo. El acceso del dominio se hará mediante `SupabaseAdapter`, evitando acoplar Business Modules al SDK concreto.

Carolina y la futura app compartirán esa fuente de verdad. Una modificación confirmada desde una interfaz deberá ser observable por la otra.

## Decisión de autenticación de la futura app

El concepto de tarjeta maestra se conserva con una mejora de seguridad:

- la tarjeta contiene una credencial secreta fuerte asociada al negocio;
- la credencial autentica contra la plataforma/Cloudflare, no directamente contra Supabase;
- tras validación se obtiene `tenant_id` y una sesión/token corto con scopes;
- la credencial maestra será revocable/rotable y no se persistirá en texto plano;
- ninguna clave `service_role`/backend de Supabase se entrega a la app;
- el tenant de la app se deriva de autenticación confiable y no de un campo libre enviado por el cliente.

## F9 añadida — App de gestión web/escritorio

Se incorpora una fase específica de producto para desarrollar la aplicación que utilizarán los negocios. Compartirá la misma API, Business Modules y persistencia Supabase que Carolina.

Alcance inicial previsto:

- autenticación segura mediante tarjeta maestra + sesión corta;
- pacientes;
- agenda/citas;
- servicios/tratamientos;
- profesionales;
- lectura y escritura autorizada por tenant;
- consistencia inmediata con las operaciones realizadas por el asistente de voz;
- auditoría y pruebas cross-tenant;
- interfaz web y decisión/implementación del empaquetado de escritorio.

Aunque la interfaz se implemente en F9, F4/F5 deben preparar desde ahora contratos, esquema y APIs reutilizables para evitar construir dos backends diferentes.

## Próximo paso

Completar el gate F4 de aislamiento real con un segundo negocio y una prueba E2E de número desconocido. Después continuar con el modelo empresarial de servicios/tratamientos, pacientes y citas que se persistirá en Supabase.
