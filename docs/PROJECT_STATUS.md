# IA_RealTime_CenterCall — estado operativo

> Snapshot documental: 2026-09-28
> Base remota auditada: `rebuild/v39-stable-baseline` @ `19049d7d06260c9e9dfa6fa50fb0e8f4330a37c4`
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
| Autoridad temporal horizontal | sí; Core neutral y adapter Fast compatible | 24/24 focalizadas, Control Plane 87/87, Media Edge 116/116 y PR `#106` verde | desplegado por run `36356056366` | preflights, bootstrap/HMAC y URL general PASS; no requiere llamada porque el wire no cambió |

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

1. verificar con una identidad administrativa la ejecución programada de `SEC-P1-04` y sus contadores; el conector de esta auditoría devolvió `permission denied` y no permite cerrarla;
2. almacenamiento compartido y atómico antes de escalar horizontalmente;
3. completar verticales mediante contratos Gemini-native.

## Coste y escalado

La revisión efectiva auditada es `gemini-media-edge-00230-diw`, con 100 % del
tráfico general, tag `fast-19049d7d0626`, 1 vCPU, 512 MiB,
`containerConcurrency=25`, `minScale=1` y `maxScale=1`. El Worker efectivo
apunta a la URL etiquetada de esa revisión. La rama estable remota está en un SHA
fusionado; el workflow `36356056366` comprobó el SHA exacto, readiness,
bootstrap/HMAC, paridad del token de seguridad y la URL general. El límite
`maxScale=1` sigue siendo obligatorio mientras credential/bootstrap/sesión sean
in-memory. Reducir `minScale` durante pruebas es una operación de infraestructura,
no un estado que pueda inferirse de este documento, y un despliegue integral
puede restablecer la configuración declarada.

## Regla de latencia

Está prohibido añadir inferencia, RPC, persistencia, espera, buffer o
transformación síncrona al hot path sin baseline, presupuesto y p50/p95/p99.
Seguridad y auditoría son sideband cuando la invariante lo permite.

## Siguiente validación

Para cerrar la validación operativa de `SEC-P1-04` con una identidad que tenga
acceso a `cron` y al esquema `private`:

1. comprobar la primera ejecución del cron después de las 03:17 UTC;
2. verificar `total_deleted <= max_rows` y ausencia de identidad en la auditoría;
3. revisar los contadores de bloqueos permanentes y callbacks pendientes;
4. volver a ejecutar los advisors sin realizar llamada.

`SEC-P1-05` quedó cerrado con esta evidencia:

1. contrato horizontal 3/3 y workflows propietarios afectados en verde;
2. migraciones aplicadas por el canal administrativo de Supabase;
3. `pg_default_acl` global y de `public` contiene únicamente a `postgres`;
4. el gate exige registro y permisos explícitos para cada función nueva.
