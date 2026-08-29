# Remediación administrada de caller security

> Estado: diseño implementado localmente; no operativo hasta desplegar SEC-P1-02
> Última revisión: 2026-08-29

## Propósito

Este procedimiento gobierna falsos positivos y correcciones de `caller_security_state` sin exponer teléfonos, transcript, prompts ni identidad humana en claro. No es un mecanismo de pruebas frecuentes ni una forma de eludir rate limits.

## Política de decay

- Un punto de `risk_score` por cada 24 horas completas sin nueva evidencia que incremente riesgo.
- Se aplica perezosamente dentro de `record_caller_security_signal_v2` y `evaluate_inbound_call_security_v2`; no crea otro RPC ni toca el audio.
- Una llamada normal no reinicia el reloj del riesgo.
- No reduce automáticamente `security_strikes`, `rate_limit_blocks`, `blocked_until` ni `permanent_block`.
- Un bloqueo permanente exige revisión y reset explícito; nunca caduca por decay.

## Autoridad y privacidad

`admin_reset_caller_security_state_v1` está revocada para `PUBLIC`, `anon`, `authenticated` y `service_role`. Debe ejecutarse como administrador Postgres mediante un canal administrativo autorizado.

Antes de ejecutar:

1. confirmar `tenant_id` y `caller_key` HMAC sin copiar el teléfono al ticket o al SQL;
2. generar fuera de la base un SHA-256 hexadecimal del identificador del operador;
3. asignar un `event_key` único ligado al ticket/cambio;
4. elegir uno de los motivos cerrados: `FALSE_POSITIVE_CONFIRMED`, `AUTHORIZED_TEST_CLEANUP`, `INCIDENT_REMEDIATION` o `DATA_CORRECTION`;
5. requerir una segunda revisión para borrar strikes, historial de rate limit o un bloqueo permanente.

## Reset mínimo recomendado

El reset ordinario pone `risk_score=0` y limpia sólo el bloqueo temporal. Conserva strikes, rate-limit blocks y permanent block:

```sql
select *
from public.admin_reset_caller_security_state_v1(
  p_event_key => '<ticket-idempotency-key>',
  p_tenant_id => '<tenant-id>',
  p_caller_key => '<64-hex-caller-hmac>',
  p_reason => 'FALSE_POSITIVE_CONFIRMED',
  p_admin_actor_hash => '<64-hex-admin-sha256>',
  p_reset_risk_score => true,
  p_reset_security_strikes => false,
  p_reset_rate_limit_blocks => false,
  p_clear_temporary_block => true,
  p_clear_permanent_block => false
);
```

Repetir el mismo `event_key` debe devolver `applied=false` y `DUPLICATE_ADMIN_RESET` sin una segunda mutación.

## Evidencia obligatoria

Comprobar en la misma ventana operativa:

- estado final de `caller_security_state`;
- un único evento `ADMIN_SECURITY_STATE_RESET`;
- motivo cerrado y `admin_actor_hash` presentes;
- valores before/after correctos;
- `raw_transcript_stored=false`;
- ausencia de teléfono, transcript, prompt, token o payload hostil.

No realizar una llamada adversarial para validar el reset. Usar identidades sintéticas o una consulta administrativa controlada.

## Rollback

Antes del deploy, descartar el commit restaura el comportamiento acumulativo actual. Después de aplicar la migración, cualquier reversión debe ser una migración forward que restaure las definiciones anteriores de las RPC y retire la función administrativa; no editar el historial aplicado ni ejecutar un reset masivo.
