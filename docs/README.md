# IA_RealTime_CenterCall — Documentación oficial v2.1

Este directorio es la puerta de entrada a la documentación del proyecto. GitHub es la fuente de verdad del código y de la documentación.

## Lectura recomendada

1. [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md) — qué es el producto y cómo funciona a alto nivel.
2. [`architecture/SYSTEM_ARCHITECTURE.md`](./architecture/SYSTEM_ARCHITECTURE.md) — arquitectura canónica del sistema.
3. [`architecture/DESIGN_RULES.md`](./architecture/DESIGN_RULES.md) — reglas no negociables de implementación.
4. [`implementation/PHASE_0_IMPLEMENTATION_GUIDE.md`](./implementation/PHASE_0_IMPLEMENTATION_GUIDE.md) — guía operativa y reproducible de la FASE 0.
5. [`runbooks/Telnyx.md`](./runbooks/Telnyx.md) — configuración operativa del proveedor telefónico inicial.
6. [`tests/PHASE0.md`](./tests/PHASE0.md) — plan y evidencia del Gate F0.
7. [`DEVELOPMENT_LOG.md`](./DEVELOPMENT_LOG.md) — bitácora cronológica.

## Estructura

```text
docs/
├── README.md
├── SYSTEM_OVERVIEW.md
├── DEVELOPMENT_LOG.md
├── architecture/
│   ├── SYSTEM_ARCHITECTURE.md
│   ├── DESIGN_RULES.md
│   └── GLOSSARY.md
├── implementation/
│   └── PHASE_0_IMPLEMENTATION_GUIDE.md
├── adr/
│   └── README.md
├── runbooks/
│   ├── Cloudflare.md
│   ├── OpenAI.md
│   ├── Telnyx.md
│   ├── Twilio.md
│   ├── Deployment.md
│   └── Troubleshooting.md
└── tests/
    └── PHASE0.md
```

## Fuente de verdad

- **Arquitectura vigente:** `architecture/SYSTEM_ARCHITECTURE.md`.
- **Reglas arquitectónicas:** `architecture/DESIGN_RULES.md`.
- **Implementación activa:** documentos de `implementation/`.
- **Operación:** `runbooks/`.
- **Evidencia de gates:** `tests/`.
- **Historial de decisiones:** `adr/`.

Los antiguos paths `ARCHITECTURE_SPECIFICATION.md` y `PHASE_0_IMPLEMENTATION_GUIDE.md` se conservan únicamente como redirecciones de compatibilidad hacia la documentación v2.x. Las versiones v1.x completas siguen disponibles en el historial Git y no son fuente de verdad para nuevas implementaciones.
