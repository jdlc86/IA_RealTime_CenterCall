# IA_RealTime_CenterCall — Documentación oficial v2.5

Este directorio es la puerta de entrada a la documentación del proyecto. GitHub es la fuente de verdad del código y de la documentación.

## Entrada estable

Para evitar que vuelva a perderse la referencia al documento maestro, el path permanente es:

1. [`MASTER_PROJECT_GUIDE.md`](./MASTER_PROJECT_GUIDE.md) — entrada estable; no se renombra ni se elimina.
2. [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — estado operativo actual de fases.
3. [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md) — arquitectura normativa y definición canónica del roadmap.
4. [`architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md) — reglas no negociables de implementación.

## Orden de autoridad documental

Cuando existan dudas o contradicciones, usar este orden:

```text
ADR posterior aplicable
        ↓
architecture/SYSTEM_ARCHITECTURE.md
        ↓
architecture/DESIGN_RULES.md
        ↓
PROJECT_STATUS.md (solo progreso/estado de fases)
        ↓
implementation/PHASE_*_IMPLEMENTATION_GUIDE.md
        ↓
tests/ + runbooks/ + DEVELOPMENT_LOG.md
```

`MASTER_PROJECT_GUIDE.md` es una puerta de entrada estable, no una copia independiente de la arquitectura. Así evitamos dos fuentes de verdad divergentes.

## Lectura recomendada

1. [`MASTER_PROJECT_GUIDE.md`](./MASTER_PROJECT_GUIDE.md) — entrada permanente al proyecto.
2. [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — qué fase está cerrada y cuál está activa.
3. [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md) — producto a alto nivel.
4. [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md) — arquitectura y roadmap canónicos.
5. [`architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md) — reglas arquitectónicas.
6. [`implementation/PHASE_3_IMPLEMENTATION_GUIDE.md`](./implementation/PHASE_3_IMPLEMENTATION_GUIDE.md) — **implementación activa: F3 ToolGateway**.
7. [`implementation/PHASE_1_IMPLEMENTATION_GUIDE.md`](./implementation/PHASE_1_IMPLEMENTATION_GUIDE.md) — F1 cerrada.
8. [`implementation/PHASE_0_IMPLEMENTATION_GUIDE.md`](./implementation/PHASE_0_IMPLEMENTATION_GUIDE.md) — F0 cerrada.
9. [`implementation/END_CALL_INTENT_V9.md`](./implementation/END_CALL_INTENT_V9.md) — cierre por intención semántica.
10. [`tests/PHASE0.md`](./tests/PHASE0.md) y [`tests/PHASE1.md`](./tests/PHASE1.md) — evidencia de gates anteriores.
11. [`DEVELOPMENT_LOG.md`](./DEVELOPMENT_LOG.md) — bitácora cronológica.

## Roadmap vigente

Definido por `architecture/SYSTEM_ARCHITECTURE.md`:

```text
F0 Voz E2E
  ↓
F1 Baseline + observabilidad + TenantResolver
  ↓
F2 Latencia + barge-in
  ↓
F3 ToolGateway
  ↓
F4 Clínica + validación multi-negocio
  ↓
F5 Persistencia/post-call
  ↓
F6 Handoff humano
  ↓
F7 Concurrencia
  ↓
F8 Hardening producción
```

El estado de ejecución de estas fases se consulta en `PROJECT_STATUS.md`, no en snapshots históricos dentro de documentos antiguos.

## Estructura principal

```text
docs/
├── MASTER_PROJECT_GUIDE.md       # path estable
├── PROJECT_STATUS.md             # estado actual
├── README.md                     # índice y autoridad
├── SYSTEM_OVERVIEW.md
├── DEVELOPMENT_LOG.md
├── architecture/
│   ├── SYSTEM_ARCHITECTURE.md    # arquitectura canónica
│   ├── DESIGN_RULES.md
│   └── GLOSSARY.md
├── implementation/
│   ├── PHASE_0_IMPLEMENTATION_GUIDE.md
│   ├── PHASE_1_IMPLEMENTATION_GUIDE.md
│   ├── PHASE_3_IMPLEMENTATION_GUIDE.md
│   └── END_CALL_INTENT_V9.md
├── adr/
├── runbooks/
└── tests/
    ├── PHASE0.md
    └── PHASE1.md
```

## Compatibilidad documental

`ARCHITECTURE_SPECIFICATION.md` permanece como redirección legado hacia la documentación v2.x.

`MASTER_PROJECT_GUIDE.md` queda restaurado deliberadamente como **path estable de compatibilidad**. Si en el futuro cambia el archivo arquitectónico interno, se actualiza el enlace del master; el nombre del master no vuelve a desaparecer.
