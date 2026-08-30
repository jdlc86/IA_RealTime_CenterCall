# Runbook — Deployment

> **Estado:** vigente
> **Última revisión:** 2026-08-29

El repositorio contiene **dos productos realtime con pipelines distintos**. El flujo de `apps/control-plane` no gobierna por sí solo Gemini Fast.

## 1. Regla general

Todo despliegue debe poder responder:

```text
¿Qué SHA se publicó?
¿Qué componente cambió?
¿Qué workflow/command lo desplegó?
¿Qué versión/revisión quedó efectiva?
¿Qué routing/binding la usa?
¿Qué health/readiness pasó?
¿Hace falta E2E real para cerrar el cambio?
```

No confundir:

```text
build exitoso
≠ versión subida
≠ tráfico efectivo
≠ llamada E2E validada
```

## 2. Producto OpenAI

Directorio principal:

```text
apps/control-plane
```

Workers históricos:

| Perfil | Worker | Dry-run | Upload/version | Deploy/promoción |
|---|---|---|---|---|
| production | `ia-realtime-centercall` | `npm run check:production` | `npm run upload:production` | `npm run deploy:production` |
| preview | `ia-realtime-centercall-preview` | `npm run check:preview` | `npm run upload:preview` | `npm run deploy:preview` |
| dev | `ia-realtime-centercall-dev` | `npm run check:dev` | `npm run upload:dev` | `npm run deploy:dev` |

Este bloque se conserva para la ruta OpenAI. **No usarlo para inferir el estado del Worker Gemini Fast.**

## 3. Producto Gemini Fast

Componentes:

```text
apps/gemini-control-plane   → Gemini Fast Worker (Cloudflare)
apps/gemini-media-edge      → Fast Media Edge (Cloud Run)
```

Workflows relevantes:

```text
.github/workflows/gemini-fast-worker-deploy.yml
.github/workflows/gemini-fast-canary-deploy.yml
```

### 3.1 Fast Worker

`Gemini Fast Worker Deploy` despliega:

```text
ia-realtime-centercall-gemini-fast
```

El workflow también resuelve el namespace KV por nombre y aplica seeding seguro.

Reglas:

- nunca sobrescribir valores KV existentes por seeding;
- no crear placeholders si ya existe una clave real del mismo prefijo;
- no copiar secretos/configuración remota al repositorio;
- validar health después del deploy.

### 3.2 Fast Media Edge: canary verified, then production

`Gemini Fast Canary Deploy`:

1. ejecuta checks/tests del runtime Fast;
2. construye imagen inmutable;
3. snapshottea el tráfico general de Cloud Run;
4. despliega una revisión con `--no-traffic`;
5. asigna tag `fast-<short-sha>`;
6. verifica readiness del tag;
7. actualiza el Fast Worker con la URL WSS etiquetada;
8. verifica health del Worker;
9. ejecuta un preflight bootstrap/HMAC/WSS;
10. elimina tags Fast obsoletos;
11. promueve la revisión verificada al 100% del tráfico general;
12. verifica que la URL general identifica `gemini-media-edge-fast`.

### 3.3 Tag ≠ tráfico general

```text
Cloud Run service
  fast-<sha> revision    100% general traffic

Gemini Fast Worker
  GEMINI_FAST_CANARY_EDGE_URL
       └──► wss://fast-<sha>---.../telnyx/gemini
```

La URL general y la URL etiquetada resuelven la misma revisión Fast. El tag se
conserva para que el Worker mantenga routing explícito y verificable.

```text
default Cloud Run URL ─┐
                      ├──► misma revisión Fast verificada
Fast Worker tag URL ──┘
```

El workflow legado `Gemini Media Edge Canary Deploy` fue retirado: no debe volver
a desplegar una revisión genérica de 2 GiB sobre este servicio.

## 4. Verificación Gemini Fast

### Worker

- deploy success;
- Worker correcto;
- KV binding presente;
- variables/bindings esperados sin exponer secretos;
- `/health` válido.

### Media Edge

- imagen inmutable del SHA esperado;
- revisión/tag esperado;
- `/ready` válido;
- provider readiness dentro de budgets aplicables;
- Worker apuntando exactamente al WSS del tag esperado.

### Preflight actual

`/internal/preflight` prueba el contrato de infraestructura sin depender de un tenant/teléfono productivos. El response actual incluye:

```text
telnyxApiKey             PRESENT
telnyxPublicKey          PRESENT_VALID
admissionIdentitySecret  PRESENT
mediaCredentialHmac      VERIFIED
mediaControlToken        VERIFIED
canaryEdge               VERIFIED
systemInstruction        PRESENT
tools                    EMPTY
bootstrap                VERIFIED
websocketUpgrade         VERIFIED
tenantRouting            KV_RUNTIME_ONLY
```

## 5. Gate Fast Canary vigente

El workflow y `routeFastGeminiPreflight` están alineados con el contrato actual. El gate exige, entre otros:

```text
tenantRouting = KV_RUNTIME_ONLY
mediaCredentialHmac = VERIFIED
mediaControlToken = VERIFIED
canaryEdge = VERIFIED
bootstrap = VERIFIED
websocketUpgrade = VERIFIED
```

También ejecuta un probe autenticado de la frontera de seguridad semántica: un payload vacío debe devolver HTTP `400` con `INVALID_SECURITY_SIGNAL` sin persistir evento.

El preflight conserva retry bounded de diez intentos para respuestas temporales `401`/`503` durante propagación de nonce. Un fallo del gate se diagnostica en su capa exacta; no se convierte automáticamente en una regresión de audio y tampoco se ignora.

## 6. Cuándo exigir llamada real

Una llamada E2E es obligatoria para cerrar cambios que afecten, por ejemplo:

- audio/VAD/barge-in;
- latencia conversacional perceptible;
- tool flow conversacional;
- transferencia humana;
- ringback/early media;
- TTS audible;
- routing telefónico.

Un unit test o un evento de control no demuestra por sí solo experiencia acústica.

## 7. Rollback / contención

Ante una regresión:

1. identificar primero si el fallo está en Worker, routing/KV, tagged edge, Gemini provider, Telnyx o effect/control;
2. no tocar audio estable si la causalidad está en control/deploy;
3. volver al SHA/binding/revisión previamente validado según el componente afectado;
4. conservar evidencia de la versión efectiva y del error;
5. actualizar `PROJECT_STATUS.md` si el estado operativo cambia.

## 8. Regla final

GitHub debe contener el software y la documentación que describen la versión operada. Los paneles cloud son estado de ejecución, no una segunda fuente de verdad de código.
