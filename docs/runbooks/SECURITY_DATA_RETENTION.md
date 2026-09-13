# Retención y borrado de datos de seguridad

> Estado: desplegado en producción mediante `SEC-P1-04`; primera ejecución programada pendiente
> Última revisión: 2026-09-13

## Propósito

Esta política limita la conservación de evidencia técnica, reputación de caller y
auditorías de transferencia. La autoridad de mantenimiento vive en PostgreSQL y
no participa en admission, tools, turnos ni audio.

## Parámetros vigentes

| Datos | Plazo | Condición de borrado |
|---|---:|---|
| `call_diagnostic_events` | 7 días | `created_at` anterior al corte |
| `caller_security_events` de tipo `CALL_ATTEMPT` | 7 días | La ventana operativa máxima es una hora |
| Señales de seguridad ordinarias | 30 días | Severidad distinta de `HIGH` y `CRITICAL` |
| Señales `HIGH` o `CRITICAL` | 90 días | No incluye auditorías administrativas |
| `ADMIN_SECURITY_STATE_RESET` | 365 días | Conserva idempotencia y trazabilidad administrativa |
| `caller_security_state` inactivo | 90 días | Sólo `risk_score=0`, sin bloqueo activo ni permanente |
| Handoff finalizado o callback resuelto | 30 días | Estado terminal y ausencia de callback pendiente |
| Evidencia agregada de la purga | 365 días | Sólo tiempos y contadores |

Los bloqueos permanentes nunca se borran automáticamente. Un bloqueo sin
actividad durante 365 días queda contado como pendiente de revisión. Un callback
pendiente queda contado para revisión después de 30 días y como vencido después
de 90 días. Ninguno se elimina de forma silenciosa.

Estos son los valores comunes del producto. Antes de producción, cada tenant debe
confirmar si sus obligaciones contractuales o sectoriales exigen un plazo
distinto. Una excepción requiere una decisión documentada y una migración
revisada; no se amplían plazos mediante configuración informal.

## Ejecución

La migración `20260913082816_security_retention_and_deletion.sql` instala
`private.run_security_retention_v1` y el cron
`purge-gemini-security-retention-v1` para las 03:17 UTC de cada día.

Cada ejecución:

- admite lotes de 1 a 1.000 filas y usa 1.000 por defecto;
- elimina como máximo 10.000 filas en total;
- alterna categorías para que un backlog no monopolice la ejecución;
- usa `FOR UPDATE SKIP LOCKED`, un advisory lock no bloqueante y un
  `lock_timeout` de 250 ms;
- registra sólo contadores y timestamps en `private.security_retention_runs`;
- sustituye el cron histórico de diagnóstico que hacía un borrado sin límite.

La función usa los privilegios del invocador y está revocada para `PUBLIC`,
`anon`, `authenticated` y `service_role`. Sólo el rol administrativo que instala
el cron puede ejecutarla.

## Comprobación posterior

Ejecutar como administrador PostgreSQL:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname in (
  'purge-redacted-call-diagnostics-7d',
  'purge-gemini-security-retention-v1'
);

select *
from private.security_retention_runs
order by id desc
limit 5;

select status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (
  select jobid from cron.job
  where jobname = 'purge-gemini-security-retention-v1'
)
order by start_time desc
limit 5;
```

El resultado esperado es un solo cron consolidado, ejecuciones `succeeded`,
`total_deleted <= max_rows` y ausencia de datos identificativos en la tabla de
auditoría agregada.

## Revisiones manuales

Los contadores `permanent_blocks_due_review`, `callbacks_due_review` y
`callbacks_overdue_review` de la última ejecución son entradas para revisión
operativa. Si son mayores que cero, un operador autorizado consulta únicamente
las columnas necesarias y aplica el procedimiento de remediación correspondiente.
La revisión de callbacks debe proteger los teléfonos presentes en
`human_handoff_events` y no copiarlos a tickets o diagnósticos generales.

## Validación y despliegue

Antes de aplicar la migración:

1. ejecutar el gate de regresión de seguridad y las baterías completas;
2. revisar el plan de los índices y el volumen de filas candidato;
3. confirmar que existe backup recuperable;
4. aplicar la migración por el canal administrativo de Supabase;
5. comprobar permisos, cron y primera ejecución;
6. ejecutar los advisors de seguridad y rendimiento.

La migración no se aplica mediante `Gemini Fast Canary Deploy`. El despliegue de
Worker y Media Edge no debe utilizarse para inferir el estado de la base.

## Estado productivo

La migración quedó registrada en Supabase con la versión `20260913082816`. La
verificación posterior confirmó una función privada, una tabla privada de
auditoría, un único cron consolidado y la retirada del cron histórico. Los roles
`anon`, `authenticated` y `service_role` no tienen uso del esquema ni permiso de
ejecución sobre la función. La primera purga ordinaria se ejecutará por cron; no
se forzó una purga manual durante el despliegue.

## Recuperación

El borrado de filas no es reversible sin backup. Si el cron produce carga o un
resultado incorrecto, se desactiva mediante `cron.unschedule` y se corrige con
una migración nueva. No se edita una migración ya aplicada. Si fuera necesario
restaurar temporalmente sólo la retención de diagnósticos, se crea un cron
acotado nuevo; no se recupera el borrado histórico sin una decisión explícita.
