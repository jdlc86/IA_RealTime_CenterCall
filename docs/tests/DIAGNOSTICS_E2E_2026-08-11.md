# Autodiagnóstico — validación E2E 2026-08-11

## Resultado

**PASS — capacidad validada E2E con llamada real, persistencia en Supabase y reconstrucción posterior por `call_id`.**

## Runtime validado

Antes de la llamada, `/health` confirmó presencia de `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, OpenAI, Telnyx y binding `CALL_SESSIONS`. `DEBUG_KEY=true` fue gestionado desde Cloudflare Dashboard.

La configuración consolidada elimina `DEBUG_KEY` de `wrangler.jsonc` y mantiene `keep_vars: true`, evitando una segunda fuente de verdad para ese flag. La escritura diagnóstica usa la clave moderna de Supabase mediante `apikey`, sin enviar `sb_secret_...` como JWT Bearer.

## Llamada de evidencia

```text
call_id: rtc_u7_EBmNR0PocXNS4T49HKewE
tenant_id: clinica-estetica-madrid
DEBUG_KEY: true
```

Eventos persistidos y leídos posteriormente desde `public.call_diagnostic_events`:

```text
SIDEBAND_CONNECTED
GREETING_SENT
DEBUG_CONFIGURED (enabled=true)
CALL_SESSION_STARTED
USER_TURN_RECEIVED
EXTERNAL_FLOW_STARTED
CONVERSATION_CONTINUE
INTENT_CLASSIFIED (SERVICES)
BACKEND_QUERY_STARTED (get_services)
WAITING_PHRASE_REQUESTED
CLASSIFIER_RESPONSE_COMPLETED
WAITING_PHRASE_RESPONSE_CREATED
BACKEND_QUERY_COMPLETED (get_services, backend elapsed_ms=406)
WAITING_PHRASE_GENERATED
EXTERNAL_RESULT_READY_FOR_SPEECH (ok=true)
FINAL_RESPONSE_REQUESTED
WAITING_PHRASE_PLAYBACK_COMPLETED
SIDEBAND_CLOSED
```

No se observaron eventos de severidad `error`, ni `diagnosis` ni `recovery` activos. `SIDEBAND_CLOSED` quedó registrado aproximadamente a los 26.9 s del timeline diagnóstico.

## Conclusiones verificadas

1. `DEBUG_KEY=true` llega al runtime (`DEBUG_CONFIGURED enabled=true`).
2. El flujo conversacional permanece operativo con diagnóstico ampliado activo.
3. Una consulta `SERVICES` ejecuta `get_services` y completa el backend correctamente.
4. La frase de espera y la entrega posterior del resultado externo quedan observables en el timeline.
5. Los eventos se persisten en Supabase y pueden consultarse después de la llamada.
6. El timeline puede reconstruirse por `call_id` sin acceso manual al servidor.

## Integración

La corrección de configuración/autenticación fue validada antes de integración y absorbida en `main` mediante squash de la PR #1:

```text
4ba0fe41b399b0e7534e7afca334e887d3f9a412
```

Esta evidencia permite considerar el bloque de autodiagnóstico de F8 **VALIDADO E2E**. F8 continúa abierta porque incluye otros trabajos de hardening de producción fuera del alcance de esta prueba.
