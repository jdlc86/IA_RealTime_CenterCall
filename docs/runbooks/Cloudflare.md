# Runbook de Cloudflare

## Worker vigente

```text
name    ia-realtime-centercall-gemini-fast
config  apps/gemini-control-plane/wrangler.fast.jsonc
entry   apps/gemini-control-plane/src/index-fast.ts
```

Responsabilidades: webhook Telnyx, routing tenant, admission, caller-security,
credenciales, bootstrap, tools/control, transferencia y diagnóstico sideband.

Cloudflare no transporta audio continuo.

## Despliegue

El Worker se despliega dentro de `Gemini Fast Canary Deploy`. No existe un
workflow autónomo de deploy del Worker porque podría competir con la revisión
Cloud Run verificada.

`Gemini Fast Worker Secret Sync` es manual y se limita a sincronización
operativa de secretos; no sustituye el despliegue integral.

## Verificación

- `/health` devuelve `gemini-control-plane-fast`;
- secrets requeridos existen por nombre, sin imprimir valores;
- KV de routing está enlazado;
- Queue/DLQ de caller-security existen;
- binding de Media Edge apunta al tag del SHA desplegado.
