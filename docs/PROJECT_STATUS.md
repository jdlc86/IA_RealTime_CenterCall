# IA_RealTime_CenterCall — estado operativo

> Snapshot documental: 2026-08-30
> Base remota auditada: `rebuild/v39-stable-baseline` @ `e8c1bb1406d0213565a3967b34ce8ea171d83adc`
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
| Limpieza de legado | en esta rama | pendiente | no aplica | no aplica |

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

Backlog abierto:

1. almacenamiento compartido y atómico antes de escalar horizontalmente;
2. política de cierre ante ataque semántico de alta confianza;
3. suite de regresión de seguridad consolidada;
4. retención y borrado de datos de seguridad;
5. completar verticales mediante contratos Gemini-native.

## Coste y escalado

Cloud Run está diseñado con `max-instances=1` mientras credential/bootstrap/sesión
sean in-memory. `min-instances=0` puede usarse manualmente en etapa de pruebas;
el workflow integral restablece su configuración declarada.

## Regla de latencia

Está prohibido añadir inferencia, RPC, persistencia, espera, buffer o
transformación síncrona al hot path sin baseline, presupuesto y p50/p95/p99.
Seguridad y auditoría son sideband cuando la invariante lo permite.

## Siguiente validación

Después de fusionar esta limpieza:

1. ejecutar CI de ambos componentes;
2. confirmar que sólo permanecen workflows Fast;
3. lanzar `Gemini Fast Canary Deploy` únicamente si se desea actualizar producción;
4. no realizar llamada real hasta autorización expresa.
