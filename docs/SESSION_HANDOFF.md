# Prompt de relevo — IA_RealTime_CenterCall

> Ruta estable y operativa.  
> Última revisión: 2026-08-26  
> Decisión vigente: [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./architecture/ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> Plan activo: [`OPENAI_GEMINI_SEPARATION_WORKPLAN.md`](./architecture/OPENAI_GEMINI_SEPARATION_WORKPLAN.md)

Copiar desde “INICIO DEL PROMPT” hasta “FIN DEL PROMPT” en una nueva sesión.

---

## INICIO DEL PROMPT

Quiero que continúes autónomamente el trabajo sobre `jdlc86/IA_RealTime_CenterCall` como Staff/Principal Engineer y arquitecto de sistemas realtime de voz.

### 1. Fuente de verdad y arranque obligatorio

```text
repo    jdlc86/IA_RealTime_CenterCall
rama   rebuild/v39-stable-baseline
PR     #85
base   main
```

No crees otra rama ni otro PR. El PR #85 debe permanecer OPEN y DRAFT. No hagas merge, no lo marques ready, no hagas force-push ni reescribas historia.

Antes de escribir, verifica siempre:

```powershell
git status --short --branch
git rev-parse HEAD
git fetch origin
git rev-parse origin/rebuild/v39-stable-baseline
git log -10 --oneline --decorate
gh pr view 85 --repo jdlc86/IA_RealTime_CenterCall --json number,title,state,isDraft,mergeable,baseRefName,headRefName,headRefOid,url,statusCheckRollup
```

Si el checkout local contiene cambios, inspecciónalos y no los descartes. GitHub/remoto es la fuente de verdad del software publicado, pero el árbol local del usuario puede contener trabajo no publicado.

Lee en este orden:

1. `docs/architecture/ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`.
2. `docs/architecture/OPENAI_GEMINI_SEPARATION_WORKPLAN.md`.
3. `docs/PROJECT_STATUS.md`.
4. `docs/architecture/DESIGN_RULES.md`, interpretando las reglas anteriores a través de ADR-003 cuando exista conflicto.
5. los archivos/tests exactos de la fase activa.

### 2. Cambio de paradigma aprobado

La arquitectura híbrida OpenAI/Gemini **ya no es el objetivo**.

El producto se separará en dos sistemas realtime independientes:

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

En esta fase ambos utilizan el mismo Supabase y contratos de dominio/persistencia realmente neutrales.

No es requisito que OpenAI y Gemini coexistan simultáneamente para un mismo cliente. Un cliente Gemini debe poder operar sin runtime, secretos ni dependencias OpenAI; un cliente OpenAI debe poder operar sin runtime, secretos ni dependencias Gemini.

No continúes perfeccionando una abstracción realtime universal ni arreglando defectos del camino híbrido que vayan a desaparecer con la separación, salvo que bloqueen la separación o afecten a código que sobrevivirá.

El código actual es evidencia histórica, **no especificación arquitectónica**. El Worker principal fue creado y modificado a lo largo de muchas fases de compatibilidad y no debe asumirse como óptimo ni siquiera para OpenAI.

### Estado operativo

Distingue siempre:

```text
IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E
```

Los SHA, CI, despliegues y tráfico deben verificarse al comienzo; no uses snapshots del documento como verdad actual.

### 3. Reglas arquitectónicas que no puedes violar

1. **Dos runtimes independientes.** No diseñes Gemini para imitar OpenAI ni OpenAI para acomodar Gemini.
2. **Dos Workers es la dirección aprobada.** OpenAI tendrá su Worker; Gemini tendrá su Worker y su Media Edge cuando corresponda.
3. **Supabase compartido en esta fase.** Compartir persistencia no autoriza compartir runtime conversacional.
4. **Compartir dominio, no orchestration por obligación.** Reservas, horarios, autorización, contratos empresariales y persistencia pueden compartirse cuando sean neutrales.
5. **El código existente no se conserva por inercia.** Evalúa cada pieza por necesidad, semántica real, complejidad y evidencia.
6. **Conservar hardening general útil.** Seguridad, concurrencia, confirmación backend, privacidad y observabilidad se mantienen si son realmente generales.
7. **No mover/borrar antes de clasificar.** En Fase 1 se inventaría; la migración comienza después.
8. **One state owner per concern.** No dupliques autoridad de estado.
9. **El dominio no depende de SDKs/wire externos.** OpenAI, Gemini, Telnyx y Supabase quedan detrás de fronteras explícitas cuando corresponda.
10. **No timers/sleeps para ocultar ordering.** Usa identidad, estados y evidencia.
11. **GitHub es fuente de verdad publicada.** Todo cambio normal se versiona y CI valida el SHA exacto.
12. **No introducir N bases, coexistencia o failover ahora.** Son fases futuras y requieren necesidad real/ADR.

Clasificación obligatoria durante el inventario:

```text
SHARED_DOMAIN
OPENAI_NATIVE
GEMINI_NATIVE
LEGACY_COMPAT_REDESSIGN
UNRESOLVED
```

Para cada pieza registra responsabilidad, problema que resuelve, dependencias, estado que posee, tests, impacto en camino crítico, clasificación y acción propuesta.

### 4. Trabajo ya decidido

ADR-003 fija:

- dos productos realtime autónomos;
- dos Workers separados como arquitectura objetivo;
- Gemini Media Edge específico de Gemini;
- Supabase único compartido ahora;
- futura posibilidad de N bases mediante los mismos contratos;
- no coexistencia/failover en esta fase;
- limpieza posterior del Worker OpenAI;
- posibilidad de duplicación controlada cuando evitarla genere una abstracción peor.

El plan vivo está en `docs/architecture/OPENAI_GEMINI_SEPARATION_WORKPLAN.md`. Debes marcar ahí cada bloque completado y dejar una “siguiente acción exacta” antes de cerrar la sesión.

### 5. Qué NO hacer ahora

- No seguir arreglando el error G3/G4 del runtime híbrido sólo para mantener esa arquitectura.
- No seguir afinando semantic gates/response coordination híbridos si van a desaparecer.
- No crear carpetas/mover código antes del inventario.
- No copiar automáticamente `CallSession`, `ResponseCoordinator` u otros owners actuales al nuevo Gemini Worker.
- No asumir que cualquier código añadido durante Gemini debe borrarse luego de OpenAI; separa hardening general de contaminación específica Gemini.
- No desplegar una arquitectura nueva antes de tener diseño, tests y criterio de salida de su fase.

### 6. Primera misión

**Fase 1 — inventario arquitectónico, sin modificar runtime.**

Crea y mantiene:

`docs/architecture/PROVIDER_RUNTIME_INVENTORY.md`

Debes inspeccionar por evidencia:

1. topología actual de `apps/`, `packages/`, Workers, servicios y entrypoints;
2. Worker/Control Plane actual;
3. lifecycle, response ownership, turn ownership, concurrency y watchdogs;
4. OpenAI adapters/wire específicos;
5. toda lógica Gemini presente en el Worker actual: provider branches, sideband, bootstrap, session/runtime adapters, tests y bindings;
6. Gemini Media Edge: Telnyx streaming, Gemini Live, VAD/STT, semantic preselection, tool gate, playback, governed speech, reconnect y sideband;
7. ToolGateway, reservas, horarios, identidad, autorización y Supabase;
8. observabilidad/diagnóstico;
9. Telnyx realmente neutral frente a código específico de producto;
10. pipelines CI/deploy y secretos/bindings cruzados.

Para cada componente aplica las etiquetas del plan y propone `KEEP`, `MOVE`, `EXTRACT`, `REWRITE`, `DELETE_LATER` o `INVESTIGATE`.

No empieces Fase 2 hasta que las dependencias críticas estén clasificadas.

### 7. Flujo de cambio y validación

Para documentación desde `apps/control-plane`:

```powershell
npm run docs:check
```

Si modificas runtime en fases posteriores:

```powershell
npm test
npm run check
```

Antes de cada push comprueba HEAD/divergencia y que nadie haya escrito sobre la rama desde tu último fetch. Push únicamente a `rebuild/v39-stable-baseline` y reutiliza exclusivamente PR #85.

Tras cada commit verifica el PR y los checks del SHA exacto. No declares CI verde sin comprobarlo.

### 8. Limpieza OpenAI posterior

Una vez Gemini independiente esté probado, existe una fase específica para limpiar y optimizar OpenAI.

No se trata de “volver a una versión antigua”. Se debe:

- retirar Gemini sideband/bootstrap/bindings/branches que ya no pertenezcan a OpenAI;
- reevaluar coordinadores y capas creadas por compatibilidad histórica;
- simplificar OpenAI según la semántica real de OpenAI Realtime;
- conservar hardening general demostrado;
- probar que OpenAI compila, despliega y funciona sin runtime/credenciales Gemini.

Objetivo final:

```text
OpenAI optimizado para OpenAI
+
Gemini optimizado para Gemini
+
Dominio/Supabase compartidos
```

### 9. Cómo cerrar tu trabajo

Antes de terminar una sesión:

1. actualiza las casillas de `OPENAI_GEMINI_SEPARATION_WORKPLAN.md`;
2. actualiza `PROJECT_STATUS.md` sólo si cambió estado operativo;
3. deja la siguiente acción exacta;
4. informa commit/SHA y CI del SHA si hubo commit;
5. no declares desplegado ni E2E si no se verificó realmente;
6. mantén PR #85 OPEN y DRAFT.

## FIN DEL PROMPT
