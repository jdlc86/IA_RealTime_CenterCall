# IA_RealTime_CenterCall — estado operativo

> Snapshot documental: 2026-09-30
> Base remota auditada: `rebuild/v39-stable-baseline` @ `734b3b4fda7ae84b35270c1c813ccafb7171f8d8`
> Runtime de producción auditado: merge SHA `98b62a4dbf0456b13219cb945b544b67f41a88e6`, run `36375878767`, revisión `gemini-media-edge-00237-neb`
> Seguridad viva: [guía de seguridad](../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx)

Los datos remotos deben volver a verificarse antes de operar producción.

## Baseline

| Área | Implementado | CI | Producción | E2E |
|---|---:|---:|---:|---:|
| Gemini Fast Worker | sí | runs `36376199946` y `36376202023` verdes en la base auditada | desplegado | PASS A–G previo; health del Worker no sustituye una llamada |
| Fast Media Edge | sí | run `36376202014` verde en la base auditada | `gemini-media-edge-00237-neb`, ready y 100 % | PASS A–G previo; `/ready` verificado el 2026-09-30 |
| Caller-security admission | sí | verde | desplegado | sonda y llamada verificadas |
| Tool authorization receipts | sí | verde | desplegado | transferencia verificada |
| Diagnóstico con allowlist | sí | verde | desplegado | sonda post-deploy PASS |
| Reputación/decay Supabase | sí | verde | migración aplicada | prueba transaccional PASS |
| Limpieza de legado | sí | verde | no aplica | no aplica |
| Cierre semántico de alta confianza | sí | verde | desplegado | llamada real: cierre y drain confirmados |
| Regresión de seguridad | sí | gate transversal `36376202007` verde; suites propietarias verdes | no aplica | 103 Media Edge, 64 Control Plane y 3 contrato PostgreSQL PASS local el 2026-09-30 |
| Retención y borrado `SEC-P1-04` | sí | PR `#102`; contrato 6/6 y validación PostgreSQL 17 PASS; CI previo verde | migraciones `20260913082816` y `20260913091400` aplicadas; cron activo | no aplica al flujo de llamada |
| Límite horizontal de funciones PostgreSQL `SEC-P1-05` | sí | contrato 3/3, PostgreSQL 17 y CI PASS; PR `#103`/`#104` | migraciones `20260913193440` y `20260913193454` aplicadas; ACL verificado | no aplica al flujo de llamada |
| Autoridad temporal horizontal | sí; Core neutral y adapter Fast compatible | PR `#106`; suites actuales Control Plane 96/96 y Media Edge 116/116 | incluida en la revisión efectiva `00237-neb` | preflights previos PASS; no requiere llamada porque el wire no cambió |
| WhatsApp transaccional Meta | canary horizontal; adapter, capability y allowlist tenant | PR `#108`; configuración exclusivamente tenant-owned en PR `#110`; Control Plane 96/96 | Worker desplegado por run `36375878767`; Media Edge `00237-neb` promovido | health/configuración/preflights PASS; sin envío real, webhook ni prueba de entrega |

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
El workflow `Gemini Security Regression Gate` no vuelve a ejecutar las suites
de los ejecutables: valida los contratos transversales que no pertenecen a uno.
En el snapshot actual son 3 pruebas del límite de funciones PostgreSQL. Esta
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
3. convertir el canary WhatsApp en outbox durable con claim atómico, reconciliación y webhooks antes de conectarlo a citas reales;
4. ampliar el filtro `paths` del workflow integral para incluir el módulo `apps/gemini-control-plane/src/communications/**`; hasta entonces, un cambio aislado allí exige `workflow_dispatch` explícito;
5. completar verticales mediante contratos Gemini-native.

## Coste y escalado

La revisión efectiva auditada es `gemini-media-edge-00237-neb`, con 100 % del
tráfico general, tag `fast-98b62a4dbf04`, 1 vCPU, 512 MiB,
`containerConcurrency=25`, `minScale=1` y `maxScale=1`. El Worker efectivo
apunta a la URL etiquetada de esa revisión. La rama estable contiene ese SHA de
runtime y documentación posterior; el workflow `36375878767` comprobó el SHA exacto, readiness,
bootstrap/HMAC, paridad del token de seguridad y la URL general. El límite
`maxScale=1` sigue siendo obligatorio mientras credential/bootstrap/sesión sean
in-memory. Reducir `minScale` durante pruebas es una operación de infraestructura,
no un estado que pueda inferirse de este documento, y un despliegue integral
puede restablecer la configuración declarada.

El 2026-09-30, `/health` del Worker respondió con diagnóstico y WhatsApp
configurados, y `/ready` del Media Edge respondió con modelo
`gemini-3.1-flash-live-preview`, revisión `00237-neb` y cero sesiones activas.
Estas sondas prueban readiness/configuración, no una conversación ni entrega
WhatsApp E2E.

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
