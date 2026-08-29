# ADR-003 — Sistemas OpenAI y Gemini independientes con dominio y Supabase compartidos

> **Estado:** Aceptado — separación estructural IMPLEMENTADA
> **Fecha:** 2026-08-26
> **Implementación confirmada documentalmente:** 2026-08-27
> **Ámbito:** arquitectura de producto / realtime / control plane / media plane / persistencia
> **Complementado por:** [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

## Contexto

OpenAI Realtime y Gemini Live difieren materialmente en lifecycle, tools, turn ownership, reconnect, barge-in, generación de audio y correlación de eventos. Intentar hacer que ambos compartan un único runtime conversacional generó traducciones y excepciones que perjudicaban claridad, estabilidad y latencia.

El producto tampoco necesita actualmente cambiar de provider dentro de una misma llamada.

## Decisión

Se mantienen **dos productos de ejecución realtime independientes**.

```text
PRODUCTO OPENAI
PSTN
  ↕
Telnyx
  ↕
OpenAI Control Plane / runtime
  ↕
OpenAI Realtime

PRODUCTO GEMINI
PSTN
  ↕
Telnyx
  ↕ signaling/control
Gemini Fast Worker
  ↕ admission/control
Gemini Fast Media Edge
  ↕ audio realtime
Gemini Live
```

Los dos productos pueden compartir repositorio, dominio y persistencia cuando esas piezas sean realmente neutrales, pero **no comparten runtime conversacional ni estado efímero de llamada**.

## Implementación actual

La separación física ya existe en el repositorio:

```text
OpenAI:
  apps/control-plane
  apps/media-edge

Gemini:
  apps/gemini-control-plane
  apps/gemini-media-edge
```

Gemini dispone además de pipelines, Worker y Media Edge Fast propios. La ruta Gemini ha atendido llamadas reales, por lo que el estado histórico “implementación pendiente” ya no es válido.

ADR-004 define qué mecanismos internos usa actualmente el producto Gemini y supersede la arquitectura híbrida/por-turno anterior donde corresponda.

## Qué se comparte

Puede compartirse cuando exista un contrato neutral real:

- conceptos de tenant y dominio empresarial;
- persistencia/Supabase;
- schemas de negocio;
- principios de autorización/seguridad;
- convenciones de observabilidad;
- adapters de sistemas empresariales que no dependan del runtime de voz.

Compartir no significa forzar idénticos owners, lifecycle o wire protocol.

## Qué no se comparte por defecto

- sockets realtime;
- buffers/audio state;
- VAD/turn state;
- lifecycle específico de respuesta;
- wire events de provider;
- IDs propietarios;
- reconnect/resumption state;
- secretos de provider;
- estado efímero de llamada.

## Supabase

En esta fase puede seguir existiendo una base/persistencia compartida para ambos productos. Esto es una decisión operativa independiente de la separación de runtimes.

No se introduce N-Supabase, replicación o failover cross-provider sin requisito y ADR posterior.

## No failover OpenAI↔Gemini a mitad de llamada

La selección de provider queda fijada para la llamada. No se implementa failover entre OpenAI y Gemini sin demostrar cómo preservar de forma segura:

- contexto conversacional;
- tool state;
- effects/idempotency;
- playback/audio pendiente;
- ownership del turno;
- seguridad y tenant binding.

## Consecuencias

### Positivas

- menor acoplamiento entre providers;
- evolución independiente;
- optimización Gemini sin penalizar OpenAI;
- menor riesgo de traducir falsamente conceptos de un provider al otro;
- debugging más claro por runtime.

### Costes

- cierta duplicación de infraestructura/runtime es deliberada;
- algunas capacidades necesitan pruebas separadas por provider;
- la documentación debe indicar explícitamente a qué producto aplica un mecanismo.

## Regla documental

No usar este ADR para inferir el hot path concreto de Gemini. Para eso prevalece ADR-004 y [`SYSTEM_ARCHITECTURE.md`](./SYSTEM_ARCHITECTURE.md).

No usar módulos históricos del repositorio para concluir que ambos products siguen compartiendo el mismo runtime: la estructura de aplicaciones independientes es la decisión vigente.