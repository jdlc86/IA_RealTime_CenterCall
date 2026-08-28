# Mantenimiento documental

> **Estado:** normativo para el proceso de documentación  
> **Última revisión:** 2026-08-27

## Objetivo

Mantener suficiente contexto para operar y continuar el proyecto sin crear varias “verdades actuales”. La documentación posee decisiones y estado declarado; el código, GitHub, CI y sistemas remotos aportan la evidencia verificable.

La regla principal es:

> **Un documento histórico puede conservar una decisión antigua, pero nunca debe parecer un estado operativo vigente.**

## Fuentes y propietarios

| Tipo de información | Documento propietario | Cuándo actualizar |
|---|---|---|
| Reglas no negociables | `architecture/DESIGN_RULES.md` o ADR posterior | cambia una frontera/invariante |
| Topología estable actual | `architecture/SYSTEM_ARCHITECTURE.md` | cambia arquitectura física/owners |
| Decisión específica Gemini Fast | `architecture/ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md` | cambia el paradigma del Fast Path |
| Estado, deploy, E2E, limitaciones y siguiente validación | `PROJECT_STATUS.md` | cambia estado operativo |
| Relevo a otra sesión | `SESSION_HANDOFF.md` | cambia primera misión/restricción crítica |
| Transferencia humana | `HUMAN_HANDOFF.md` | cambia contrato/lifecycle/limitación de handoff |
| Procedimiento repetible | `runbooks/*.md` | cambia secuencia/comando/gate operativo |
| Evidencia/investigación extensa | nota fechada / `DEVELOPMENT_LOG.md` | sólo si será útil posteriormente |
| Índice | `README.md` | cambia ruta canónica o autoridad documental |
| Visión funcional/producto | `MASTER_PROJECT_GUIDE.md` | cambia alcance/visión; no por cada deploy |

## Estados documentales permitidos

Un archivo que pueda confundirse con estado actual debe declararse de forma visible como uno de:

```text
VIGENTE / NORMATIVO
ACTIVO
HISTÓRICO
ARCHIVADO
SUPERADO / SUPERADO EN PARTE
```

### Históricos

Los documentos históricos:

- no se actualizan para fingir que siempre dijeron lo actual;
- sí pueden recibir una **cabecera de archivado/supersession** para evitar una lectura peligrosa;
- deben enlazar al propietario actual;
- no deben aparecer en la “lectura mínima” como si fueran vigentes.

Los handoffs fechados siguen siendo snapshots. Si contienen información falsa hoy, se corrige la navegación/etiqueta, no su contenido histórico salvo datos sensibles o error excepcional.

## Flujo mínimo por cambio

1. Clasificar el cambio.
2. Actualizar el documento propietario, no cinco copias.
3. Si una afirmación anterior queda peligrosa, marcar el documento histórico/superado o eliminarla del documento canónico.
4. Separar siempre:

```text
IMPLEMENTADO
CI VERDE
DESPLEGADO
VALIDADO E2E
LIMITACIÓN ABIERTA
```

5. En cambios remotos, verificar el sistema de origen antes de escribir “actual”.
6. Ejecutar desde `apps/control-plane`:

```bash
npm run docs:check
```

7. Si el cambio incluye runtime, ejecutar además sus tests/checks específicos.

## Ruta de lectura recomendada

Una nueva sesión debe empezar por:

```text
README.md
→ PROJECT_STATUS.md
→ SESSION_HANDOFF.md
→ SYSTEM_ARCHITECTURE.md / ADR aplicable
→ DESIGN_RULES.md
→ runbook o documento funcional exacto del problema
→ historial sólo si hace falta reconstruir decisiones
```

No usar `DEVELOPMENT_LOG.md`, un documento `PHASE*_PROGRESS` o un review antiguo como fuente primaria del estado.

## Verificación remota

Antes de cambiar estado operativo, verificar según el caso:

```text
HEAD remoto / PR / checks
Worker/version efectiva
KV/config/bindings
Cloud Run revision/tag
Supabase evidence
Telnyx evidence
E2E real cuando el comportamiento es telefónico/acústico
```

### No usar “porcentaje de tráfico” como criterio universal

En OpenAI/Workers un porcentaje de tráfico puede describir la versión efectiva.

En Gemini Fast, el Worker puede apuntar directamente a una **URL etiquetada de Cloud Run** cuyo reparto general sea `0%`.

Por tanto la pregunta correcta es:

```text
¿qué endpoint/binding usa realmente la ruta de llamada?
```

No:

```text
¿qué revisión tiene >0% en el servicio general?
```

## Cómo documentar problemas observados

Separar evidencia por capa.

Ejemplo de handoff:

```text
target leg creado            → evidencia de signaling
call.bridged                 → evidencia de bridge
call.speak.ended             → evidencia de lifecycle TTS
caller oyó TTS               → evidencia acústica E2E distinta
caller oyó ringback          → evidencia acústica E2E distinta
callback_status=PENDING      → necesidad registrada, no callback ejecutado
```

No promocionar una evidencia a otra categoría.

## Código existente no equivale a arquitectura activa

La coexistencia de módulos históricos y Fast en `apps/gemini-media-edge` exige especial cuidado.

Antes de documentar que un mecanismo participa en producción, verificar imports/entrypoint/runtime real:

```text
server-fast.mjs
startup-fast.mjs
fast-runtime.mjs
fast-gemini31.mjs
```

No concluir que Google STT, semantic preselection, quarantine o governed TTS forman parte del Fast Path sólo porque sus archivos/tests sigan en el paquete.

## Qué no hacer

- No duplicar listas de commits en README, Status, handoff y ADR.
- No convertir un documento de progreso de fase en fuente permanente de estado.
- No marcar E2E verde a partir de una prueba sintética.
- No documentar “sin tráfico” mirando únicamente `0%` general cuando existe routing por tag/URL.
- No documentar “audible” a partir de un evento de control.
- No copiar secretos, números privados innecesarios, payloads sensibles o transcripts crudos.
- No ocultar una limitación real porque el código/CI esté verde.
- No mezclar una limpieza documental con cambios funcionales de audio/control.
- No reintroducir listas rígidas de lenguaje natural en documentación como si fueran contrato de producto.

## Contrato automatizado

`apps/control-plane/scripts/check-documentation.mjs` comprueba actualmente:

- existencia de rutas canónicas;
- enlaces Markdown locales;
- que README/Master apunten al relevo/estado/mantenimiento;
- secciones mínimas del prompt de relevo;
- presencia de estados `Implementado`, `CI`, `Producción`, `E2E` en el status;
- markers arquitectónicos mínimos en Design Rules.

`.github/workflows/control-plane-ci.yml` observa `docs/**`, por lo que cambios documentales ejecutan el contrato cuando el workflow aplicable se dispara.

### Límite del checker

`docs:check` **no valida verdad operacional**. No sabe por sí mismo:

- qué Worker está desplegado;
- qué KV contiene datos reales;
- a qué tagged revision apunta el Worker;
- si el caller oyó ringback/TTS;
- si una tabla Supabase contiene el último handoff;
- si una ADR ha sido implementada realmente.

Esas afirmaciones deben contrastarse con código y sistemas de origen antes de actualizar documentos canónicos.

## Definition of Done documental

Una actualización documental no está completa hasta que:

1. la fuente canónica describe el runtime real;
2. los documentos históricos peligrosamente ambiguos están marcados;
3. no hay dos próximas misiones incompatibles;
4. los enlaces locales pasan `docs:check`;
5. las afirmaciones remotas están sustentadas por evidencia reciente;
6. las limitaciones conocidas quedan visibles, no enterradas en historial.