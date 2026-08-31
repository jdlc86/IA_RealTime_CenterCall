# IA_RealTime_CenterCall — resumen del sistema

## Producto vigente

IA_RealTime_CenterCall opera un único runtime realtime basado en Gemini:

```text
Caller
  ↕ PSTN
Telnyx
  ├─ webhook/control ──► Gemini Fast Worker (Cloudflare)
  └─ media WSS ◄──────► Fast Media Edge (Cloud Run) ◄──────► Gemini Live
```

El Worker resuelve tenant, valida Telnyx, ejecuta admission y caller-security,
emite credenciales, registra bootstrap, autoriza tools, inicia transferencias y
persiste diagnóstico mínimo. El Media Edge conserva únicamente el hot path de
audio y el lifecycle inmediato de Gemini.

## Componentes activos

- `apps/gemini-control-plane`: Worker Fast y control plane.
- `apps/gemini-media-edge`: media plane Fast.
- `supabase/migrations`: persistencia e invariantes compartidas.
- `Security/`: guía viva de seguridad.
- `.github/workflows/gemini-fast-canary-deploy.yml`: despliegue integral.

## Componentes retirados

El producto realtime anterior, el prototipo Gemini con Durable Object/control
WSS por turno, el Media Edge genérico y el comparador Fly/Cloud Run fueron
retirados del árbol. No son fallbacks. Su contenido permanece en el historial Git.

## Invariantes

- Sin audio continuo por Cloudflare.
- Sin trabajo nuevo por chunk sin ADR y benchmark.
- Sin failover silencioso.
- El modelo propone; el kernel autoriza; el dominio valida; el backend ejecuta.
- Toda tool tiene schema, authority, effect, capability, evidence y contexto.
- Las acciones con efectos exigen recibo opaco, idempotencia y pruebas negativas.
- La telemetría nunca guarda prompt, secreto, audio o transcript bruto.
- El estado call-scoped en memoria obliga a `max-instances=1` hasta migración atómica.
