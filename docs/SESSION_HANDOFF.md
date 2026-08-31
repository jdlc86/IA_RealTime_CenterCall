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
- No persistir prompt, secreto, audio o transcript bruto.
- No crear un segundo workflow de despliegue.
- `IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E`.

### 4. Autoridad de despliegue

El único workflow integral es `Gemini Fast Canary Deploy`. Construye y verifica
la revisión Fast, sincroniza el Worker, ejecuta preflights, retira tags antiguos y
promociona la revisión exacta.

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
```

### 6. Primera misión

Lee `docs/PROJECT_STATUS.md`, la guía viva de seguridad y el código alcanzable
desde los dos entrypoints Fast. Continúa desde el backlog de seguridad o la
vertical solicitada sin restaurar código retirado.

## FIN DEL PROMPT
