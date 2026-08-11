# IA_RealTime_CenterCall — PROJECT STATUS

> **Estado operativo actual del proyecto**  
> **Fecha:** 2026-08-12  
> Este documento registra progreso y cierre de fases. La definición de arquitectura y del roadmap pertenece a `docs/architecture/SYSTEM_ARCHITECTURE.md`.

## Estado de fases

```text
F0 Voz E2E                                   ✅ CERRADA — PASS
F1 Baseline + observabilidad + TenantResolver ✅ CERRADA — PASS con baseline cuantitativo CANCELADO por decisión de proyecto
F2 Latencia + barge-in                       ✅ CERRADA SIN CAMBIOS DE OPTIMIZACIÓN — comportamiento actual aceptado
F3 ToolGateway                               🟡 EN CURSO — integración E2E activa
F4 Clínica + validación multi-negocio        🟡 EN CURSO — V2 RESTAURANT validada en runtime; gate multi-negocio aún incompleto
F5 Persistencia empresarial + Supabase + post-call 🟡 EN CURSO — lecturas empresariales y diagnóstico Supabase validados
F6 Handoff humano                            ⬜ NO INICIADA
F7 Concurrencia                              ⬜ NO INICIADA
F8 Hardening producción                      🟡 EN CURSO — DEBUG_KEY validado E2E; deuda P2 de diagnóstico tenant pendiente
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
- READ `get_business_information` desde configuración autorizada;
- READ `get_services`, `get_professionals` y `get_business_hours` conectadas a la capa Supabase;
- F3-T08 validada funcionalmente E2E mediante dato tool-only `years_in_operation=20`;
- protección funcional contra invención de precios/datos no registrados validada mediante llamada real.

Guía activa: `docs/implementation/PHASE_3_IMPLEMENTATION_GUIDE.md`.

## F4 — Configuración multi-negocio mediante Cloudflare KV

F4 está EN CURSO con configuración de tenant en Cloudflare Workers KV.

Estado validado:

- binding `TENANT_CONFIG` activo;
- namespace físico `ia-realtime-centercall-tenant-config` provisionado;
- esquema V1 `ia-rtcc:v1` preservado para compatibilidad;
- esquema V2 `ia-rtcc:v2:tenant:<tenant_id>` integrado en `main`;
- `BusinessType = CLINIC | RESTAURANT` implementado;
- `TenantConfigurationV2` incorpora `businessType` y `verticalConfig`;
- `KvTenantRepository` prioriza V2 y usa V1 únicamente cuando V2 no existe;
- una V2 inválida o deshabilitada no cae silenciosamente a V1 (fail-closed);
- claves independientes para routing telefónico y configuración del tenant;
- `KvTenantRepository` como resolver/config source activo;
- validación cruzada del binding SIP `called_number ↔ tenant_id`;
- `CallSession` desacoplado del antiguo mapa TypeScript;
- `assistant.systemPrompt`/comportamiento configurable por tenant;
- `assistant.waitingPhrases` configurable por tenant;
- llamada real post-cutover de clínica validada: saludo correcto, dato tool-only de 20 años correcto y cierre de llamada conservado;
- tenant sintético `restaurante-centro` creado y migrado de forma reversible a V2 conservando su clave V1 como rollback;
- endpoint protegido `GET /debug/tenant/<tenantId>` integrado mediante wrapper mínimo del Worker estable;
- validación runtime realizada sobre `restaurante-centro`: `schemaVersion=2`, `businessType=RESTAURANT`, `status=active`;
- clínica mantenida temporalmente en V1 durante la transición para reducir riesgo;
- CI `Control Plane CI` activo: tests y Wrangler dry-run ejecutados antes de integrar los cambios V2/diagnóstico;
- `DEFAULT_TENANT_ID`, `TENANT_ROUTES_JSON`, `tenant-configuration.ts`, `StaticTenantResolver` y el probe temporal de migración eliminados.

Deuda técnica conocida:

- revisión automatizada de la PR #5 detectó una observación P2 válida: `verticalConfigPresent` se calcula actualmente como `schemaVersion === 2`. El parser V2 normaliza un `verticalConfig` ausente a `{}`, por lo que ese indicador no demuestra la presencia original del campo en KV. Esto no invalida la evidencia `schemaVersion=2` / `businessType=RESTAURANT`, pero debe corregirse antes de usar `verticalConfigPresent` como evidencia de configuración vertical completa.

Pendiente para cerrar el gate multi-negocio:

- corregir la deuda P2 anterior y añadir prueba contractual;
- completar evidencia E2E del segundo negocio a nivel conversacional/routing cuando exista una ruta telefónica independiente o mecanismo de prueba equivalente;
- número desconocido E2E fail-closed.

Documento operativo: `docs/implementation/TENANT_KV_MIGRATION.md`.
Decisión de verticales: `docs/architecture/BUSINESS_VERTICALS.md`.

## F5 — Supabase y persistencia empresarial

F5 ya NO está en estado “no iniciada”. La integración inicial está activa.

Arquitectura vigente:

```text
CallSession
  ↓
router semántico
  ↓
ToolGateway
  ↓
tenant_id impuesto por servidor
  ↓
SupabaseAdapter
  ↓
Supabase PostgreSQL
```

Implementado/validado:

- secretos backend `SUPABASE_URL` y `SUPABASE_SECRET_KEY` consumidos únicamente por Worker;
- `SupabaseAdapter` independiente de la capa conversacional;
- consultas filtradas por `tenant_id` impuesto por backend;
- tablas/dominios iniciales consumibles: servicios/tratamientos, profesionales y horarios;
- listas vacías tratadas como ausencia de información verificada, no como permiso para inventar;
- futura app y asistente de voz diseñados para compartir la misma fuente de verdad empresarial;
- persistencia de eventos del timeline de autodiagnóstico desde `CallSession` mediante `SupabaseAdapter` cuando `DEBUG_KEY=true`;
- `SUPABASE_SECRET_KEY` confirmada presente por `/health`;
- escritura y lectura real de `public.call_diagnostic_events` validadas;
- reconstrucción de timeline real por `call_id` validada después de una llamada con `DEBUG_KEY=true`, sin eventos diagnósticos de severidad `error` en la llamada de validación.

Pendiente:

- carga/validación adicional de datos empresariales por vertical;
- pacientes y citas/agenda para `CLINIC`;
- disponibilidad/capacidad/reservas para `RESTAURANT`;
- escrituras autorizadas de negocio;
- auditoría y post-call completos;
- pruebas cross-tenant de persistencia empresarial.

## Router semántico de datos empresariales — estado 2026-08-12

El router produce actualmente:

```text
NONE | BUSINESS_INFO | SERVICES | PROFESSIONALS | HOURS
```

La política de `SERVICES` fue endurecida después de detectar inconsistencia entre consultas como “precio del botox” y “qué tratamientos tenéis”. La evolución prevista por la decisión de verticales separará dominios comunes de dominios habilitados por `businessType`; no se ampliará indefinidamente un clasificador global con conceptos de todos los sectores.

Pruebas funcionales ya observadas incluyen consulta externa, frase de espera y respuesta sin inventar precio. Las futuras operaciones de restaurante deberán introducir dominios propios (`MENU`, `RESERVATION`) sin reutilizar semánticamente citas clínicas.

## Frases de espera para consultas externas

Implementado y validado:

- `assistant.waitingPhrases` en KV;
- selección rotatoria de frase por `CallSession`;
- uso para dominios externos, evitando espera artificial para datos residentes en KV;
- serialización para evitar que una respuesta posterior corte la frase;
- recuperación/watchdog para no dejar la llamada bloqueada si falta el evento de finalización esperado;
- llamada E2E validada con flujo `SERVICES → get_services → resultado externo → respuesta final` sin errores diagnósticos.

## F8 — Hardening: autodiagnóstico activable en producción

El modo de autodiagnóstico está controlado por variable de runtime:

```text
DEBUG_KEY=false  → operación normal / telemetría mínima
DEBUG_KEY=true   → diagnóstico estructurado ampliado
```

`DEBUG_KEY` es un flag booleano, no una credencial, y se controla desde Cloudflare Dashboard. `wrangler.jsonc` preserva variables gestionadas en dashboard mediante `keep_vars`.

Validado E2E:

- tracker de estado/timeline por `call_id`;
- checkpoints y logs estructurados condicionados por `DEBUG_KEY`;
- persistencia asíncrona de eventos diagnósticos en Supabase;
- lectura posterior y reconstrucción de un timeline real;
- `tenant_id`, etapa, severidad, latencia, data requirement y tool disponibles según evento;
- llamada real de validación sin eventos diagnósticos de severidad `error`.

Restricciones de seguridad:

- no registrar API keys/secrets;
- no registrar audio;
- no almacenar teléfonos o datos clínicos innecesarios;
- endpoints diagnósticos deben permanecer gated y devolver solo metadatos no sensibles.

**Estado actual:** AUTODIAGNÓSTICO E2E VALIDADO. El endpoint de diagnóstico de tenant tiene la deuda P2 descrita en F4, limitada al indicador `verticalConfigPresent`.

## Decisión arquitectónica de datos

Se mantiene la separación:

```text
Cloudflare = configuración/ejecución rápida de conversación
Supabase PostgreSQL = estado empresarial persistente y cambiante
```

Cloudflare mantiene tenant routing, identidad/persona, prompt, voz/idioma/VAD, tools/permisos, providers y estado de control necesario para la llamada.

Supabase es la persistencia empresarial. Los dominios se separan por vertical cuando sus reglas difieren: clínica evoluciona hacia pacientes/citas; restaurante hacia disponibilidad/capacidad/reservas. El acceso se realiza mediante adaptadores y ToolGateway, evitando acoplar Business Modules al SDK concreto.

## F9 — App de gestión web/escritorio

La futura aplicación compartirá API, Business Modules y persistencia Supabase con el asistente de voz. Debe respetar `businessType` y presentar operaciones propias del vertical en lugar de forzar un único modelo de negocio.

## Estado de ramas / PR — 2026-08-12

- PR #3 `Document clinic and restaurant business verticals`: MERGED.
- PR #4 `Introduce backward-compatible BusinessType and TenantConfiguration V2`: MERGED tras CI PASS.
- PR #5 `Add gated tenant configuration diagnostic endpoint`: MERGED tras CI PASS.
- PR abiertas tras la integración de #5: ninguna en la revisión de salud realizada el 2026-08-12.
- Issues abiertas en esa misma revisión: ninguna.

## Próximo paso

1. Corregir la deuda P2 de `verticalConfigPresent` y cubrirla con test.
2. Mantener `restaurante-centro` como tenant V2 `RESTAURANT` de validación; no eliminar todavía la clave V1 de rollback.
3. Completar el gate F4 restante: segundo negocio E2E conversacional/routing y número desconocido E2E fail-closed.
4. Después iniciar el dominio `RESTAURANT`: disponibilidad/capacidad y `ReservationModule`, sin reutilizar `AppointmentModule`.
5. Mantener la clínica estable durante esta evolución y migrarla a V2 solo cuando el patrón RESTAURANT esté suficientemente probado.
