# IA_RealTime_CenterCall — estado operativo

> Snapshot documental: 2026-08-31
> Base remota auditada: `rebuild/v39-stable-baseline` @ `9a9e2d0723dfd5acced8f9fb3eb1cf2c4148e7e7`
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
| Cierre semántico de alta confianza | en esta rama local | pendiente | no desplegado | no ejecutado |

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

En la rama local de trabajo se añade una política de cierre semántico de alta
confianza aún no desplegada: exige tres function calls autorizadas y distintas
en la misma llamada, ignora replay por `toolCallId`, ordena una despedida segura
y sólo después solicita al Fast Worker el hangup Telnyx. La decisión local es
O(1), acotada y sin RPC; el único RPC nuevo ocurre en la ruta excepcional de
ataque. Si ese control terminal falla, la sesión reanuda audio en vez de quedar
muda. La reputación de alta confianza se registra sideband sin transcript bruto.

Backlog abierto:

1. almacenamiento compartido y atómico antes de escalar horizontalmente;
2. desplegar y validar E2E la política de cierre semántico de alta confianza;
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

Para completar el bloque local de cierre semántico:

1. revisar y fusionar el cambio tras CI de ambos componentes;
2. lanzar `Gemini Fast Canary Deploy` únicamente si se desea actualizar producción;
3. verificar Worker, revisión efectiva y diagnósticos terminales;
4. realizar una llamada E2E controlada sólo con autorización expresa;
5. comprobar tres incidentes distintos, despedida, hangup, señal HIGH e inexistencia de transcript bruto.
