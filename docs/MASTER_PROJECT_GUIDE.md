# IA_RealTime_CenterCall — Master Project Guide

> **Ruta estable de compatibilidad. No renombrar ni eliminar.**  
> **Última revisión:** 2026-08-28  
> **Carácter:** índice/visión; **no es fuente de verdad del despliegue actual**.

Este archivo orienta hacia la documentación propietaria. No debe duplicar la arquitectura, el estado operativo ni un diario de commits.

## Continuar el trabajo

Leer en este orden:

1. [`README.md`](./README.md) — mapa documental actual/histórico.
2. [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — realidad operativa, limitaciones y siguiente validación.
3. [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md) — prompt para continuar otra sesión.
4. [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md) — resumen de productos y fronteras actuales.
5. [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md) — topología estable actual.
6. [`architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md) cuando el trabajo afecte Gemini.
7. [`architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md) — restricciones no negociables.
8. [`DOCUMENTATION_MAINTENANCE.md`](./DOCUMENTATION_MAINTENANCE.md) — reglas de fuente de verdad documental.
9. El runbook, código y tests exactos del componente que vaya a modificarse.

Antes de escribir/deployar, comprobar rama, HEAD remoto, PR #85, CI del SHA y los sistemas remotos que sean relevantes.

## Coordenadas estables

```text
repo       jdlc86/IA_RealTime_CenterCall
rama       rebuild/v39-stable-baseline
PR         #85 (base main; verificar estado remoto)
Supabase   vutekfkbtvfogouwcfvc
```

No existe un único `entrypoint` o `Worker` que represente a todo el proyecto.

### Producto OpenAI

```text
apps/control-plane
apps/media-edge
Worker histórico/principal: ia-realtime-centercall
```

### Producto Gemini

```text
apps/gemini-control-plane
apps/gemini-media-edge
Worker Fast: ia-realtime-centercall-gemini-fast
Media Edge Fast: Cloud Run revision etiquetada, seleccionada por binding del Worker
```

La separación está definida por ADR-003 y el Fast Path Gemini por ADR-004.

## Principio operativo

```text
evidencia
→ identificar producto/capa/owner correcto
→ cambio mínimo
→ pruebas aplicables
→ CI del SHA
→ deploy exacto
→ verificar routing/binding efectivo
→ E2E cuando el comportamiento es telefónico/acústico
```

No confundir código existente con código conectado al runtime actual.

## Arquitectura en una vista

```text
                        GitHub / CI
                            │
            ┌───────────────┴────────────────┐
            │                                │
            ▼                                ▼
      Producto OpenAI                  Producto Gemini Fast
      Control Plane                    Fast Worker
            │                                │ control/admission
            ▼                                ▼
      OpenAI Realtime         Telnyx media ↔ Fast Media Edge ↔ Gemini Live

                     └──────── dominio/persistencia neutral ────────┘
                                      │
                                   Supabase
```

Cloudflare queda fuera del audio continuo.

## Estado de documentación histórica

La documentación contiene fases, reviews, snapshots y ADR antiguas útiles para trazabilidad. No todas describen el runtime actual.

Especial atención a:

- `architecture/GEMINI_PHASE3_PROGRESS.md` — archivado/superado;
- ADR-002 — explica por qué existe un Media Edge, pero sus gates previos al Fast Path quedaron superados;
- handoffs fechados — snapshots inmutables;
- módulos Gemini híbridos en código — existencia no demuestra participación en `fast-runtime`.

Usar `README.md` para distinguir lectura actual de historial.

## Transferencia humana

La documentación propietaria es [`HUMAN_HANDOFF.md`](./HUMAN_HANDOFF.md).

Principios de alto nivel:

- Gemini interpreta lenguaje natural;
- la política Fast valida enum de autoridad + grounding textual, no listas de “sí/vale/adelante”;
- la política actual no mantiene `offerPending` ni prueba por sí sola el antecedente de `CONFIRMED_OFFER`;
- transcript/evidencia se snapshottean antes de la ejecución asíncrona del tool;
- destino/capability pertenecen a configuración/backend;
- handoff aceptado es lifecycle terminal para la IA;
- auditoría en `public.human_handoff_events`.

Las limitaciones vivas de transferencia no se duplican aquí; consultar `HUMAN_HANDOFF.md` y `PROJECT_STATUS.md`.

## Diagnóstico

Fuentes principales:

```text
public.call_diagnostic_events
public.human_handoff_events
```

Una investigación debe separar control, media y experiencia acústica. El procedimiento exacto vive en [`runbooks/CROSS_PLANE_CALL_DIAGNOSTICS.md`](./runbooks/CROSS_PLANE_CALL_DIAGNOSTICS.md).

## Recuperación

Existe un snapshot histórico pre-Gemini para comparación de regresiones:

```text
stable/pre-gemini-2026-08-19
```

No hacer rollback ciego. Primero demostrar qué capa/regresión necesita contención y restaurar el componente/binding correspondiente.

## Regla de cierre

Si una sesión cambia:

- arquitectura → ADR/System Architecture/Design Rules;
- estado operativo → `PROJECT_STATUS.md`;
- próxima misión → `SESSION_HANDOFF.md`;
- procedimiento → runbook;
- handoff → `HUMAN_HANDOFF.md`;
- navegación/autoridad → `README.md`.

No copiar el mismo estado en todos ellos.
