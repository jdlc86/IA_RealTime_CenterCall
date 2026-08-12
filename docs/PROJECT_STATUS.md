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
F5 Persistencia empresarial + Supabase + post-call 🟡 EN CURSO — reservas RESTAURANT en desarrollo protegido
F6 Handoff humano                            ⬜ NO INICIADA — decisión transversal documentada
F7 Concurrencia                              ⬜ NO INICIADA
F8 Hardening producción                      🟡 EN CURSO
F9 App de gestión web/escritorio             ⬜ NO INICIADA
```

## Estado relevante actual

- `clinica-estetica-madrid` y `restaurante-centro` disponen de routing telefónico independiente hacia la misma plataforma multi-tenant.
- El número del restaurante resuelve correctamente `tenant_id=restaurante-centro` y la persona conversacional Lucía.
- `MENU` y `RESERVATION` forman parte del contrato nativo del clasificador semántico tras la PR #13.
- La base de persistencia de restaurante incluye mesas, reservas, asignación de mesas, consentimiento comercial y verificación de teléfono.
- El flujo de reserva está protegido: la escritura requiere confirmación previa coherente y `manage_reservation` permanece gobernada por allowlist.
- Las pruebas anteriores verificaron que, sin autorización de la tool, `RESERVATION` se detecta pero no produce escrituras accidentales.

## F3 — ToolGateway

Continúa como frontera única de acciones empresariales. Mantiene `tenant_id` obligatorio, allowlist explícita, fail-closed, validación de argumentos y separación READ/WRITE. Las operaciones de restaurante deben respetar exactamente la misma frontera que clínica.

## F4 — Multi-negocio

La configuración V2 soporta `BusinessType = CLINIC | RESTAURANT`, con routing telefónico independiente y configuración por tenant. El segundo negocio ya dispone de número propio y evidencia conversacional real, por lo que la validación multi-negocio ha avanzado más allá del estado histórico reflejado en versiones anteriores de este documento.

La clínica debe permanecer estable mientras evoluciona el vertical restaurante; no se permiten forks del Core ni condicionales específicos por tenant.

## F5 — Restaurante: reservas y consentimiento

Arquitectura del flujo objetivo:

```text
RESERVATION
   ↓
recoger fecha/hora + party size
   ↓
consultar disponibilidad/capacidad real
   ↓
recoger contacto necesario
   ↓
resumen explícito
   ↓
CONFIRM_RESERVATION
   ↓
confirmación posterior coherente
   ↓
WRITE transaccional
   ↓
BOOKED
```

La disponibilidad debe modelarse sobre inventario/capacidad real de mesas y reservas existentes; no como una simple franja horaria desconectada del inventario.

### Consentimiento comercial

Reserva y marketing son dominios separados. Rechazar marketing nunca debe impedir reservar.

Para altas automáticas de marketing por llamada entrante se adopta `CALLER_ID_MATCH` como mecanismo principal de vinculación del canal cuando el número receptor de promociones coincide con el número llamante normalizado.

Principios:

- `reservation_phone` y `marketing_phone` pueden ser distintos;
- para alta automática por voz, `marketing_phone` debe coincidir con `caller_phone`;
- una persona que llama desde A no puede autorizar promociones para B mediante este mecanismo;
- `CALLER_ID_MATCH` verifica coherencia/control del canal de esa interacción, no titularidad contractual;
- verificación del canal y consentimiento explícito son hechos distintos y deben persistirse por separado;
- para baja automática por voz se puede actuar sobre el mismo número llamante cuando exista consentimiento asociado;
- si se solicita modificar el consentimiento de otro número, no se ejecuta automáticamente mediante `CALLER_ID_MATCH` y se ofrece un canal alternativo seguro.

El flujo conversacional debe ser amable, breve y evitar pedir información ya conocida de forma confiable.

## F6 — Handoff humano

**NO INICIADA. La decisión arquitectónica ya está fijada.**

La transferencia a una persona será una **capacidad transversal del sistema**, reutilizable por `CLINIC`, `RESTAURANT` y futuros verticales. No se implementará como lógica específica de Lucía/restaurante ni de Carolina/clínica.

Casos previstos incluyen solicitud explícita de humano, imposibilidad de completar una operación de forma segura, políticas que requieran intervención humana, fallos repetidos y casos administrativos que no deban resolverse automáticamente.

La futura app será otro canal para gestiones administrativas, pero no sustituye el derecho operativo del usuario a solicitar atención humana cuando el tenant ofrezca ese servicio.

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

1. Mantener F6 únicamente documentada por ahora.
2. Continuar el flujo `RESTAURANT` de reservas de forma protegida por allowlist y confirmación explícita.
3. Validar `MENU`/`RESERVATION` nativos en llamada real tras el despliegue correspondiente.
4. Activar escrituras de reserva solo después de disponer de datos de mesas/disponibilidad suficientes para una prueba controlada.
5. Implementar consentimiento comercial con separación estricta entre `caller_phone`, `reservation_phone` y `marketing_phone`, usando `CALLER_ID_MATCH` para el alta automática por voz.
