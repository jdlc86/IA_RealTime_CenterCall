# IA_RealTime_CenterCall — estado operativo

> Snapshot documental: 2026-09-13
> Base remota auditada: `rebuild/v39-stable-baseline` @ `8ca13cb415bc3596134f6245697b5ccaf5b0cf9e`
> Seguridad viva: [guía de seguridad](../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx)

Los datos remotos deben volver a verificarse antes de operar producción.

## Baseline

| Área | Implementado | CI | Producción | E2E |
|---|---:|---:|---:|---:|
| Gemini Fast Worker | sí | verde en la base auditada | desplegado | PASS A–G previo |
| Fast Media Edge | sí | verde en la base auditada | desplegado | PASS A–G previo |
| Caller-security admission | sí | verde | desplegado | sonda y llamada verificadas |
| Tool authorization receipts | sí | verde | desplegado | transferencia verificada |
| Diagnóstico con allowlist | sí | verde | desplegado | sonda post-deploy PASS |
| Reputación/decay Supabase | sí | verde | migración aplicada | prueba transaccional PASS |
| Limpieza de legado | sí | verde | no aplica | no aplica |
| Cierre semántico de alta confianza | sí | verde | desplegado | llamada real: cierre y drain confirmados |
| Gate consolidado de regresión de seguridad | sí | verde tras PR `#101` | no aplica | ampliado localmente a 157/157 pruebas específicas PASS |
| Retención y borrado `SEC-P1-04` | sí | PR `#102`; contrato 6/6 y validación PostgreSQL 17 PASS; CI previo verde | migraciones `20260913082816` y `20260913091400` aplicadas; cron activo | no aplica al flujo de llamada |
| Límite horizontal de funciones PostgreSQL `SEC-P1-05` | sí | contrato 3/3, PostgreSQL 17 y CI PASS; PR `#103`/`#104` | migraciones `20260913193440` y `20260913193454` aplicadas; ACL verificado | no aplica al flujo de llamada |

## Arquitectura vigente

Sólo existe una ruta ejecutable:

```text
Telnyx → Gemini Fast Worker → Fast Media Edge ↔ Gemini Live
```

La retirada del código histórico no cambia producción por sí sola. El workflow
`Gemini Fast Canary Deploy` continúa siendo la única autoridad de despliegue.

## Seguridad

Controles vigentes:

- firma Telnyx y resolución tenant antes de emitir credenciales;
- caller-security fail-closed antes del inicio;
- bootstrap autenticado y tenant-bound;
- capability exacta por tool;
- recibo opaco ligado a function call, tenant y llamada;
- human handoff con autorización y auditoría;
- diagnóstico con schema cerrado y allowlist;
- cola/DLQ para señales de reputación;
- minimización de datos y ausencia de transcript bruto.

Está desplegada una política de cierre semántico de alta confianza que exige
tres function calls autorizadas y distintas
en la misma llamada, ignora replay por `toolCallId`, ordena una despedida segura
y espera la marca de reproducción Telnyx exacta antes de solicitar al Fast Worker
el hangup. La decisión local es
O(1), acotada y sin RPC; el único RPC nuevo ocurre en la ruta excepcional de
ataque. Si ese control terminal falla, la sesión reanuda audio en vez de quedar
muda. La reputación de alta confianza se registra sideband sin transcript bruto.

`SEC-P1-03` dispone de un runner común para diagnósticos locales focalizados.
Las suites completas pertenecen a los workflows de Media Edge y Control Plane.
El workflow `Gemini Security Regression Gate` no vuelve a ejecutarlas: valida
una sola vez los contratos transversales que no pertenecen a un ejecutable. Esta
separación evita instalaciones y pruebas duplicadas sin reducir la cobertura.

`SEC-P1-04` está desplegado mediante una función privada de Supabase y un cron
diario. Conserva diagnósticos 7 días, intentos 7 días, señales
ordinarias 30 días, señales HIGH/CRITICAL 90 días y auditorías administrativas
365 días. Elimina estado inactivo sólo con riesgo cero y sin bloqueos. Los
bloqueos permanentes y callbacks pendientes requieren revisión y nunca se borran
automáticamente. El trabajo usa lotes de 1.000 filas, máximo 10.000 por ejecución
y auditoría agregada sin identidad. No modifica Worker, Media Edge ni hot path.
La corrección `20260913091400` impide borrar estados con historial de strikes o
bloqueos por rate limit y establece el timeout antes del statement programado.
Los índices de una instalación nueva se construyen de forma concurrente.

`SEC-P1-05` define un límite horizontal para cualquier función PostgreSQL nueva,
sin depender de tenant o vertical. La base revoca globalmente `EXECUTE` a
`PUBLIC` y elimina además los grants de esquema de Supabase para `anon`,
`authenticated` y `service_role` en funciones futuras creadas por `postgres`.
Un manifiesto común clasifica cada función
posterior como `admin`, `internal_server`, `privileged_server`, `public_rpc` o
`trigger`; el gate exige esquema explícito, `search_path=''`, propietario de
capacidad y concesiones exactas. Las funciones anteriores a la activación no se
revalidan en cada PR y se adoptarán por bloques independientes. No se modifica
ninguna función de reservas en este bloque horizontal.

Backlog abierto:

1. verificar la primera ejecución programada de `SEC-P1-04` y sus contadores;
2. almacenamiento compartido y atómico antes de escalar horizontalmente;
3. completar verticales mediante contratos Gemini-native.

## Coste y escalado

Cloud Run está diseñado con `max-instances=1` mientras credential/bootstrap/sesión
sean in-memory. `min-instances=0` puede usarse manualmente en etapa de pruebas;
el workflow integral restablece su configuración declarada.

## Regla de latencia

Está prohibido añadir inferencia, RPC, persistencia, espera, buffer o
transformación síncrona al hot path sin baseline, presupuesto y p50/p95/p99.
Seguridad y auditoría son sideband cuando la invariante lo permite.

## Siguiente validación

Para cerrar la validación operativa de `SEC-P1-04`:

1. comprobar la primera ejecución del cron después de las 03:17 UTC;
2. verificar `total_deleted <= max_rows` y ausencia de identidad en la auditoría;
3. revisar los contadores de bloqueos permanentes y callbacks pendientes;
4. volver a ejecutar los advisors sin realizar llamada.

`SEC-P1-05` quedó cerrado con esta evidencia:

1. contrato horizontal 3/3 y workflows propietarios afectados en verde;
2. migraciones aplicadas por el canal administrativo de Supabase;
3. `pg_default_acl` global y de `public` contiene únicamente a `postgres`;
4. el gate exige registro y permisos explícitos para cada función nueva.
