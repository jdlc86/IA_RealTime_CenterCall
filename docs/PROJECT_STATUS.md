# IA_RealTime_CenterCall — PROJECT STATUS

> **Estado operativo actual del proyecto**  
> **Fecha:** 2026-08-11  
> Este documento registra progreso y cierre de fases. La definición de arquitectura y del roadmap pertenece a `docs/architecture/SYSTEM_ARCHITECTURE.md`.

## Estado de fases

```text
F0 Voz E2E                                   ✅ CERRADA — PASS
F1 Baseline + observabilidad + TenantResolver ✅ CERRADA — PASS con baseline cuantitativo CANCELADO por decisión de proyecto
F2 Latencia + barge-in                       ✅ CERRADA SIN CAMBIOS DE OPTIMIZACIÓN — comportamiento actual aceptado
F3 ToolGateway                               🟡 EN CURSO — integración E2E activa
F4 Clínica + validación multi-negocio        🟡 EN CURSO — base KV multi-tenant activa
F5 Persistencia empresarial + Supabase + post-call 🟡 EN CURSO — lecturas empresariales iniciales integradas
F6 Handoff humano                            ⬜ NO INICIADA
F7 Concurrencia                              ⬜ NO INICIADA
F8 Hardening producción                      🟡 PREPARACIÓN — autodiagnóstico de producción definido como prioridad
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

Estado actual:

- binding `TENANT_CONFIG` activo;
- namespace físico `ia-realtime-centercall-tenant-config` provisionado;
- esquema versionado `ia-rtcc:v1`;
- claves independientes para routing telefónico y configuración del tenant;
- `KvTenantRepository` como resolver/config source activo;
- validación cruzada del binding SIP `called_number ↔ tenant_id`;
- `CallSession` desacoplado del antiguo mapa TypeScript;
- `assistant.systemPrompt`/comportamiento configurable por tenant;
- `assistant.waitingPhrases` configurable por tenant;
- llamada real post-cutover validada: saludo correcto, dato tool-only de 20 años correcto y cierre de llamada conservado;
- `DEFAULT_TENANT_ID`, `TENANT_ROUTES_JSON`, `tenant-configuration.ts`, `StaticTenantResolver` y el probe temporal de migración eliminados.

Pendiente para cerrar el gate multi-negocio:

- segundo negocio E2E;
- número desconocido E2E fail-closed.

Documento operativo: `docs/implementation/TENANT_KV_MIGRATION.md`.

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

Implementado:

- secretos backend `SUPABASE_URL` y `SUPABASE_SECRET_KEY` consumidos únicamente por Worker;
- `SupabaseAdapter` independiente de la capa conversacional;
- consultas filtradas por `tenant_id` impuesto por backend;
- tablas/dominios iniciales consumibles: servicios/tratamientos, profesionales y horarios;
- listas vacías tratadas como ausencia de información verificada, no como permiso para inventar;
- futura app y Carolina diseñadas para compartir la misma fuente de verdad empresarial.

Pendiente:

- carga/validación de datos empresariales reales;
- pacientes;
- citas/agenda;
- escrituras autorizadas;
- auditoría y post-call;
- pruebas cross-tenant de persistencia.

## Router semántico de datos empresariales — estado 2026-08-11

El router produce:

```text
NONE | BUSINESS_INFO | SERVICES | PROFESSIONALS | HOURS
```

La política de `SERVICES` fue endurecida después de detectar inconsistencia entre consultas como “precio del botox” y “qué tratamientos tenéis”.

En la versión actual, referencias a tratamientos, servicios, procedimientos, terapias, catálogo, precios/costes, duración, botox, disponibilidad u oferta recuperan/forzan el dominio `SERVICES` cuando el clasificador devuelve una ruta genérica. Se conserva fallback fail-safe para salidas parciales o inválidas del clasificador.

Prueba funcional observada:

- “precio del botox” → consulta externa + frase de espera + respuesta sin inventar precio: PASS;
- consultas de catálogo/tratamientos motivaron el endurecimiento del router y requieren nueva validación E2E tras el último cambio.

## Frases de espera para consultas externas

Implementado:

- `assistant.waitingPhrases` en KV;
- selección rotatoria de frase por `CallSession`;
- uso solo para dominios externos (`SERVICES`, `PROFESSIONALS`, `HOURS`), evitando espera artificial para datos ya residentes en KV;
- serialización para evitar que una respuesta posterior corte la frase;
- recuperación/watchdog para no dejar la llamada bloqueada si falta el evento de finalización esperado.

Validación actual:

- frase de espera antes de consulta de precio de botox: PASS;
- respuesta posterior sin dato disponible: PASS;
- se detectó previamente corte de frase por sincronización y se corrigió la secuencia;
- queda pendiente repetir validación E2E sobre catálogo/tratamientos tras el endurecimiento del router.

## Prioridad de hardening — autodiagnóstico activable en producción

Se define como prioridad de F8 implementar un modo de autodiagnóstico controlado por variable de runtime:

```text
DEBUG_KEY=false  → operación normal / telemetría mínima
DEBUG_KEY=true   → diagnóstico estructurado ampliado
```

`DEBUG_KEY` es un flag booleano, no una credencial.

Objetivo del modo diagnóstico:

- timeline/checkpoints por `call_id`;
- etapa actual y último estado correcto;
- latencias por transición;
- router/data requirement seleccionado;
- estado de frase de espera;
- tool forzada;
- inicio/fin/error de consulta externa;
- resultado de ToolGateway sin payload sensible;
- watchdogs y recuperación segura;
- diagnóstico final como `WAITING_PHRASE_PLAYBACK_STALLED`, `TOOL_TIMEOUT`, `SUPABASE_FAILED`, etc.

Restricciones de seguridad:

- no registrar API keys/secrets;
- no registrar audio;
- no almacenar teléfonos o datos clínicos innecesarios;
- no exponer endpoints diagnósticos públicos sin autenticación.

**Estado:** DISEÑADO / PENDIENTE DE IMPLEMENTACIÓN. No debe marcarse como disponible todavía.

## Decisión arquitectónica de datos

Se mantiene la separación:

```text
Cloudflare = configuración/ejecución rápida de conversación
Supabase PostgreSQL = estado empresarial persistente y cambiante
```

Cloudflare mantiene tenant routing, identidad/persona, prompt, voz/idioma/VAD, tools/permisos, providers y estado de control necesario para la llamada.

Supabase es la persistencia empresarial inicial para pacientes, servicios/tratamientos, profesionales, horarios, citas y demás estado operativo. El acceso del dominio se realiza mediante adaptadores y ToolGateway, evitando acoplar Business Modules al SDK concreto.

## Decisión de autenticación de la futura app

El concepto de tarjeta maestra se conserva con una mejora de seguridad:

- la tarjeta contiene una credencial secreta fuerte asociada al negocio;
- la credencial autentica contra la plataforma/Cloudflare, no directamente contra Supabase;
- tras validación se obtiene `tenant_id` y una sesión/token corto con scopes;
- la credencial maestra será revocable/rotable y no se persistirá en texto plano;
- ninguna clave `service_role`/backend de Supabase se entrega a la app;
- el tenant de la app se deriva de autenticación confiable y no de un campo libre enviado por el cliente.

## F9 — App de gestión web/escritorio

Se mantiene una fase específica de producto para desarrollar la aplicación que utilizarán los negocios. Compartirá la misma API, Business Modules y persistencia Supabase que Carolina.

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

## Estado de ramas de trabajo — 2026-08-11

Consolidadas por fast-forward al `main` actual:

- `debug-self-diagnostics`;
- `supabase-integration-wip`;
- `supabase-semantic-router-debug`;
- `fix-services-routing-v2`.

Se preservan sin forzar integración:

- ramas `backup-*`, por definición;
- `fix-services-routing`, porque diverge desde una implementación anterior y su funcionalidad está superada por el router actual;
- `supabase-services-minimal`, porque representa una alternativa antigua de integración Supabase y no debe reemplazar `SupabaseAdapter`/ToolGateway actuales.

## Próximo paso

1. Revalidar E2E el router con preguntas de catálogo: “¿Qué tratamientos tenéis?”, “¿Qué servicios ofrecéis?”, “¿Tenéis botox?” y variantes.
2. Implementar el modo de autodiagnóstico `DEBUG_KEY=true|false` antes de continuar con más complejidad de producción.
3. Después cargar datos empresariales reales en Supabase y validar lectura por tenant.
4. Completar el gate F4 con segundo negocio y número desconocido E2E fail-closed.
