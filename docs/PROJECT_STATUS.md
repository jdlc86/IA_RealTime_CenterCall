# IA_RealTime_CenterCall — estado operativo

> Snapshot: 2026-08-26  
> Para continuar: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md)  
> Decisión vigente: [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./architecture/ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> Plan activo: [`OPENAI_GEMINI_SEPARATION_WORKPLAN.md`](./architecture/OPENAI_GEMINI_SEPARATION_WORKPLAN.md)

Los datos remotos deben verificarse al comenzar cualquier sesión. Este archivo distingue implementación, CI, Producción y E2E; ningún estado sustituye a otro.

## Baseline actual

```text
rama   rebuild/v39-stable-baseline
PR     #85 — debe permanecer OPEN / DRAFT
HEAD   verificar en GitHub al comenzar
```

La integración híbrida OpenAI/Gemini existente sigue siendo evidencia ejecutable útil, pero **ya no es la arquitectura objetivo**.

## Cambio de dirección aprobado — 2026-08-26

Se adoptan dos productos realtime independientes:

```text
OPENAI PRODUCT                      GEMINI PRODUCT
OpenAI Worker                       Gemini Worker
OpenAI runtime                      Gemini runtime
OpenAI lifecycle                    Gemini lifecycle
OpenAI tool flow                    Gemini tool flow
OpenAI audio/voz                    Gemini audio/voz
       │                                   │
OpenAI Realtime                     Gemini Media Edge
                                            │
                                       Gemini Live
```

Ambos productos utilizan en esta fase el mismo Supabase y los mismos contratos de dominio/persistencia realmente neutrales.

No es requisito actual ejecutar ambos productos simultáneamente para un mismo cliente. Un cliente Gemini podrá operar sin runtime, secretos ni dependencias OpenAI; un cliente OpenAI podrá operar sin runtime, secretos ni dependencias Gemini.

## Estado por preocupación

| Área | Implementado | CI | Producción | E2E |
|---|---:|---:|---:|---:|
| ADR-003: runtimes independientes | ✅ | docs CI pendiente del SHA actual | n/a | n/a |
| Plan operativo persistente de separación | ✅ | docs CI pendiente del SHA actual | n/a | n/a |
| Supabase compartido en esta fase | ✅ decisión | n/a | ✅ base actual | ya utilizada por ambos caminos de prueba |
| Worker OpenAI independiente/limpio | ❌ pendiente | — | Worker existente sigue operativo | baseline previa existe; revalidar tras limpieza |
| Worker Gemini independiente | ❌ pendiente | — | ❌ | ❌ |
| Gemini Media Edge | existe implementación actual | verificar CI/deploy antes de usar | existe despliegue previo | evidencia previa; será revalidado bajo nuevo runtime |
| Inventario arquitectónico proveedor por proveedor | ❌ próxima fase | — | n/a | n/a |
| Limpieza posterior del Worker OpenAI | ❌ bloqueada hasta Gemini independiente | — | — | — |

## Interpretación del código actual

El código alojado hoy en el Worker principal **no se considera automáticamente arquitectura óptima**.

Durante la historia del proyecto se añadieron capas para:

- necesidades específicas de OpenAI;
- compatibilidad entre generaciones;
- abstracciones provider-neutral;
- incorporación progresiva de Gemini;
- hardening de concurrencia, seguridad y observabilidad.

Cada pieza se evaluará por su propósito real. El inventario utilizará estas etiquetas:

```text
SHARED_DOMAIN
OPENAI_NATIVE
GEMINI_NATIVE
LEGACY_COMPAT_REDESSIGN
UNRESOLVED
```

El hardening general útil no se elimina por asociación con Gemini. La lógica específica de convivencia híbrida sí será candidata a retirada cuando la separación esté probada.

## Plan activo por fases

1. **Fase 0 — documentación y decisión:** prácticamente completada.
2. **Fase 1 — inventario arquitectónico:** próxima misión; no mover runtime todavía.
3. **Fase 2 — diseño detallado del Gemini Worker independiente.**
4. **Fase 3 — construcción/migración Gemini y E2E autónomo.**
5. **Fase 4 — limpieza y optimización del Worker OpenAI.**
6. **Fase 5 — CI/deploy/secrets separados.**
7. **Fase 6 — N bases/coexistencia/failover sólo si aparece requisito futuro.**

Checklist detallado: [`OPENAI_GEMINI_SEPARATION_WORKPLAN.md`](./architecture/OPENAI_GEMINI_SEPARATION_WORKPLAN.md).

## Siguiente validación

La siguiente tarea **no es corregir G3/G4 ni continuar estabilizando la arquitectura híbrida**.

La próxima sesión debe:

1. verificar HEAD remoto, PR #85 y CI del SHA exacto;
2. leer ADR-003 y el plan de separación;
3. crear `docs/architecture/PROVIDER_RUNTIME_INVENTORY.md`;
4. inventariar entrypoints, Workers, Media Edge, lifecycle, response coordination, turn ownership, tool flow, OpenAI adapters, Gemini branches/sideband, dominio, Supabase, observabilidad y Telnyx;
5. clasificar cada componente sin mover código todavía;
6. marcar el progreso en el checklist antes de cerrar.

## Restricciones vigentes

- Un único PR: #85.
- Una única rama: `rebuild/v39-stable-baseline`.
- No merge, no ready-for-review, no force-push, no reescritura de historia.
- No crear otro Worker mediante ramas/PR paralelos; todo el trabajo continúa en esta línea hasta nueva decisión.
- No copiar automáticamente la arquitectura OpenAI al nuevo Gemini Worker.
- No asumir que el Worker OpenAI actual es óptimo; será auditado posteriormente.
- No seguir corrigiendo defectos híbridos si el código será reemplazado, salvo bloqueo de la separación o impacto compartido demostrado.
- Supabase permanece compartido en esta fase.
- No introducir coexistencia/failover OpenAI↔Gemini sin requisito y ADR posterior.
- No confundir `IMPLEMENTADO`, `CI`, `Producción` y `E2E`.

## Evidencia reciente útil

La última llamada Gemini previa al cambio de paradigma demostró que la ruta híbrida podía avanzar hasta reserva progresiva y disponibilidad, pero aún exponía divergencias de lifecycle/post-tool y mezcla de identidad vocal. Esos fallos se conservan como evidencia para diseñar Gemini nativo; no constituyen por sí solos mandato para seguir parchando el runtime híbrido.
