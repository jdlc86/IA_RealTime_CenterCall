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
F4 Clínica + validación multi-negocio        🟡 EN CURSO — RESTAURANT validado con número/routing independiente
F5 Persistencia empresarial + Supabase + post-call 🟡 EN CURSO — reserva RESTAURANT E2E validada; consentimiento comercial pendiente
F6 Handoff humano                            ⬜ NO INICIADA — decisión transversal documentada
F7 Concurrencia                              ⬜ NO INICIADA
F8 Hardening producción                      🟡 EN CURSO
F9 App de gestión web/escritorio             ⬜ NO INICIADA
```

## Checkpoint operativo RESTAURANT — 2026-08-12

### Estado validado E2E

El vertical `restaurante-centro` ha alcanzado un checkpoint funcional relevante:

- routing telefónico independiente y persona conversacional Lucía: VALIDADO;
- `businessType=RESTAURANT` en configuración V2: VALIDADO EN RUNTIME;
- inventario de prueba cargado: tres mesas de 4 plazas y dos mesas de 2 plazas;
- `check_reservation_availability` habilitada como operación READ gobernada por allowlist;
- reserva gestionada mediante orquestador backend, evitando depender de `tool forcing` de Realtime;
- consulta de disponibilidad lanzada en paralelo mientras Lucía continúa recogiendo datos;
- revalidación final antes del WRITE;
- confirmación verbal protegida: Lucía solo puede afirmar una reserva cuando existe evidencia backend `BOOKED`;
- llamada real validada con secuencia `RESERVATION_AVAILABILITY_STARTED → RESERVATION_AVAILABILITY_COMPLETED → RESERVATION_CONFIRMATION_ARMED_BACKEND → RESERVATION_FINAL_RECHECK_STARTED → RESERVATION_BOOKED_EVIDENCE → RESERVATION_BACKEND_BOOKED`;
- reserva real persistida en Supabase con mesa compatible;
- propagación del número real del llamante desde el webhook firmado de Telnyx hasta Realtime/CallSession: VALIDADA manualmente en una reserva real, almacenando el número de origen correcto.

### Diseño vigente de reservas

El flujo anterior basado en un segundo `response.create` forzando `manage_reservation` produjo `FORCED_TOOL_RESPONSE_DONE_WITHOUT_CALL` y queda descartado como patrón principal.

El diseño vigente es backend-orchestrated:

```text
usuario habla
  ↓
conversation_intent clasifica RESERVATION y extrae datos conocidos
  ↓
ReservationState acumulado en backend
  ↓
cuando existen party_size + fecha/hora
  ├────────────→ check_reservation_availability (READ, en paralelo)
  │
  └→ Lucía continúa recogiendo nombre/contacto
  ↓
si no hay disponibilidad
  → buscar alternativas verificadas cercanas (±30 / ±60 min)
  ↓
si hay disponibilidad
  → resumen explícito
  → confirmación del usuario
  → recheck final
  → manage_reservation (WRITE)
  → BOOKED
  → solo entonces confirmación verbal
```

La disponibilidad se calcula sobre inventario/capacidad real de mesas y reservas existentes. La consulta anticipada nunca sustituye la revalidación inmediatamente anterior al WRITE.

### Propagación confiable del caller ID

Se detectó que, tras la transferencia Telnyx → OpenAI, las cabeceras SIP podían presentar el DID del restaurante como identidad. Una reserva llegó a almacenar el número llamado del restaurante como `customer_phone`; este caso se corrigió en dos etapas:

1. fail-closed: el número llamado del tenant queda excluido como candidato a `caller_phone`;
2. propagación determinista: el Worker toma `payload.from` únicamente después de verificar la firma Ed25519 del webhook de Telnyx, lo normaliza y lo propaga en la transferencia como `from` y `X-IA-Caller-Number`.

Resultado validado manualmente: una llamada posterior almacenó como `customer_phone` el número real desde el que llamó el usuario.

Commits de referencia del checkpoint:

- `b74e05645702ffbea9ed8ac303498e1a7a1f2f1d` — orquestador backend de reservas y disponibilidad paralela;
- `8c830bd06cea0fcf1d1cf498069f126268b50153` — corrección `session.type=realtime`;
- `dd0a173af6cc56562cf4e8f558e64483797b4de2` — exclusión del DID del tenant como caller identity;
- `c61bdafe8aba7828660bbcea8080b3063cdb3e8d` — propagación explícita y confiable de `payload.from` Telnyx.

### Consentimiento comercial — siguiente bloque funcional

Reserva y marketing siguen siendo dominios separados. Rechazar marketing nunca debe impedir reservar.

La infraestructura de persistencia y reglas para `CALLER_ID_MATCH` existe, pero el flujo conversacional de consentimiento todavía no debe considerarse cerrado E2E.

Reglas fijadas:

- `reservation_phone` y `marketing_phone` pueden ser distintos;
- para alta automática por voz, `marketing_phone` debe coincidir exactamente con el `caller_phone` confiable;
- una persona que llama desde A no puede autorizar promociones para B;
- el número dictado verbalmente no sirve como evidencia para `CALLER_ID_MATCH`;
- consentimiento explícito y verificación del canal son hechos distintos y deben persistirse por separado;
- para baja automática por voz se actúa únicamente sobre el mismo número desde el que se llama;
- una petición sobre otro número debe fallar cerrada y ofrecer canal alternativo seguro;
- el futuro handoff humano podrá resolver casos no automatizables, pero pertenece a F6 y todavía no está activo.

### Incidencia externa actual: conector Supabase de ChatGPT

El acceso de la aplicación a Supabase y el acceso de ChatGPT mediante su conector son independientes.

Estado observado al cerrar este checkpoint:

```text
Cloudflare Worker → Supabase
✅ operativo; las reservas reales continúan persistiendo

ChatGPT → conector/plugin Supabase
❌ no operativo en esta sesión tras una secuencia de errores de autorización/disponibilidad
```

Se observaron primero errores MCP `-32600: You do not have permission to perform this action`; posteriormente, tras reinstalar/reconectar el plugin, la herramienta quedó no disponible/deshabilitada para la sesión. Incluso `SELECT 1` no pudo ejecutarse desde ChatGPT.

No se debe modificar `SUPABASE_SECRET_KEY`, tablas ni configuración de producción para intentar resolver este problema: la aplicación ha demostrado que sigue escribiendo correctamente. Mientras el conector de ChatGPT no se recupere, las verificaciones de datos deberán hacerse manualmente en Supabase o mediante otros observables disponibles.

## Estado relevante actual

- `clinica-estetica-madrid` y `restaurante-centro` disponen de routing telefónico independiente hacia la misma plataforma multi-tenant.
- El número del restaurante resuelve correctamente `tenant_id=restaurante-centro` y la persona conversacional Lucía.
- `MENU` y `RESERVATION` forman parte del contrato nativo del clasificador semántico.
- La base de persistencia de restaurante incluye mesas, reservas, asignación de mesas, consentimiento comercial y verificación de teléfono.
- `manage_reservation` y `check_reservation_availability` permanecen gobernadas por allowlist.
- El flujo de reserva backend-orchestrated está VALIDADO E2E en llamada real.
- La identidad telefónica confiable procedente de Telnyx está VALIDADA manualmente en una reserva real.

## F3 — ToolGateway

Continúa como frontera única de acciones empresariales. Mantiene `tenant_id` obligatorio, allowlist explícita, fail-closed, validación de argumentos y separación READ/WRITE. Las operaciones de restaurante deben respetar exactamente la misma frontera que clínica.

## F4 — Multi-negocio

La configuración V2 soporta `BusinessType = CLINIC | RESTAURANT`, con routing telefónico independiente y configuración por tenant. El segundo negocio ya dispone de número propio y evidencia conversacional real.

La clínica debe permanecer estable mientras evoluciona el vertical restaurante; no se permiten forks del Core ni condicionales específicos por tenant.

## F5 — Restaurante: reservas y consentimiento

La parte de reservas ya dispone de evidencia E2E positiva. F5 continúa abierta porque todavía quedan consentimiento comercial, post-call y otros dominios de persistencia por cerrar.

## F6 — Handoff humano

**NO INICIADA. La decisión arquitectónica ya está fijada.**

La transferencia a una persona será una **capacidad transversal del sistema**, reutilizable por `CLINIC`, `RESTAURANT` y futuros verticales. No se implementará como lógica específica de Lucía/restaurante ni de Carolina/clínica.

Casos previstos incluyen solicitud explícita de humano, imposibilidad de completar una operación de forma segura, políticas que requieran intervención humana, fallos repetidos y casos administrativos que no deban resolverse automáticamente.

Hasta F6:

- no existe `transfer_to_human` activo;
- no se simula una transferencia;
- no se promete disponibilidad humana desconocida;
- los módulos actuales se diseñan de modo que puedan escalar posteriormente sin reescritura del Core.

Documento de decisión: `docs/architecture/HUMAN_HANDOFF.md`.

## F8 — Observabilidad/hardening

El autodiagnóstico mediante `DEBUG_KEY` y `public.call_diagnostic_events` continúa siendo la fuente de evidencia E2E por `call_id`. No se deben registrar secretos, audio ni datos personales innecesarios.

## F9 — App de gestión

La futura app compartirá Business Modules y persistencia con voz. Para restaurante deberá permitir administrar, entre otros, inventario/capacidad de mesas, disponibilidad, reservas y las gestiones administrativas que se definan. Los mecanismos de autenticación/autorización permanecen separados de la identidad obtenida en una llamada.

## Roadmap vigente

```text
F5 Persistencia/operaciones empresariales
 ↓
F6 Handoff humano transversal
 ↓
F7 Concurrencia
 ↓
F8 Hardening producción
 ↓
F9 App de gestión
```

## Próximo paso operativo

1. Mantener estable el flujo de reservas ya validado y no volver al patrón de `manage_reservation` forzada mediante un segundo `response.create`.
2. Implementar y validar E2E el consentimiento comercial conversacional usando el `caller_phone` confiable ya propagado desde Telnyx y las reglas `CALLER_ID_MATCH`.
3. Mantener F6 únicamente documentada por ahora.
4. Recuperar cuando sea posible el acceso del conector Supabase de ChatGPT; no bloquear el desarrollo de código por esta incidencia externa.
5. Después del consentimiento, continuar F5 con los siguientes dominios de persistencia/post-call definidos por arquitectura.
