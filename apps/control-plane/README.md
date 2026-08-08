# FASE 0 — Control Plane Worker

Este directorio contiene el Worker mínimo de Cloudflare para validar el canal telefónico de FASE 0.

## Objetivo

- Exponer `GET /health`.
- Recibir `POST /webhooks/openai`.
- Verificar la firma del webhook de OpenAI.
- Procesar `realtime.call.incoming`.
- Aplicar el tenant de desarrollo (`DEFAULT_TENANT_ID`).
- Construir la configuración Realtime de FASE 0.
- Aceptar la llamada con `POST /v1/realtime/calls/{call_id}/accept`.
- Mantener Cloudflare fuera del media path.

## Despliegue oficial: Cloudflare Workers Builds

No se requiere ordenador local.

En Cloudflare Dashboard:

1. `Workers & Pages` → `Create application`.
2. `Import a repository`.
3. Conectar GitHub.
4. Seleccionar `jdlc86/IA_RealTime_CenterCall`.
5. Production branch: `main`.
6. Root directory: `apps/control-plane`.
7. El nombre del Worker debe coincidir con `wrangler.jsonc`: `ia-realtime-centercall-dev`.
8. Build command: `npm run types && npm run check`.
9. Deploy command: `npx wrangler deploy`.
10. Guardar y desplegar.

Cloudflare instalará las dependencias desde `package.json` en cada build.

## Secretos obligatorios

Configurar desde el Dashboard del Worker, nunca en GitHub:

- `OPENAI_API_KEY`
- `OPENAI_WEBHOOK_SECRET`

Variables no secretas ya definidas en `wrangler.jsonc`:

- `ENVIRONMENT=dev`
- `DEFAULT_TENANT_ID=dev-clinic`
- `REALTIME_MODEL=gpt-realtime`
- `REALTIME_VOICE=marin`

## Comprobación inicial

Tras el despliegue, abrir:

```text
https://<worker>.workers.dev/health
```

Debe devolver una respuesta JSON con:

```json
{
  "ok": true,
  "service": "IA_RealTime_CenterCall",
  "phase": "F0",
  "environment": "dev",
  "tenant_id": "dev-clinic"
}
```

No configurar todavía Twilio ni el webhook SIP hasta que `/health` responda correctamente.

## Arquitectura F0

```text
Teléfono → Twilio/SIP → OpenAI Realtime → Twilio → Teléfono
                          ↑
                          │ control HTTP
                    Cloudflare Worker
```

Cloudflare no recibe ni retransmite RTP/audio.
