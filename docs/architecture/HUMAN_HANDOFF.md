# Human Handoff — referencia arquitectónica histórica

> **Estado:** SUPERADO COMO DOCUMENTO OPERATIVO  
> **Fecha original:** 2026-08-12  
> **Actualizado:** 2026-08-27  
> **Documento vigente:** [`../HUMAN_HANDOFF.md`](../HUMAN_HANDOFF.md)

Este archivo documentó inicialmente human handoff como una capacidad futura de la plataforma y afirmaba que la transferencia todavía no existía.

Esa afirmación quedó superada: el producto Gemini Fast ya implementa transferencia humana, configuración por tenant y auditoría de lifecycle.

Para cualquier decisión, diagnóstico o cambio actual de handoff usar exclusivamente:

- [`../HUMAN_HANDOFF.md`](../HUMAN_HANDOFF.md) — contrato/limitaciones operativas vigentes;
- [`SYSTEM_ARCHITECTURE.md`](./SYSTEM_ARCHITECTURE.md) — lugar del handoff en la arquitectura;
- [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md) — estado real/E2E/limitaciones;
- [`DESIGN_RULES.md`](./DESIGN_RULES.md) — invariantes transversales.

## Decisión histórica que sigue siendo válida

La transferencia a humano es una capacidad transversal del producto, no una feature específica de un vertical o cliente. El destino y capability se configuran por tenant; el modelo no inventa números ni permisos.

## Por qué este archivo ya no contiene el contrato completo

Mantener dos documentos `HUMAN_HANDOFF.md` con estados diferentes generó una contradicción directa: uno decía “fase futura” mientras el otro describía el lifecycle ya desplegado.

Se conserva este path por compatibilidad con enlaces históricos, pero actúa únicamente como redirect/contexto. El contenido detallado original sigue disponible en el historial Git.