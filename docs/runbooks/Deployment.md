# Runbook — Deployment

> **Estado:** vigente  
> **Última revisión:** 2026-08-28

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

### 3.2 Fast Media Edge canary/tagged revision

`Gemini Fast Canary Deploy`:

1. ejecuta checks/tests del runtime Fast;
2. construye imagen inmutable;
3. snapshottea el tráfico general de Cloud Run;
4. despliega una revisión con `--no-traffic`;
5. asigna tag `fast-<short-sha>`;
6. verifica readiness del tag;
7. actualiza el Fast Worker con la URL WSS etiquetada;
8. verifica health del Worker;
9. ejecuta un preflight bootstrap/HMAC/WSS.

### 3.3 Tag ≠ tráfico general

```text
Cloud Run service
  stable revision        100% general traffic
  fast-<sha> revision      0% general traffic

Gemini Fast Worker
  GEMINI_FAST_CANARY_EDGE_URL
       └──► wss://fast-<sha>---.../telnyx/gemini
```

La ruta Fast usa directamente la URL etiquetada. Por tanto:

```text
fast revision = 0% general traffic
NO significa
fast revision = 0 llamadas
```

No promover una revisión al tráfico general únicamente para “hacerla productiva” si el diseño vigente usa routing explícito por tag desde el Worker.

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

## 5. Deuda conocida del gate Fast Canary

Al snapshot 2026-08-28 existe una divergencia **demostrada** entre el `jq` final del workflow y el response real de `routeFastGeminiPreflight`.

El workflow todavía exige campos históricos:

```text
telnyxRouting
canaryCalledNumber
canaryTenant
```

El endpoint actual ya no devuelve esos campos y en su lugar expone:

```text
tenantRouting = KV_RUNTIME_ONLY
```

Por tanto, el gate puede quedar rojo después de que build, revisión etiquetada, readiness, sincronización Worker y health hayan pasado.

### Retry de nonce

El workflow actual **ya implementa retry bounded de 10 intentos** para respuestas temporales `401`/`503`, con espera entre intentos. No documentar `set -e` o ausencia de retry como causa vigente salvo nueva evidencia concreta.

Un `503 PREFLIGHT_UNAVAILABLE` temporal puede seguir aparecer mientras se propaga el nonce, pero el defecto estructural actualmente demostrado es la aserción `jq` desalineada.

### Criterio de corrección

La reparación del gate debe:

1. conservar el retry bounded existente;
2. actualizar `jq` al contrato real de `fast-preflight.ts`;
3. mantener el preflight sin tenant/teléfono productivos;
4. exigir `bootstrap == VERIFIED`;
5. exigir `websocketUpgrade == VERIFIED`;
6. no tocar VAD/audio/runtime de llamada para resolver este problema de deployment verification.

Hasta corregirlo:

- registrar el job como rojo por deuda del verificador;
- revisar qué pasos anteriores sí pasaron;
- no convertir el rojo automáticamente en un fallo del hot path;
- tampoco ignorarlo como si el deploy gate fuera fiable.

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
