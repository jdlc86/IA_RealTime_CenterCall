# D3/D5 — Authorization quarantine y trust recovery

> **Estado:** HISTÓRICO / NO BASELINE DEL FAST PATH  
> **Fecha original:** 2026-08-26  
> **Archivado:** 2026-08-27  
> **Runtime vigente:** [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

D3/D5 definió `TurnAuthorizationQuarantine` y trust recovery para una arquitectura en la que Gemini recibía audio mientras Google STT/Control Plane decidían posteriormente si el turno podía liberar output/effects.

Ese mecanismo resolvía una tensión real de aquel diseño, pero **no forma parte obligatoria del camino conversacional normal Gemini Fast**.

## Qué cambió

ADR-004 eliminó como baseline por-turno:

- Google STT externo como autoridad previa;
- `TURN_AUTHORIZED` remoto para cada turno;
- quarantine de cada respuesta Gemini;
- trust recovery asociado a un turno rechazado por ese gate.

El Fast Media Edge mantiene el camino audio→audio directo con Gemini Live y aplica validaciones deterministas cuando una tool/effect concreta lo requiere.

## Principios que sobreviven

- un efecto no autorizado no puede salir al mundo externo;
- identidad/grounding/tenant/capability deben verificarse donde corresponda;
- no se utilizan timers para resolver causalidad;
- un estado contaminado no debe reutilizarse si una política vigente demuestra que no es confiable;
- fail closed para efectos sensibles no significa introducir un gate remoto en cada chunk/turno de audio.

## Handoff actual

La transferencia humana actual no usa una lista de frases ni D3/D5 por turno. Gemini declara autoridad semántica y evidencia; el kernel verifica grounding sobre el transcript snapshot del tool call antes de autorizar el efecto.

Ver [`../HUMAN_HANDOFF.md`](../HUMAN_HANDOFF.md).

## Uso correcto

Conservar este documento sólo como referencia de una solución histórica. No reintroducir quarantine/trust recovery en Fast para resolver un bug de control sin demostrar que el problema exige ese mecanismo y sin una nueva decisión arquitectónica.

El detalle original permanece en el historial Git.