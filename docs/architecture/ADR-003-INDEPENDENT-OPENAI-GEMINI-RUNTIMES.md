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

### Decisión física para esta fase: dos Workers

La arquitectura objetivo incluye **dos Cloudflare Workers distintos**:

1. **OpenAI Control Plane Worker** — exclusivo del producto OpenAI.
2. **Gemini Control Plane Worker** — exclusivo del producto Gemini.

Gemini conserva además su **Gemini Media Edge** dedicado para el transporte continuo de audio hacia/desde Gemini Live.

Por tanto, la topología de ejecución objetivo de esta fase es:

```text
PRODUCTO OPENAI
PSTN
  ↓
Telnyx
  ↓
OpenAI Control Plane Worker
  ↓
OpenAI Realtime
  ↓
Supabase compartido


PRODUCTO GEMINI
PSTN
  ↓
Telnyx
  ↓
Gemini Control Plane Worker
  ↓ control / negocio
Gemini Media Edge
  ↓ audio realtime
Gemini Live
  ↓
Supabase compartido
```

El Gemini Media Edge no sustituye al Gemini Control Plane Worker: ambos pertenecen al producto Gemini y tienen responsabilidades diferentes.

Los dos Workers pueden vivir en el mismo repositorio y compartir packages de dominio/persistencia, pero **no comparten runtime conversacional ni estado efímero de llamada**.

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
PSTN ──►│ Worker OpenAI          │   │ Worker Gemini          │◄── PSTN
        │ runtime OpenAI propio  │   │ Gemini Media Edge      │
        │ lifecycle propio       │   │ runtime Gemini propio  │
        │ tools flow propio      │   │ lifecycle propio       │
        │ audio/voz propia       │   │ tools/audio propios    │
        └────────────────────────┘   └────────────────────────┘
```

No se exige que ambos sistemas utilicen el mismo `ResponseCoordinator`, la misma máquina de estados, el mismo lifecycle, el mismo protocolo de continuación post-tool ni una abstracción realtime común si ello obliga a ocultar diferencias sustanciales entre proveedores.

## Principio rector

> **Compartir dominio y contratos empresariales; no compartir orchestration conversacional por obligación.**

La reutilización de código es secundaria frente a independencia, eficiencia, claridad operativa y corrección específica de cada proveedor.

Duplicar una pequeña cantidad de lógica específica de runtime es preferible a introducir una abstracción común que haga a un proveedor depender conceptualmente del otro.

## Frontera de independencia

### El sistema OpenAI es propietario de

- su Cloudflare Worker de Control Plane;
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

- su Cloudflare Worker de Control Plane;
- conexión y lifecycle de Gemini Live;
- Gemini Media Edge;
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
  → OpenAI Control Plane Worker
  → configuración/secretos OpenAI
  → tests OpenAI
  → deploy OpenAI


deploy-gemini
  → Gemini Control Plane Worker
  → Gemini Media Edge
  → configuración/secretos Gemini
  → tests Gemini
  → deploy Gemini
```

El pipeline Gemini no debe requerir secretos OpenAI y el pipeline OpenAI no debe requerir secretos Gemini.

## Estrategia de refactorización

A partir de la aceptación de este ADR, no se invertirá esfuerzo en perfeccionar una abstracción realtime universal únicamente para resolver defectos que desaparecerán al separar los runtimes.

Los errores actuales de la integración híbrida se conservan como evidencia y regresiones útiles, pero antes de corregirlos se evaluará si pertenecen a código que será retirado o reemplazado por el runtime Gemini independiente.

### Fase 1 — Inventario y clasificación

Antes de mover código se inventariará el estado real del repositorio y se clasificará cada responsabilidad relevante como:

- `DOMAIN_SHARED`
- `OPENAI_RUNTIME`
- `GEMINI_RUNTIME`
- `LEGACY_HYBRID_TO_REMOVE`

El inventario debe identificar especialmente cualquier lógica Gemini introducida dentro del Worker/Control Plane que originalmente pertenecía a OpenAI.

### Fase 2 — Construcción del Gemini Control Plane Worker independiente

Se crea el Worker Gemini con ownership propio de:

- bootstrap y lifecycle Gemini;
- coordinación con Gemini Media Edge;
- tool calling/continuation Gemini;
- turn state y response state Gemini;
- barge-in/input detection;
- observabilidad Gemini;
- integración con los mismos contratos empresariales compartidos.

La implementación se diseña desde la semántica real de Gemini Live y no como traducción de OpenAI.

### Fase 3 — Migración funcional de Gemini

Se migra incrementalmente al nuevo Worker Gemini:

- telefonía/control;
- conversación multi-turno;
- tools;
- reservas;
- disponibilidad;
- continuación post-tool;
- audio/voz coherente;
- reconexión;
- cierre;
- diagnóstico.

El camino híbrido antiguo sólo se retira cuando el nuevo Gemini demuestre tests propios y E2E satisfactorio.

### Fase 4 — Limpieza y restauración del Worker OpenAI

Una vez que Gemini ya opere de forma independiente, se realizará una fase dedicada de **limpieza del Worker OpenAI**.

Se asume como hipótesis de trabajo que el Worker actual puede contener lógica, adapters, guards, branches, contratos y observabilidad añadidos únicamente para acomodar Gemini. Esa hipótesis deberá comprobarse mediante inventario/diff antes de borrar nada.

La limpieza incluirá, cuando la evidencia confirme que son Gemini-only o legado híbrido:

- eliminar ramas `if provider === GEMINI` del camino OpenAI;
- retirar adapters de compatibilidad Gemini/OpenAI;
- retirar estados y coordinadores introducidos sólo para traducir Gemini a semántica OpenAI;
- retirar comandos/control sideband Gemini del Worker OpenAI;
- retirar bootstrap/configuración Gemini del deploy OpenAI;
- retirar secrets/env vars Gemini del pipeline OpenAI;
- retirar tests Gemini que vivan artificialmente dentro de la suite OpenAI;
- reducir dependencias y bundle del Worker OpenAI;
- restaurar ownership y lifecycle OpenAI simples donde la integración híbrida los haya complicado;
- conservar cualquier hardening que sea genuinamente útil para OpenAI, aunque se haya descubierto durante el trabajo Gemini.

**No se revertirá OpenAI a una versión histórica a ciegas.** La limpieza será selectiva: se elimina contaminación Gemini, pero se conservan correcciones generales de seguridad, concurrencia, dominio y fiabilidad que beneficien al producto OpenAI.

Criterio final de esta fase:

> El Worker OpenAI debe poder compilar, desplegarse y ejecutar todos sus E2E sin código runtime, secretos, servicios ni decisiones de lifecycle Gemini.

### Fase 5 — Separación de pipelines y contratos operativos

Tras estabilizar ambos sistemas:

- CI OpenAI valida únicamente producto OpenAI + packages compartidos relevantes;
- CI Gemini valida únicamente producto Gemini + packages compartidos relevantes;
- los deploys son independientes;
- los secrets son independientes;
- un cliente recibe únicamente los componentes del producto contratado.

### Fase 6 — Evolución futura de persistencia

Sólo cuando exista requisito comercial se evaluará pasar de un Supabase compartido a N bases/proyectos que implementen los mismos contratos de persistencia. No forma parte de la separación realtime actual.

## Orden de trabajo resumido

1. inventariar responsabilidades y contaminación cruzada actual;
2. clasificar `DOMAIN_SHARED`, `OPENAI_RUNTIME`, `GEMINI_RUNTIME`, `LEGACY_HYBRID_TO_REMOVE`;
3. definir packages realmente compartidos;
4. levantar `gemini-control-plane` como Worker independiente;
5. integrar el Worker Gemini con el Gemini Media Edge existente;
6. migrar Gemini detrás de tests propios;
7. validar Gemini E2E independiente;
8. limpiar el Worker OpenAI de lógica Gemini/legacy híbrida;
9. validar OpenAI E2E y ausencia de dependencias Gemini;
10. separar CI/deploy/secrets por producto;
11. eliminar definitivamente el camino híbrido sólo cuando ambos productos estén demostrados.

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

## Criterios de aceptación del sistema OpenAI limpio

OpenAI se considera nuevamente aislado cuando puede demostrar:

1. Worker OpenAI desplegable de forma independiente;
2. ninguna dependencia runtime del Worker Gemini ni Gemini Media Edge;
3. ninguna credencial Gemini requerida;
4. ninguna rama de lifecycle necesaria sólo para Gemini;
5. ninguna traducción de comandos Gemini en el camino OpenAI;
6. tools y dominio compartidos siguen funcionando;
7. Supabase compartido sigue siendo la misma fuente empresarial;
8. suite OpenAI y E2E OpenAI verdes;
9. comportamiento funcional OpenAI preservado o mejorado;
10. reducción verificable de contaminación/complexidad híbrida respecto al estado previo a la limpieza.

OpenAI mantiene su propia arquitectura interna; no tiene que cumplir la máquina de estados Gemini.

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
- se conserva una única fuente de verdad empresarial en Supabase durante esta fase;
- la limpieza posterior de OpenAI reduce deuda técnica acumulada durante la integración híbrida.

## Costes y trade-offs

- puede existir duplicación controlada de código runtime;
- habrá dos suites E2E y posiblemente dos pipelines;
- ciertos cambios conversacionales deberán implementarse dos veces si son específicos de ambos productos;
- se requiere una refactorización estructural de código ya existente;
- la coexistencia/failover entre proveedores queda explícitamente fuera del alcance actual;
- habrá una fase explícita de limpieza del Worker OpenAI después de migrar Gemini.

Estos costes se aceptan porque el objetivo prioritario es disponer de **dos sistemas eficientes, independientes y comercializables por separado**.

## Fuera de alcance de este ADR

- failover OpenAI ↔ Gemini durante una llamada;
- selección dinámica de proveedor dentro de una misma llamada;
- ejecución simultánea obligatoria de ambos runtimes para un cliente;
- migración inmediata a múltiples bases de datos;
- corrección de todos los defectos de la arquitectura híbrida actual antes de iniciar la separación;
- reescritura del dominio empresarial que ya sea realmente neutral;
- borrar código OpenAI o Gemini sin inventario/evidencia previa.
