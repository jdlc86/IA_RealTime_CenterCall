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
7. El nombre productivo debe coincidir con `wrangler.jsonc`: `ia-realtime-centercall`.
8. Build command: `npm run types && npm run check` (valida production, preview y dev sin desplegar).
9. Deploy command para `main`: `npm test && npm run check && npx wrangler deploy --env=""`.
10. Version command para ramas no productivas: `npm test && npm run check && npx wrangler versions upload --env=""`.
11. Guardar.

Cloudflare instalará las dependencias desde `package.json` en cada build.

## Secretos obligatorios

Configurar desde el Dashboard del Worker, nunca en GitHub:

- `OPENAI_API_KEY`
- `OPENAI_WEBHOOK_SECRET`
- `TELNYX_API_KEY`
- `TELNYX_PUBLIC_KEY`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`

Perfiles no secretos definidos en `wrangler.jsonc`:

- producción por defecto: `ia-realtime-centercall`, `ENVIRONMENT=production`;
- preview: `ia-realtime-centercall-preview`, `ENVIRONMENT=preview`;
- desarrollo: `ia-realtime-centercall-dev`, `ENVIRONMENT=dev`;
- `REALTIME_MODEL=gpt-realtime`
- `REALTIME_VOICE=marin`

`vars`, KV y Durable Objects no se heredan automáticamente en entornos nombrados;
por eso cada perfil declara explícitamente los mismos nombres de bindings. Los
recursos y secretos reales deben configurarse por separado en Cloudflare antes
del primer despliegue de cada perfil.

### Canary Gemini por entorno y tenant

Todos los perfiles se publican sin bindings Gemini y por tanto permanecen
desactivados. Para admitir un único tenant canario en `preview` o en la prueba
controlada de producción hay que configurar:

- `GEMINI_REALTIME_ENABLED=true`;
- `GEMINI_CANARY_TENANT_ID=<tenant_id exacto>`;
- `GEMINI_MEDIA_EDGE_URL=wss://<cloud-run>/telnyx/gemini`;
- `MEDIA_EDGE_CREDENTIAL_HMAC_SECRET` (el mismo secreto que Cloud Run);
- `MEDIA_EDGE_CONTROL_PLANE_TOKEN` (el mismo secreto que Cloud Run).

El token compartido tiene como fuente de verdad
`gemini-media-edge-control-plane-token` en Google Secret Manager. Los workflows
`Gemini Fast Canary Deploy` y `Gemini Fast Worker Secret Sync` deben copiar esa
misma versión a `MEDIA_EDGE_CONTROL_PLANE_TOKEN` en este Worker y a
`GEMINI_MEDIA_CONTROL_PLANE_TOKEN` en el Fast Worker. El canary comprueba la
paridad con un payload autenticado deliberadamente inválido (`{}`): debe recibir
`400 INVALID_SECURITY_SIGNAL`, sin crear un evento de reputación.

La admisión exige simultáneamente un entorno `preview` o `production`, el flag
explícito y la coincidencia exacta del tenant. Desarrollo siempre rechaza Gemini.
La ausencia del tenant canario o de cualquiera de los secretos también falla
cerrada. El ingress activo no ejecuta `streaming_start` hasta completar credencial,
bootstrap, arranque del CallSession real y sideband autenticado. La configuración
de Cloud Run está en `../gemini-media-edge/deploy/cloud-run/README.md`.

Workers Builds usa el Version command para subir una versión candidata de las
ramas no productivas sin promoverla. Sólo el Deploy command de la rama `main`
actualiza el tráfico. Ambos ejecutan la batería completa y los dry-runs antes de
Wrangler, de modo que la validación no depende del campo Build command del
panel. Los scripts `upload:*` y `deploy:*` ofrecen los mismos límites explícitos
para operaciones manuales.

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
  "phase": "F5",
  "environment": "production"
}
```

Verificación E2E de solo lectura:

```text
npm run test:e2e:health -- --url https://<worker>.workers.dev --environment production
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
