# D1 — Transcript authority del producto Gemini independiente

> **Estado:** DECISIÓN BASELINE CERRADA / optimización A-B diferida  
> **Fecha:** 2026-08-26  
> **Autoridad:** ADR-003 + `GEMINI_INDEPENDENT_RUNTIME_DESIGN.md` + `GEMINI_INDEPENDENT_RUNTIME_DESIGN_REVIEW.md`

## Decisión

Para la primera implementación del producto Gemini independiente:

1. **Google Cloud Speech-to-Text v2 permanece como autoridad textual del caller turn para seguridad y autorización de tools.**
2. **Gemini Live `inputAudioTranscription` se habilitará únicamente como señal auxiliar/no autoritativa** cuando aporte diagnóstico o benchmark.
3. El audio del caller seguirá entrando en Gemini Live en tiempo real; Google STT corre **en paralelo** sobre el candidato bounded del Media Edge.
4. La latencia de Google STT bloquea únicamente la liberación de efectos/output sujetos al gate, no la ingestión/procesamiento de audio por Gemini Live.
5. No se introduce un timer para declarar “final” una transcripción Gemini.
6. No se elimina Google STT hasta que un dark benchmark efímero demuestre una alternativa con una señal de finality/ordering suficiente para las invariantes del producto.

## Evidencia contractual

### Gemini Live

La API Live permite `inputAudioTranscription`, pero la referencia oficial de `BidiGenerateContentServerContent` establece que la transcripción de entrada se envía **independientemente de los demás mensajes y sin ordering garantizado**.

`BidiGenerateContentTranscription` expone actualmente sólo el campo `text`; no existe en ese contrato un `is_final`/`finished` autoritativo que permita cerrar de forma determinista nuestro caller candidate.

Además, realtime input está optimizado para capacidad de respuesta y el ordering entre streams no está garantizado. Estas propiedades son válidas para una experiencia conversacional nativa, pero insuficientes por sí solas para convertir `inputAudioTranscription` en autoridad de seguridad/efectos empresariales.

### Google Speech actual

`apps/gemini-media-edge/src/google-speech.mjs` usa Google Speech-to-Text v2 `recognize` sobre el candidato PCM16/16 kHz completo y devuelve un resultado cerrado `{ itemId, transcript }` o fallo explícito.

Por tanto el caller candidate tiene una frontera determinista:

```text
VAD/activity end
→ candidato PCM cerrado
→ Google STT recognize
→ transcript completo o fallo
→ security/tool authorization
```

En el runtime nuevo, en paralelo:

```text
caller PCM ───────────────→ Gemini Live (inmediato)
     │
     └→ bounded candidate → Google STT → authority gate
```

## Evidencia de latencia real

Consulta agregada de `public.call_diagnostic_events`, últimos 7 días, `component='google-speech'`:

```text
STT_COMPLETED samples  37
p50 duration            445.0 ms
p95 duration            598.4 ms
average                 457.7 ms
min                     324 ms
max                     648 ms
STT_FAILED              1
STT_EMPTY_TRANSCRIPT     3
audio candidate p50     1160 ms
audio candidate p95     2096 ms
```

No se consultó ni persistió audio para esta decisión.

Interpretación: aproximadamente medio segundo de autoridad STT después de cerrar el candidato es un coste relevante, pero aceptable como baseline seguro porque el nuevo diseño ya no obliga a esperar ese STT antes de enviar audio a Gemini Live.

## Por qué no usar Gemini transcription como authority ahora

No hay evidencia contractual suficiente para mapear de forma determinista:

```text
inputTranscription fragment(s)
→ EXACT caller turn final transcript
```

sin introducir heurísticas temporales u ordering asumido.

Eso violaría las reglas del proyecto:

- no timers para esconder ordering;
- one state owner per concern;
- tools/efectos requieren caller evidence autoritativa;
- fail closed en identidad/finality dudosa.

## Dark benchmark posterior

La comparación de calidad/WER no se hará con audio inventado ni almacenando llamadas reales.

Durante Fase 3 se podrá ejecutar un **dark probe efímero** sobre el mismo audio bounded que ya existe en memoria durante una llamada de prueba:

```text
mismo PCM temporal
  ├→ Google STT v2
  └→ Gemini inputAudioTranscription
```

Persistir únicamente métricas no conversacionales:

- provider/path;
- elapsed ms;
- fragment count;
- transcript-present boolean;
- bounded agreement score/hash-derived metric si puede hacerse sin reconstruir texto;
- error category.

No persistir raw transcript adicional ni audio.

Si se evalúa Google Speech streaming, será una optimización separada. La documentación de Google recomienda Speech-to-Text dedicado para transcripción realtime, por lo que puede ser candidato para reducir el ~445/598 ms del `recognize` batch sin sacrificar una frontera STT especializada.

## Criterio para sustituir Google STT

Sólo sustituir la autoridad actual si una alternativa demuestra conjuntamente:

1. finality/turn binding determinista;
2. ordering compatible con caller-turn identity;
3. calidad telefonía/español igual o mejor;
4. split-utterance behavior aceptable;
5. latencia p95 materialmente mejor;
6. fail-closed claro;
7. ninguna relajación de seguridad/tool authorization.

## Resultado D1

**Baseline Fase 3:** Google Speech v2 autoritativo + Gemini Live audio en paralelo.

**Gemini input transcription:** auxiliar/no autoritativa hasta evidencia posterior.

D1 deja de bloquear el cierre arquitectónico de Fase 2. La optimización A/B queda como tarea de Fase 3, no como requisito para crear el runtime independiente.
