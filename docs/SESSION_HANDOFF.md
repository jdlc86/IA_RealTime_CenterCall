# Relevo operativo

## INICIO DEL PROMPT

Trabajas en `jdlc86/IA_RealTime_CenterCall`, rama estable
`rebuild/v39-stable-baseline`.

### 1. Verificación inicial

Antes de afirmar estado actual, verifica:

- HEAD remoto, PR y checks;
- versión efectiva del Gemini Fast Worker;
- URL/tag/revisión efectiva de Cloud Run;
- migraciones/evidencia Supabase cuando aplique.

El último snapshot documental auditado es `2026-09-30`: stable
`734b3b4fda7ae84b35270c1c813ccafb7171f8d8`, runtime de producción
`98b62a4dbf0456b13219cb945b544b67f41a88e6`, run `36375878767` y revisión
`gemini-media-edge-00237-neb`. Son evidencia de partida, no sustituyen una nueva
consulta remota si la sesión va a operar producción.

No hagas llamadas reales, despliegues o cambios de infraestructura sin autorización.

### 2. Arquitectura vigente

```text
Telnyx → Gemini Fast Worker → Fast Media Edge ↔ Gemini Live
```

Cloudflare nunca relaya audio continuo. Sólo existen
`apps/gemini-control-plane` y `apps/gemini-media-edge` como productos
ejecutables. El historial retirado no es fallback ni dependencia.

### 3. Reglas arquitectónicas que no puedes violar

- No añadir latencia al hot path.
- No añadir trabajo por chunk sin ADR y benchmark.
- No escalar horizontalmente mientras credential/bootstrap/sesión sean in-memory.
- El modelo propone; kernel, dominio y backend autorizan/ejecutan.
- Toda tool exige policy local y recibo opaco antes del efecto.
- El reloj, calendario y zona IANA del tenant pertenecen a la autoridad temporal
  horizontal; el modelo no inventa el “ahora” y cada vertical conserva sólo sus
  horarios, horizontes y reglas empresariales.
- No persistir prompt, secreto, audio o transcript bruto.
- Toda retención y purga se ejecuta por lotes en Supabase, fuera del hot path.
- Toda función PostgreSQL nueva se registra en el manifiesto horizontal, fija
  `search_path=''` y recibe sólo los roles de su perfil.
- WhatsApp transaccional lee exclusivamente
  `tenant_config:<tenantId>.communications.whatsapp`; no se restauran claves KV
  globales `whatsapp.*`. El canary no es aún una outbox ni una confirmación de
  cita productiva.
- No crear un segundo workflow de despliegue.
- `IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E`.

### 4. Autoridad de despliegue

El único workflow integral es `Gemini Fast Canary Deploy`. Construye y verifica
la revisión Fast, sincroniza el Worker, ejecuta preflights, retira tags antiguos y
promociona la revisión exacta.

El filtro automático actual no incluye
`apps/gemini-control-plane/src/communications/**`. Si un cambio sólo toca ese
módulo, el despliegue integral debe lanzarse mediante `workflow_dispatch` hasta
que se amplíe el filtro; no se crea un workflow alternativo.

### 5. Validación local

```bash
cd apps/gemini-control-plane
npm install
npm run docs:check
npm run check

cd ../gemini-media-edge
npm ci
npm run check
npm test

cd ../..
node --test scripts/check-database-function-boundaries.test.mjs
```

Para cambios temporales, ejecutar además la suite focalizada
`src/kernel/temporal-authority.test.ts` y revisar
[`runbooks/TEMPORAL_AUTHORITY.md`](./runbooks/TEMPORAL_AUTHORITY.md).

### 6. Primera misión

Lee `docs/PROJECT_STATUS.md`, la guía viva de seguridad y el código alcanzable
desde los dos entrypoints Fast. Continúa desde el backlog de seguridad o la
vertical solicitada sin restaurar código retirado.

## FIN DEL PROMPT
