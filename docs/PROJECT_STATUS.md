# IA_RealTime_CenterCall — estado operativo

> Snapshot documental: 2026-09-13
> Base remota auditada: `rebuild/v39-stable-baseline` @ `d0e48b716d250c666e4873633809fe4699f98a28`
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
| Retención y borrado `SEC-P1-04` | sí, local | contrato 5/5, PostgreSQL 17 y baterías 184/184 PASS; CI pendiente | migración no aplicada | no aplica al flujo de llamada |

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

`SEC-P1-03` dispone de un runner común y del workflow
`Gemini Security Regression Gate`. Agrupa pruebas de Media Edge y Control Plane,
exige ambas suites mediante un resultado final único y usa instalaciones cerradas
por lockfile. El Control Plane conserva `--legacy-peer-deps` para evitar el fallo
interno reproducido de npm `Cannot read properties of null (reading 'edgesOut')`.
Este cambio sólo afecta a pruebas y CI; no entra en el runtime ni en el hot path.

`SEC-P1-04` está implementado localmente mediante una función privada de Supabase
y un cron diario. Conserva diagnósticos 7 días, intentos 7 días, señales
ordinarias 30 días, señales HIGH/CRITICAL 90 días y auditorías administrativas
365 días. Elimina estado inactivo sólo con riesgo cero y sin bloqueos. Los
bloqueos permanentes y callbacks pendientes requieren revisión y nunca se borran
automáticamente. El trabajo usa lotes de 1.000 filas, máximo 10.000 por ejecución
y auditoría agregada sin identidad. No modifica Worker, Media Edge ni hot path.

Backlog abierto:

1. almacenamiento compartido y atómico antes de escalar horizontalmente;
2. publicar, aplicar y verificar `SEC-P1-04` mediante PR, CI y migración Supabase;
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

Para publicar `SEC-P1-04`:

1. ejecutar baterías completas y revisar el diff local;
2. crear commit, push y PR sólo con autorización;
3. obtener `Gemini Security Regression Gate` verde;
4. aplicar la migración por el canal administrativo de Supabase sólo con
   autorización expresa;
5. comprobar permisos, cron, primera ejecución y advisors sin realizar llamada.
