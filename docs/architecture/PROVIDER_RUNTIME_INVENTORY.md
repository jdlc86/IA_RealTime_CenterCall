# Inventario de runtime — separación OpenAI / Gemini

> **Estado:** ARCHIVADO / INVENTARIO DE FASE 1  
> **Fecha original:** 2026-08-26  
> **Archivado:** 2026-08-27  
> **Decisión resultante:** [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)

Este inventario se creó **antes de la separación física** para clasificar piezas del runtime OpenAI-first y decidir qué podía ser compartido, rediseñado o separado.

Ya no está `ACTIVO / EN PROGRESO`.

## Resultado principal

El inventario ayudó a confirmar que:

- OpenAI y Gemini debían tener productos/runtimes independientes;
- dominio/persistencia podían compartirse sólo cuando fueran neutrales;
- varias abstracciones del runtime antiguo eran compatibilidad histórica, no arquitectura objetivo;
- Gemini necesitaba Media Edge propio;
- no debía copiarse automáticamente lifecycle/wire OpenAI a Gemini.

La separación estructural ya existe en:

```text
apps/control-plane
apps/media-edge
apps/gemini-control-plane
apps/gemini-media-edge
```

## Límite temporal

Las clasificaciones del inventario describen el repositorio observado en la Fase 1. No deben usarse para afirmar que un archivo sigue conectado al runtime actual.

Especialmente, la presencia de módulos Gemini históricos no demuestra que participen en `fast-runtime.mjs`.

## Fuentes actuales

Para el presente consultar:

- [`SYSTEM_ARCHITECTURE.md`](./SYSTEM_ARCHITECTURE.md)
- [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)
- [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md)

El inventario detallado original permanece en el historial Git.