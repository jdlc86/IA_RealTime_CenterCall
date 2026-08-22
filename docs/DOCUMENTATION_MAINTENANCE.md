# Mantenimiento documental

> Estado: normativo para el proceso de documentación
> Última revisión: 2026-08-22

## Objetivo

Mantener suficiente contexto para operar y continuar el proyecto sin copiar el mismo estado en muchos archivos. La documentación describe decisiones y rutas de revisión; el código, GitHub, CI y los sistemas remotos aportan la realidad verificable.

## Fuentes y propietarios

| Tipo de información | Único documento propietario | Cuándo actualizar |
|---|---|---|
| Reglas no negociables | `architecture/DESIGN_RULES.md` o ADR | cambia una frontera/invariante |
| Topología y contratos estables | `architecture/SYSTEM_ARCHITECTURE.md` | cambia arquitectura física o contrato principal |
| Estado, deploy, E2E y siguiente validación | `PROJECT_STATUS.md` | cambia el estado operativo |
| Contexto para otra sesión | `SESSION_HANDOFF.md` | cambia la primera misión o una restricción necesaria |
| Procedimiento repetible | `runbooks/*.md` | cambia un comando o secuencia operativa |
| Evidencia/investigación extensa | nota fechada o `DEVELOPMENT_LOG.md` | solo si será útil para diagnóstico futuro |
| Índices | `README.md` y `MASTER_PROJECT_GUIDE.md` | cambia una ruta canónica, no por cada fix |

Los handoffs fechados son snapshots inmutables. No se corrigen para reflejar el presente; se enlazan como historial.

## Flujo mínimo por cambio

1. Clasifica el cambio con la tabla anterior.
2. Actualiza solo el propietario correspondiente.
3. Resume el resultado y enlaza código/tests; no pegues una cronología completa.
4. Evita SHA rígidos en índices. Los SHA solo aparecen en `PROJECT_STATUS`/handoff como snapshot marcado para verificación.
5. Ejecuta desde `apps/control-plane`:

```powershell
npm run docs:check
```

6. Si el cambio también modifica runtime, ejecuta además `npm test` y `npm run check`.

## Orientación de revisión

Una nueva sesión no debe leer todos los documentos. Ruta recomendada:

```text
SESSION_HANDOFF.md
→ PROJECT_STATUS.md
→ DESIGN_RULES.md
→ archivos/tests exactos del problema
→ sección concreta de SYSTEM_ARCHITECTURE o ADR, solo si hace falta
→ historial fechado, solo para reconstruir una decisión
```

Antes de actualizar estado, verificar:

```text
git status + HEAD remoto
PR #85 + checks del SHA
versión Cloudflare con tráfico
evidencia E2E cuando corresponda
```

## Qué no hacer

- No duplicar listas de commits en Master, README, Status y handoff.
- No convertir `DEVELOPMENT_LOG.md` en lectura obligatoria.
- No marcar E2E como verde a partir de una prueba sintética.
- No documentar un deploy solo porque existe una versión en el histórico; verificar el porcentaje de tráfico.
- No copiar secretos, payloads sensibles o transcripciones sin redacción.
- No hacer cambios cosméticos masivos junto con un fix funcional.
- No actualizar archivos históricos para ocultar que una decisión cambió.

## Contrato automatizado

`apps/control-plane/scripts/check-documentation.mjs` comprueba:

- existencia de las rutas canónicas;
- enlaces locales en los documentos de entrada;
- que Master y README apunten al handoff estable;
- secciones mínimas del prompt de relevo;
- presencia de los cuatro estados: implementado, CI, desplegado y E2E;
- inclusión del control documental en el flujo de tests.

`.github/workflows/control-plane-ci.yml` observa `docs/**`, por lo que un cambio exclusivamente documental también ejecuta el contrato.

Este control evita referencias rotas y omisiones estructurales; no intenta validar automáticamente afirmaciones remotas. Los UUID, SHA, CI y tráfico deben contrastarse con sus sistemas de origen.
