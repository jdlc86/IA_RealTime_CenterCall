# Runbook — Deployment

> **Estado:** vigente  
> **Última revisión:** 2026-08-27

El repositorio contiene **dos productos realtime con pipelines distintos**. El runbook antiguo describía sólo `apps/control-plane` y podía inducir a creer que ese flujo también gobernaba Gemini.

No es así.

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

### Verificación OpenAI

Cuando el cambio afecte esa ruta:

1. verificar CI del SHA exacto;
2. confirmar Worker/version efectiva;
3. comprobar `/health` y environment/version cuando aplique;
4. ejecutar E2E de health/routing;
5. si cambia voz/event ordering/telefonía, realizar la validación de llamada correspondiente.

## 3. Producto Gemini Fast

Componentes:

```text
apps/gemini-control-plane   → Gemini Fast Worker (Cloudflare)
apps/gemini-media-edge      → Fast Media Edge (Cloud Run)
```

Workflows relevantes actuales:

```text
.github/workflows/gemini-fast-worker-deploy.yml
.github/workflows/gemini-fast-canary-deploy.yml
```

### 3.1 Fast Worker

El workflow `Gemini Fast Worker Deploy` despliega el Worker independiente:

```text
ia-realtime-centercall-gemini-fast
```

También resuelve el namespace KV por nombre y aplica seeding seguro sólo cuando la categoría correspondiente no contiene una clave real.

Reglas:

- nunca sobrescribir valores KV existentes por seeding;
- nunca recrear placeholders por ausencia de una clave placeholder si ya hay claves reales del prefijo;
- configuración/secretos remotos no se copian al repositorio;
- health del Worker debe validarse después del deploy.

### 3.2 Fast Media Edge canary/tagged revision

El workflow `Gemini Fast Canary Deploy`:

1. ejecuta checks/tests del runtime Fast;
2. construye imagen inmutable;
3. snapshottea tráfico general actual de Cloud Run;
4. despliega una revisión con `--no-traffic`;
5. asigna tag `fast-<short-sha>`;
6. verifica readiness del tag;
7. actualiza el Fast Worker con la URL WSS etiquetada;
8. verifica health del Worker;
9. ejecuta un preflight bootstrap/HMAC/WSS.

### 3.3 Regla crítica: tag ≠ tráfico general

Ejemplo conceptual:

```text
Cloud Run service
  stable revision        100% general traffic
  fast-<sha> revision      0% general traffic

Gemini Fast Worker
  GEMINI_FAST_CANARY_EDGE_URL
       └──► wss://fast-<sha>---.../telnyx/gemini
```

La ruta Fast usa directamente la URL etiquetada.

Por tanto:

```text
fast revision = 0% general traffic
NO significa
fast revision = 0 llamadas
```

No promover la revisión a porcentaje general sólo para “hacerla productiva” si el diseño vigente es routing explícito por tag desde el Worker.

## 4. Verificación Gemini Fast

Después de un cambio que afecte al Fast Path, comprobar según alcance:

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

### Preflight

El endpoint actual `/internal/preflight` prueba, entre otros:

```text
telnyxApiKey          PRESENT
telnyxPublicKey       PRESENT_VALID
admissionIdentity     PRESENT
mediaCredentialHmac   VERIFIED
mediaControlToken     VERIFIED
canaryEdge            VERIFIED
systemInstruction     PRESENT
tools                 EMPTY
bootstrap             VERIFIED
websocketUpgrade      VERIFIED
tenantRouting         KV_RUNTIME_ONLY
```

No depende de una configuración productiva de tenant/teléfono para probar bootstrap/WSS.

## 5. Deuda conocida del gate Fast Canary

Al snapshot 2026-08-27, el último paso del workflow tiene una divergencia con el contrato actual:

- puede recibir `503 PREFLIGHT_UNAVAILABLE` mientras propaga el nonce efímero;
- su jq final todavía espera campos históricos como `telnyxRouting`, `canaryCalledNumber` y `canaryTenant`;
- `routeFastGeminiPreflight` actual devuelve en su lugar `tenantRouting: KV_RUNTIME_ONLY` y prueba la infraestructura sin tenant productivo.

Hasta corregir ese gate:

- registrar el job como **rojo por deuda del verificador**, no como success;
- revisar qué pasos anteriores sí pasaron;
- no declarar automáticamente que el hot path falló;
- tampoco ignorar el rojo: corregir el verificador antes de considerarlo un gate fiable.

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

GitHub debe contener siempre el software y la documentación que describen la versión operada. Los paneles cloud son estado de ejecución, no una segunda fuente de verdad de código.