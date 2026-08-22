# IA_RealTime_CenterCall — índice documental

> Estado: vigente
> Última revisión: 2026-08-22

La documentación usa rutas estables y una sola fuente por tipo de decisión. Los documentos fechados son evidencia histórica; no describen necesariamente el runtime actual.

## Lectura mínima

1. [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md) — prompt operativo para continuar en otra sesión.
2. [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — estado actual, producción y siguiente validación.
3. [`architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md) — reglas no negociables.
4. [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md) — arquitectura estable.
5. [`DOCUMENTATION_MAINTENANCE.md`](./DOCUMENTATION_MAINTENANCE.md) — qué documento actualizar y cómo evitar duplicación.

[`MASTER_PROJECT_GUIDE.md`](./MASTER_PROJECT_GUIDE.md) es la entrada de compatibilidad permanente y no debe renombrarse.

## Autoridad documental

```text
ADR posterior aplicable
  → architecture/DESIGN_RULES.md
  → architecture/SYSTEM_ARCHITECTURE.md
  → PROJECT_STATUS.md
  → SESSION_HANDOFF.md
  → runbooks / implementation / tests
  → handoffs y notas fechadas (historial)
```

- Una decisión arquitectónica nueva exige actualizar una regla existente o crear ADR.
- Un cambio de estado, deploy o E2E actualiza `PROJECT_STATUS.md` y, si afecta al siguiente trabajo, `SESSION_HANDOFF.md`.
- Un procedimiento actualiza el runbook correspondiente.
- No se copian listas completas de commits ni investigaciones antiguas en los documentos canónicos.

## Verificación

Desde `apps/control-plane`:

```powershell
npm run docs:check
npm test
npm run check
```

`docs:check` valida las rutas canónicas, sus enlaces locales y las secciones mínimas del relevo. Los detalles están en [`DOCUMENTATION_MAINTENANCE.md`](./DOCUMENTATION_MAINTENANCE.md).

## Historial útil

- [`SESSION_HANDOFF_PROMPT_2026-08-22.md`](./SESSION_HANDOFF_PROMPT_2026-08-22.md) — snapshot anterior al hardening de seguridad, concurrencia y saludo protegido.
- [`SESSION_HANDOFF_2026-08-19.md`](./SESSION_HANDOFF_2026-08-19.md) — Gate B y decisiones pre-Gemini.
- [`DEVELOPMENT_LOG.md`](./DEVELOPMENT_LOG.md) — cronología extensa.

Estos archivos se consultan para reconstruir decisiones, no como instrucciones actuales.
