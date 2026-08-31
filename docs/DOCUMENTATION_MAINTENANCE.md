# Mantenimiento de documentación

## Fuente de verdad

La documentación vigente describe sólo el runtime ejecutable actual. Git conserva
la historia; no se mantienen snapshots, planes superados o productos retirados
dentro del árbol activo.

Orden de autoridad:

```text
ADR aplicable
→ architecture/DESIGN_RULES.md
→ architecture/SYSTEM_ARCHITECTURE.md
→ SYSTEM_OVERVIEW.md
→ PROJECT_STATUS.md
→ runbook propietario
```

## Regla de estados

Cada cambio debe separar:

```text
IMPLEMENTADO
CI VERDE
DESPLEGADO
VALIDADO E2E
LIMITACIÓN ABIERTA
```

Un test sintético no demuestra audio audible. Una revisión desplegada no demuestra
que el Worker la enrute. Un evento de transferencia no demuestra por sí solo que
el destino haya contestado.

## Rutas canónicas

- Estado: [`PROJECT_STATUS.md`](./PROJECT_STATUS.md)
- Relevo: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md)
- Arquitectura: [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md)
- Seguridad: [guía viva](../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx)
- Despliegue: [`runbooks/Deployment.md`](./runbooks/Deployment.md)

## Flujo por cambio

1. Verificar GitHub y, si aplica, los sistemas remotos.
2. Actualizar el documento propietario, no varias copias.
3. Eliminar información superada cuando la fuente canónica absorba lo útil.
4. Conservar ADR aceptada sólo mientras siga explicando una decisión vigente.
5. Ejecutar:

```bash
cd apps/gemini-control-plane
npm run docs:check
npm run check
```

6. Ejecutar además la suite del Media Edge cuando cambie runtime, workflow o
   documentación del hot path.

## Código existente no equivale a arquitectura activa

Los entrypoints vigentes son:

```text
apps/gemini-control-plane/src/index-fast.ts
apps/gemini-media-edge/src/startup-fast.mjs
apps/gemini-media-edge/src/server-fast.mjs
apps/gemini-media-edge/src/fast-runtime.mjs
```

Cualquier archivo nuevo debe ser alcanzable desde esos entrypoints, una migración,
un script operativo vigente o una prueba que proteja un contrato real.

## Definition of Done documental

1. no hay enlaces rotos;
2. no se citan rutas retiradas;
3. el estado remoto tiene fecha/evidencia;
4. las limitaciones quedan visibles;
5. `npm run docs:check` pasa;
6. sólo existe una próxima misión coherente.
