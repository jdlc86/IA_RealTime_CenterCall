# ADR-003 — Sistemas OpenAI y Gemini independientes con dominio y Supabase compartidos

> **Estado:** Aceptado — implementación pendiente  
> **Fecha:** 2026-08-26  
> **Ámbito:** arquitectura de producto / realtime / control plane / media plane / persistencia

## Contexto

El sistema nació con OpenAI Realtime como implementación principal. La incorporación posterior de Gemini Live intentó preservar una parte importante del Control Plane, lifecycle, response coordination y contratos neutrales existentes, añadiendo adaptadores y un media edge específico para Gemini.

Las pruebas E2E reales han demostrado que OpenAI Realtime y Gemini Live no sólo difieren en wire protocol. También difieren de forma material en:

- lifecycle de sesión y respuesta;
- semántica de creación/continuación de respuestas;
- tool calling y continuación post-tool;
- ownership del turno;
- reconexión;
- barge-in e input detection;
- generación y reproducción de audio;
- identidad vocal;
- correlación de eventos y finalización.

Forzar ambas implementaciones a compartir la misma orquestación conversacional está introduciendo traducciones y excepciones cuyo coste y riesgo superan el beneficio de la reutilización.

Además, el objetivo comercial no exige en esta fase que OpenAI y Gemini coexistan activos simultáneamente para un mismo cliente. Un despliegue de cliente basado en Gemini puede no utilizar OpenAI en ningún momento, y viceversa.

## Decisión

Se adoptan **dos sistemas de ejecución realtime independientes**, uno para OpenAI y otro para Gemini.

Cada sistema será desplegable, operable, testeable y evolucionable sin depender del runtime conversacional del otro proveedor.

```text
                       ┌──────────────────────────┐
                       │   Dominio compartido     │
                       │ reservas / horarios      │
                       │ autorización / contratos │
                       │ observabilidad común     │
                       └────────────┬─────────────┘
                                    │
                       ┌────────────▼─────────────┐
                       │   Supabase compartido    │
                       │ estado empresarial       │
                       └──────────────────────────┘

        ┌────────────────────────┐   ┌────────────────────────┐
        │ SISTEMA OPENAI         │   │ SISTEMA GEMINI         │
        │                        │   │                        │
PSTN ──►│ Telnyx / OpenAI CP     │   │ Gemini CP / Media Edge │◄── PSTN
        │ runtime OpenAI propio  │   │ runtime Gemini propio  │
        │ lifecycle propio       │   │ lifecycle propio       │
        │ tools flow propio      │   │ tools flow propio      │
        │ audio/voz propia       │   │ audio/voz propia       │
        └────────────────────────┘   └────────────────────────┘
```

La separación puede llegar, cuando sea útil, a **Workers/servicios distintos** y pipelines de deploy distintos.

No se exige que ambos sistemas utilicen el mismo `ResponseCoordinator`, la misma máquina de estados, el mismo lifecycle, el mismo protocolo de continuación post-tool ni una abstracción realtime común si ello obliga a ocultar diferencias sustanciales entre proveedores.

## Principio rector

> **Compartir dominio y contratos empresariales; no compartir orchestration conversacional por obligación.**

La reutilización de código es secundaria frente a independencia, eficiencia, claridad operativa y corrección específica de cada proveedor.

Duplicar una pequeña cantidad de lógica específica de runtime es preferible a introducir una abstracción común que haga a un proveedor depender conceptualmente del otro.

## Frontera de independencia

### El sistema OpenAI es propietario de

- conexión y lifecycle de OpenAI Realtime;
- semántica OpenAI de respuesta;
- turn ownership específico de OpenAI;
- tool continuation específica de OpenAI;
- barge-in, cancelación y reconexión OpenAI;
- audio y voz OpenAI;
- observabilidad específica necesaria para diagnosticar OpenAI;
- sus propios tests de integración y E2E.

El sistema OpenAI no debe depender del runtime Gemini para operar.

### El sistema Gemini es propietario de

- conexión y lifecycle de Gemini Live;
- Gemini Media Edge cuando sea necesario;
- máquina de estados Gemini;
- tool calling y continuación post-tool Gemini;
- barge-in, input detection y reconexión Gemini;
- estrategia de audio y una identidad vocal coherente durante la sesión;
- observabilidad específica necesaria para diagnosticar Gemini;
- sus propios tests de integración y E2E.

El sistema Gemini no debe conocer ni necesitar conceptos de OpenAI como requisito para operar. En particular, no debe adaptar artificialmente Gemini a operaciones cuya semántica sólo exista porque el sistema original fue construido alrededor de OpenAI.

## Qué se comparte

Se mantiene compartido únicamente lo que sea independiente del proveedor por naturaleza, incluyendo cuando corresponda:

- contratos de dominio;
- reservas;
- disponibilidad;
- horarios y reglas empresariales;
- tenants y configuración empresarial persistente;
- autorización y permisos de tools;
- identidad empresarial;
- persistencia Supabase;
- esquemas y migraciones empresariales;
- redacción de PII;
- auditoría y contratos de diagnóstico comunes;
- utilidades Telnyx realmente neutrales;
- contratos de tools empresariales.

Los módulos compartidos no importan SDKs ni tipos wire de OpenAI o Gemini.

## Qué no se comparte por obligación

No existe requisito de compartir entre OpenAI y Gemini:

- response lifecycle;
- session lifecycle;
- turn detection;
- response ownership;
- provider buffering;
- reconexión;
- tool-call protocol;
- tool-result continuation;
- barge-in;
- generación de audio;
- TTS o voz;
- provider watchdogs;
- correlación interna de eventos;
- máquinas de estados conversacionales;
- adapters creados únicamente para hacer que un proveedor imite al otro.

Si una pieza de esta lista resulta objetivamente idéntica y neutral, podrá extraerse después mediante evidencia y tests. No se comparte preventivamente.

## Persistencia en esta fase

### Una sola base de datos

Durante esta fase se utilizará **un único proyecto/base de datos Supabase compartido**.

OpenAI y Gemini leen y escriben el mismo estado empresarial y respetan los mismos contratos de persistencia.

Una reserva, horario, tenant o dato empresarial no se duplica por proveedor.

```text
OpenAI system ─┐
               ├──► contratos de dominio ──► Supabase compartido
Gemini system ─┘
```

La base de datos compartida no implica compartir runtime conversacional.

El estado efímero de una llamada OpenAI no es autoridad para una llamada Gemini y viceversa.

Los eventos diagnósticos deben permitir identificar de forma inequívoca el sistema/runtime que los produjo mediante metadatos seguros como `provider`, `runtime`, `deployment_id`, `session_id` o equivalentes, sin introducir PII innecesaria.

### No coexistencia activa como requisito actual

En esta fase **no es un requisito de producto ejecutar simultáneamente OpenAI y Gemini para el mismo cliente**.

El despliegue efectivo de un cliente puede seleccionar uno de los dos productos:

```text
Cliente A → sistema OpenAI
Cliente B → sistema Gemini
```

Un cliente Gemini puede desplegarse sin credenciales, runtime ni dependencias operativas de OpenAI.

Un cliente OpenAI puede desplegarse sin credenciales, runtime ni dependencias operativas de Gemini.

No se implementará complejidad de coexistencia, failover o cambio de proveedor durante una llamada hasta que exista un requisito comercial explícito y un ADR posterior.

## Evolución futura de datos

La decisión de utilizar una sola base ahora no acopla la arquitectura a una única base para siempre.

En una fase futura podrán existir **N bases de datos o proyectos Supabase**, siempre que implementen los mismos contratos de dominio/persistencia necesarios para el producto.

Ejemplos posibles:

```text
cliente_1 → Supabase A
cliente_2 → Supabase B
cliente_3 → Supabase C
```

La selección futura de base por tenant/cliente debe realizarse detrás de contratos/adaptadores y no contaminar los runtimes OpenAI o Gemini.

Esta evolución requiere diseño y ADR propios cuando exista el requisito.

## Estructura objetivo orientativa

La estructura exacta se decidirá durante la refactorización, pero el objetivo conceptual es equivalente a:

```text
apps/
  openai-control-plane/
  openai-media-edge/        # sólo si OpenAI lo necesita

  gemini-control-plane/
  gemini-media-edge/

packages/
  restaurant-domain/
  reservation-engine/
  authorization/
  supabase-data/
  observability/
  telnyx-common/            # únicamente contenido realmente neutral
```

No se obliga a realizar una migración física de carpetas en un único commit. La separación puede hacerse incrementalmente mientras las fronteras finales permanezcan claras.

## Despliegue objetivo

Los productos deben poder validarse y desplegarse de manera independiente.

Conceptualmente:

```text
deploy-openai
  → artefactos OpenAI
  → configuración OpenAI
  → tests OpenAI
  → deploy OpenAI


deploy-gemini
  → artefactos Gemini
  → configuración Gemini
  → tests Gemini
  → deploy Gemini
```

El pipeline Gemini no debe requerir secretos OpenAI y el pipeline OpenAI no debe requerir secretos Gemini.

## Estrategia de refactorización

A partir de la aceptación de este ADR, no se invertirá esfuerzo en perfeccionar una abstracción realtime universal únicamente para resolver defectos que desaparecerán al separar los runtimes.

Los errores actuales de la integración híbrida se conservan como evidencia y regresiones útiles, pero antes de corregirlos se evaluará si pertenecen a código que será retirado o reemplazado por el runtime Gemini independiente.

Orden de trabajo recomendado:

1. inventariar responsabilidades actualmente compartidas entre OpenAI y Gemini;
2. clasificar cada responsabilidad como `DOMAIN_SHARED`, `OPENAI_RUNTIME` o `GEMINI_RUNTIME`;
3. definir la frontera mínima compartida de dominio/persistencia;
4. diseñar el nuevo runtime Gemini alrededor de la semántica real de Gemini Live;
5. preservar OpenAI sin cambios funcionales durante la separación;
6. migrar Gemini incrementalmente detrás de tests propios;
7. eliminar adapters/compatibilidad heredada sólo cuando el nuevo camino esté probado;
8. validar Gemini E2E de forma independiente;
9. validar OpenAI E2E para confirmar ausencia de regresión;
10. separar pipelines/deploys donde aporte aislamiento real.

## Criterios de aceptación del sistema Gemini independiente

Gemini se considera producto autónomo cuando puede demostrar, sin utilizar runtime OpenAI:

1. establecimiento de llamada y bootstrap;
2. una identidad vocal coherente durante toda la sesión;
3. turnos multi-turno naturales;
4. VAD/STT/input handling según su propia arquitectura;
5. tool calling autorizado;
6. reservas progresivas;
7. continuación después de resultados de tools;
8. resultados de negocio provenientes de Supabase/dominio compartido;
9. barge-in/interrupción;
10. reconexión y liveness;
11. cierre limpio;
12. observabilidad cross-plane suficiente;
13. CI, deploy y E2E propios;
14. ausencia de dependencia runtime o credenciales OpenAI.

OpenAI mantiene su propio conjunto equivalente de pruebas de producto, pero no tiene que cumplir internamente la misma máquina de estados que Gemini.

## Relación con ADR anteriores y reglas vigentes

Este ADR **no invalida** `ADR-002-GEMINI-EXTERNAL-MEDIA-PLANE.md` en cuanto a la necesidad de un media edge dedicado para Gemini y sus requisitos de seguridad/media.

Sí modifica la dirección arquitectónica anterior en la que OpenAI y Gemini debían absorber sus diferencias detrás de una misma orquestación realtime neutral.

Por tanto, este ADR prevalece sobre cualquier interpretación previa de las reglas `RA-008`, `RA-036`, `RA-037`, `RA-038`, `RA-039`, `RA-040` y `RA-041` que obligue a ambos proveedores a compartir Control Plane conversacional, response coordination, lifecycle o runtime.

Siguen vigentes los principios de separación de dominio, autoridad empresarial, seguridad, persistencia, observabilidad, GitHub como fuente de verdad y despliegue desde SHA verificable.

## Consecuencias positivas

- Gemini puede diseñarse según Gemini Live en lugar de imitar OpenAI.
- OpenAI queda protegido frente a cambios necesarios para Gemini.
- cada producto puede optimizar latencia, voz, lifecycle y tool flow de forma independiente;
- menor superficie de condicionales `if provider` en caminos críticos;
- troubleshooting y observabilidad más claros;
- despliegues y secretos pueden aislarse por producto;
- un cliente Gemini no paga complejidad operativa de OpenAI;
- se conserva una única fuente de verdad empresarial en Supabase durante esta fase.

## Costes y trade-offs

- puede existir duplicación controlada de código runtime;
- habrá dos suites E2E y posiblemente dos pipelines;
- ciertos cambios conversacionales deberán implementarse dos veces si son específicos de ambos productos;
- se requiere una refactorización estructural de código ya existente;
- la coexistencia/failover entre proveedores queda explícitamente fuera del alcance actual.

Estos costes se aceptan porque el objetivo prioritario es disponer de **dos sistemas eficientes, independientes y comercializables por separado**.

## Fuera de alcance de este ADR

- failover OpenAI ↔ Gemini durante una llamada;
- selección dinámica de proveedor dentro de una misma llamada;
- ejecución simultánea obligatoria de ambos runtimes para un cliente;
- migración inmediata a múltiples bases de datos;
- selección concreta de estructura final de repositorio;
- corrección de todos los defectos de la arquitectura híbrida actual antes de iniciar la separación;
- reescritura del dominio empresarial que ya sea realmente neutral.
