# Gemini Worker ↔ Media Edge Control Contract v1

> **Estado:** HISTÓRICO / NO NORMATIVO PARA GEMINI FAST  
> **Fecha original:** 2026-08-26  
> **Archivado:** 2026-08-27  
> **Runtime vigente:** [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

`gemini-control.v1` documentó la frontera Worker↔Media Edge de una arquitectura Gemini independiente anterior al Fast Path. En esa arquitectura, `GeminiCallSession`/Worker participaban de forma mucho más estrecha en el lifecycle de cada turno.

**No debe tratarse como protocolo obligatorio del Fast Path actual.**

## Principios que siguen vigentes

Aunque el protocolo concreto quedó superado para Fast, siguen siendo válidos:

- Cloudflare no transporta audio;
- identidad/call/tenant explícitos en efectos;
- ordering por evidencia/sequence, no sleeps;
- idempotencia para efectos;
- secretos y credenciales no se persisten/loguean en bruto;
- reconnect no debe duplicar effects/playback.

Estos principios están consolidados en [`DESIGN_RULES.md`](./DESIGN_RULES.md).

## Qué cambió con Fast Path

El camino normal actual es:

```text
Telnyx media WSS ↔ Fast Media Edge ↔ Gemini Live
```

El Fast Worker sigue siendo necesario para admission, tenant/config, control/tools y diagnóstico, pero **no existe un requisito de que `gemini-control.v1` gobierne cada turno de la conversación**.

## Uso correcto

Consultar este archivo sólo como referencia histórica de un protocolo intermedio. No implementar nuevos mensajes de `gemini-control.v1` para resolver un problema Fast sin una necesidad actual demostrada y una decisión arquitectónica explícita.

El contrato detallado original permanece en el historial Git.