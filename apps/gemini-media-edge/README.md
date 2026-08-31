# Gemini Fast Media Edge

Único media plane realtime del producto. Su camino continuo es:

```text
Telnyx media WebSocket <-> Fast Media Edge <-> Gemini Live
```

Cloudflare conserva señalización, admission, tenant routing, autorización de
tools, transferencia y diagnóstico. No transporta audio continuo.

## Entry points vigentes

- `src/startup-fast.mjs`
- `src/server-fast.mjs`
- `src/fast-runtime.mjs`
- `src/fast-gemini31.mjs`
- `Dockerfile.fast`

El runtime genérico anterior a Fast, Google STT/TTS sidecars, semantic
preselection y control WSS por turno fueron retirados. Git conserva su historial;
no deben restaurarse como fallback.

## Seguridad y estado

Cada upgrade WSS exige una credencial HMAC efímera ligada a provider, tenant,
call, edge URL, target leg y expiración. El frame Telnyx `start` debe coincidir
con esa identidad antes de consumir credencial y bootstrap. Sólo entonces se
abre Gemini Live.

Credential, bootstrap y sesión permanecen en memoria. Por ello producción se
mantiene con `max-instances=1` hasta migrar esa autoridad a almacenamiento
compartido y atómico. No se elimina esa limitación para escalar.

## Validación

```sh
npm ci
npm run check
npm test
docker build -f Dockerfile.fast .
```

El único despliegue autorizado es el workflow `Gemini Fast Canary Deploy`, que
construye una imagen inmutable, valida la revisión etiquetada, sincroniza el Fast
Worker, ejecuta preflights, retira tags obsoletos y promociona la revisión exacta.

Runbook: [`deploy/cloud-run/README.md`](deploy/cloud-run/README.md).
