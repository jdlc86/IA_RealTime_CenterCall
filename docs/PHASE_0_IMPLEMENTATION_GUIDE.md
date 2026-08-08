# IA_RealTime_CenterCall — GUÍA DE IMPLEMENTACIÓN FASE 0

> **Estado:** Guía operativa oficial — v1.0  
> **Fecha:** 2026-08-08  
> **Arquitectura de referencia:** `docs/ARCHITECTURE_SPECIFICATION.md` v1.6  
> **Objetivo:** completar FASE 0 sin depender de un ordenador local como parte del flujo normal de desarrollo o ejecución.

---

# 0. Principio de esta guía: cloud-first

FASE 0 se desarrollará y operará con un flujo **cloud-first**.

El ordenador local **no es un requisito arquitectónico ni operativo**. No forma parte del sistema y no debe ser necesario para mantener la centralita funcionando.

Flujo oficial de desarrollo:

```text
ChatGPT / edición GitHub
        ↓
Repositorio GitHub
        ↓ push/commit
Cloudflare Workers Builds
        ↓
Build + Deploy automático
        ↓
Cloudflare Worker público
```

Plataformas utilizadas:

```text
GitHub
  → fuente de verdad del código

Cloudflare
  → build, deploy, Worker, variables, secretos y logs

OpenAI Platform
  → API key, webhook, SIP y Realtime

Twilio
  → número telefónico, PSTN y Elastic SIP Trunk
```

El PC local queda únicamente como **herramienta opcional de contingencia o desarrollo avanzado**. La guía no requiere instalar Node.js, npm, Git ni Wrangler localmente.

## 0.1 Regla de fuente de verdad

No editar código manualmente en el editor de Cloudflare salvo diagnóstico excepcional.

El código fuente oficial vive en GitHub. Cloudflare despliega desde GitHub.

Esto evita tener:

```text
versión GitHub ≠ versión Cloudflare
```

---

# 1. Qué vamos a demostrar

FASE 0 responde únicamente:

> ¿Puede una persona llamar desde un teléfono real, ser atendida por OpenAI Realtime, conversar naturalmente, interrumpir a la IA y colgar correctamente?

Ruta de audio:

```text
Teléfono
   ↓
PSTN
   ↓
Twilio
   ↓ SIP/RTP
OpenAI Realtime
   ↓
Twilio
   ↓
Teléfono
```

Ruta de control:

```text
OpenAI
   ↓ realtime.call.incoming
Cloudflare Worker
   ↓
verifica webhook
   ↓
binding tenant F0
   ↓
construye configuración Realtime
   ↓
POST /v1/realtime/calls/{call_id}/accept
```

**Cloudflare no transporta audio.**

---

# 2. Qué NO se implementa todavía

FASE 0 no incluye:

- citas;
- clínica real;
- restaurante;
- CRM;
- agenda;
- reservas;
- pedidos;
- ToolGateway;
- MCP;
- D1;
- RAG;
- dashboard;
- handoff humano;
- multi-tenant productivo;
- load testing masivo.

Se utiliza un tenant ficticio de desarrollo para respetar la arquitectura sin introducir todavía lógica empresarial.

---

# 3. Cuentas necesarias

Crear o disponer de:

1. cuenta GitHub;
2. cuenta Cloudflare;
3. cuenta OpenAI Platform con facturación/API habilitada;
4. cuenta Twilio con capacidad para adquirir/configurar un número y Elastic SIP Trunking.

No guardar claves API en GitHub.

---

# 4. Estructura mínima del repositorio

El código de F0 debe quedar en:

```text
IA_RealTime_CenterCall/
├── docs/
│   ├── ARCHITECTURE_SPECIFICATION.md
│   └── PHASE_0_IMPLEMENTATION_GUIDE.md
└── apps/
    └── control-plane/
        ├── src/
        │   └── index.ts
        ├── package.json
        ├── tsconfig.json
        └── wrangler.jsonc
```

El Worker es deliberadamente pequeño.

---

# 5. Paso 1 — Crear el código del Worker en GitHub

Crear `apps/control-plane/package.json`:

```json
{
  "name": "ia-realtime-centercall-control-plane",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "check": "tsc --noEmit",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "openai": "latest"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "latest",
    "typescript": "latest",
    "wrangler": "latest"
  }
}
```

Crear `apps/control-plane/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*.ts"]
}
```

Crear `apps/control-plane/wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "ia-realtime-centercall-dev",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-08",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "ENVIRONMENT": "dev",
    "DEFAULT_TENANT_ID": "dev-f0",
    "REALTIME_MODEL": "gpt-realtime",
    "REALTIME_VOICE": "marin"
  },
  "observability": {
    "enabled": true
  }
}
```

**Importante:** `OPENAI_API_KEY` y `OPENAI_WEBHOOK_SECRET` NO aparecen en este archivo porque son secretos.

---

# 6. Paso 2 — Worker F0

Crear `apps/control-plane/src/index.ts`:

```ts
import OpenAI from "openai";

interface Env {
  OPENAI_API_KEY: string;
  OPENAI_WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
  DEFAULT_TENANT_ID: string;
  REALTIME_MODEL: string;
  REALTIME_VOICE: string;
}

type RealtimeIncomingEvent = {
  id: string;
  type: "realtime.call.incoming";
  data: {
    call_id: string;
    sip_headers?: Array<{ name: string; value: string }>;
  };
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function buildDevTenantConfiguration(env: Env) {
  return {
    tenantId: env.DEFAULT_TENANT_ID,
    language: "es",
    voice: env.REALTIME_VOICE,
    instructions: `
Eres el asistente telefónico de pruebas de IA_RealTime_CenterCall.
Habla siempre en español.
Esta es exclusivamente una prueba técnica de voz de FASE 0.
Sé amable, profesional y breve.
Mantén una conversación natural.
Si el usuario te interrumpe, deja de hablar y escúchalo.
Si no entiendes algo, pide que lo repita.
No gestiones citas, reservas, pedidos ni acciones externas.
No solicites información médica ni datos sensibles.
No inventes información empresarial.
`.trim(),
  };
}

function buildRealtimeSessionConfiguration(env: Env) {
  const tenant = buildDevTenantConfiguration(env);

  return {
    type: "realtime",
    model: env.REALTIME_MODEL,
    instructions: tenant.instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcmu" },
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          idle_timeout_ms: 10000,
        },
      },
      output: {
        format: { type: "audio/pcmu" },
        voice: tenant.voice,
        speed: 1.0,
      },
    },
    tools: [],
    tool_choice: "none",
  };
}

async function acceptCall(callId: string, env: Env): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    return await fetch(
      `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "X-Client-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify(buildRealtimeSessionConfiguration(env)),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function handleOpenAIWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();

  const client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    webhookSecret: env.OPENAI_WEBHOOK_SECRET,
  });

  let event: RealtimeIncomingEvent;

  try {
    event = client.webhooks.unwrap(rawBody, request.headers) as RealtimeIncomingEvent;
  } catch (error) {
    console.error(JSON.stringify({
      event: "invalid_openai_webhook",
      error: error instanceof Error ? error.message : String(error),
    }));
    return json({ ok: false, error: "invalid_webhook_signature" }, 400);
  }

  if (event.type !== "realtime.call.incoming") {
    return json({ ok: true, ignored: true });
  }

  const callId = event.data?.call_id;
  if (!callId) return json({ ok: false, error: "missing_call_id" }, 400);

  const startedAt = Date.now();

  console.log(JSON.stringify({
    event: "realtime_call_incoming",
    call_id: callId,
    tenant_id: env.DEFAULT_TENANT_ID,
    sip_header_names: event.data.sip_headers?.map((h) => h.name) ?? [],
  }));

  try {
    const response = await acceptCall(callId, env);
    const responseText = await response.text();
    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      console.error(JSON.stringify({
        event: "realtime_accept_failed",
        call_id: callId,
        status: response.status,
        elapsed_ms: elapsedMs,
        openai_response: responseText,
      }));
      return json({ ok: false, error: "openai_accept_failed" }, 502);
    }

    console.log(JSON.stringify({
      event: "realtime_call_accepted",
      call_id: callId,
      tenant_id: env.DEFAULT_TENANT_ID,
      elapsed_ms: elapsedMs,
    }));

    return json({
      ok: true,
      call_id: callId,
      tenant_id: env.DEFAULT_TENANT_ID,
      setup_ms: elapsedMs,
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "realtime_accept_exception",
      call_id: callId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return json({ ok: false, error: "accept_exception" }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "IA_RealTime_CenterCall",
        phase: "F0",
        environment: env.ENVIRONMENT,
        tenant_id: env.DEFAULT_TENANT_ID,
      });
    }

    if (request.method === "POST" && url.pathname === "/webhooks/openai") {
      return handleOpenAIWebhook(request, env);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
};
```

## 6.1 Nota de arquitectura

Este código todavía es F0. La función `buildDevTenantConfiguration()` representa el binding explícito del tenant de desarrollo exigido por la especificación. En F1 se sustituirá por los contratos definitivos `TenantResolver`, `TenantConfiguration` y `RealtimeProvider`.

No se debe convertir F0 en una implementación prematura de toda la arquitectura.

---

# 7. Paso 3 — Conectar GitHub con Cloudflare Workers Builds

Todo este paso se realiza en navegador.

1. Entrar en Cloudflare Dashboard.
2. Abrir **Workers & Pages**.
3. Seleccionar **Create application**.
4. Elegir **Import a repository**.
5. Autorizar la aplicación GitHub de Cloudflare si se solicita.
6. Seleccionar `jdlc86/IA_RealTime_CenterCall`.
7. Configurar el directorio raíz del Worker como:

```text
apps/control-plane
```

8. El nombre del Worker en Cloudflare debe coincidir con `name` de `wrangler.jsonc`:

```text
ia-realtime-centercall-dev
```

9. Guardar y desplegar.

Cloudflare instalará dependencias, construirá y desplegará desde el repositorio.

A partir de ese momento, los commits en la rama configurada dispararán automáticamente nuevos builds/deploys.

## 7.1 Criterio de éxito

Cloudflare debe proporcionar una URL pública similar a:

```text
https://ia-realtime-centercall-dev.<subdominio>.workers.dev
```

Abrir:

```text
https://...workers.dev/health
```

Debe responder JSON con `ok: true`.

**No continuar si `/health` no funciona.**

---

# 8. Paso 4 — Configurar variables y secretos en Cloudflare

Las variables no sensibles ya están en `wrangler.jsonc`.

Los secretos se configuran en el Dashboard del Worker, no en GitHub.

Necesitaremos:

```text
OPENAI_API_KEY
OPENAI_WEBHOOK_SECRET
```

Primero configurar únicamente `OPENAI_API_KEY` cuando se haya creado en OpenAI.

Ruta aproximada en Cloudflare:

```text
Worker
  → Settings
  → Variables and Secrets
```

Crear `OPENAI_API_KEY` como **Secret**.

Nunca pegar la API key en:

- código;
- commit;
- issue;
- README;
- `wrangler.jsonc`;
- conversación pública.

---

# 9. Paso 5 — Configurar OpenAI Platform

1. Entrar en OpenAI Platform.
2. Crear/seleccionar un Project de desarrollo para `IA_RealTime_CenterCall`.
3. Configurar facturación/límites según corresponda.
4. Crear una API key del proyecto.
5. Guardarla como `OPENAI_API_KEY` en Cloudflare.
6. Localizar la configuración de Webhooks del proyecto.
7. Crear un webhook público apuntando a:

```text
https://<worker>.workers.dev/webhooks/openai
```

8. Suscribirse al evento:

```text
realtime.call.incoming
```

9. Copiar el signing secret del webhook.
10. Guardarlo en Cloudflare como:

```text
OPENAI_WEBHOOK_SECRET
```

11. Localizar/copiar el endpoint SIP que OpenAI indique para llamadas Realtime del proyecto.

**No inventar el endpoint SIP. Copiar literalmente el valor mostrado/documentado por OpenAI para el proyecto.**

---

# 10. Paso 6 — Configurar Twilio

1. Entrar en Twilio Console.
2. Crear/configurar cuenta y facturación.
3. Adquirir un número con capacidad de voz para la prueba.
4. Entrar en **Elastic SIP Trunking**.
5. Crear un trunk llamado, por ejemplo:

```text
IA-RealTime-CenterCall-F0
```

6. Abrir **Origination**.
7. Crear una Origination SIP URI usando exactamente el endpoint SIP de OpenAI.
8. Si OpenAI requiere TLS, usar el formato SIP/transport indicado; no sustituirlo por una URI inventada.
9. Abrir **Numbers**.
10. Asociar el número Twilio al trunk.

La función de Origination es:

```text
PSTN → número Twilio → Elastic SIP Trunk → OpenAI SIP
```

En F0 no necesitamos construir una PBX propia.

---

# 11. Paso 7 — Primera llamada

Antes de llamar:

- `/health` funciona;
- build Cloudflare está verde;
- `OPENAI_API_KEY` existe;
- `OPENAI_WEBHOOK_SECRET` existe;
- webhook OpenAI apunta al Worker;
- Twilio trunk tiene Origination SIP URI;
- número está asociado al trunk.

Entonces llamar desde un móvil al número Twilio.

Secuencia esperada:

```text
1. móvil llama al número Twilio
2. Twilio recibe PSTN
3. Twilio envía SIP INVITE a OpenAI
4. OpenAI genera realtime.call.incoming
5. OpenAI llama al webhook Cloudflare
6. Worker verifica la firma
7. Worker hace binding DEFAULT_TENANT_ID=dev-f0
8. Worker construye configuración Realtime
9. Worker llama /v1/realtime/calls/{call_id}/accept
10. OpenAI acepta la llamada
11. audio queda Twilio ↔ OpenAI
12. usuario habla con la IA
```

Para la primera prueba, decir:

```text
Hola, ¿me escuchas?
```

No exigir todavía saludo espontáneo de la IA antes de hablar; primero validar el canal E2E.

---

# 12. Paso 8 — Logs sin PC local

No usar `wrangler tail` como requisito normal.

Consultar logs desde Cloudflare Dashboard:

```text
Worker
  → Logs / Observability
```

Buscar eventos:

```text
realtime_call_incoming
realtime_call_accepted
realtime_accept_failed
invalid_openai_webhook
```

Un flujo correcto debe mostrar, como mínimo:

```text
realtime_call_incoming
        ↓
realtime_call_accepted
```

El `call_id` permite correlacionar la llamada.

---

# 13. Diagnóstico por capas

No cambiar varias plataformas simultáneamente. Diagnosticar en este orden:

```text
A. ¿/health funciona?
   no → GitHub/Cloudflare build/deploy
   sí ↓

B. ¿Twilio recibe la llamada?
   no → número/cuenta/PSTN
   sí ↓

C. ¿Twilio intenta Origination SIP?
   no → trunk/número/origination
   sí ↓

D. ¿OpenAI recibe SIP y genera realtime.call.incoming?
   no → Twilio → OpenAI SIP
   sí ↓

E. ¿Cloudflare recibe el webhook?
   no → webhook OpenAI/URL
   sí ↓

F. ¿La firma es válida?
   no → OPENAI_WEBHOOK_SECRET
   sí ↓

G. ¿/accept devuelve éxito?
   no → API key/modelo/configuración
   sí ↓

H. ¿Hay audio bidireccional?
   no → SIP/codec/media
   sí ↓

I. ¿Barge-in funciona?
   no → VAD/configuración
   sí ↓

FASE 0 funcional
```

---

# 14. Pruebas obligatorias F0

Ejecutar:

- F0-T01 setup + primera conversación;
- F0-T02 ≥5 preguntas;
- F0-T03 llamada ≥5 minutos;
- F0-T04 interrumpir a la IA mientras habla;
- F0-T05 silencio 5–10 segundos;
- F0-T06 colgar desde el móvil;
- F0-T07 20 llamadas consecutivas.

Registrar por prueba:

| Campo | Valor |
|---|---|
| número de test | |
| fecha/hora | |
| PASS/FAIL | |
| setup aproximado | |
| audio inbound | |
| audio outbound | |
| barge-in | |
| duración | |
| cierre limpio | |
| error/log relevante | |

---

# 15. Gate F0

FASE 0 solo termina si:

1. una llamada PSTN real entra;
2. OpenAI Realtime atiende automáticamente tras el bootstrap;
3. audio funciona en ambos sentidos;
4. existe conversación multi-turno coherente;
5. barge-in es razonable;
6. una llamada de 5 minutos permanece estable;
7. colgar limpia correctamente la sesión;
8. al menos 19 de 20 llamadas completan setup y conversación básica;
9. se documenta un baseline inicial de latencia;
10. el Worker no transporta audio;
11. el sistema sigue funcionando con cualquier ordenador personal apagado.

---

# 16. Qué significa terminar F0

Al superar el Gate tendremos validado:

```text
telefonía real
+ SIP
+ OpenAI speech-to-speech
+ control mínimo Cloudflare
+ webhook firmado
+ tenant binding de desarrollo
+ VAD
+ barge-in
+ despliegue automático GitHub → Cloudflare
```

Todavía no tendremos una clínica funcional. Eso empieza después, siguiendo las fases de `ARCHITECTURE_SPECIFICATION.md`.

---

# 17. Política de desarrollo posterior

A partir de esta guía, el flujo normal será:

```text
cambio de código
   ↓
GitHub
   ↓
Cloudflare Workers Builds
   ↓
build/deploy
   ↓
prueba
   ↓
logs Cloudflare
```

No se requerirá un PC local para el funcionamiento del servicio ni como procedimiento ordinario de despliegue.

Si más adelante un diagnóstico complejo exige herramientas locales, se tratará como una herramienta auxiliar, no como dependencia del sistema.

---

# 18. Referencias oficiales que deben verificarse durante la ejecución

Las interfaces de las plataformas pueden cambiar. Antes de introducir un endpoint, campo o configuración no presente en esta guía, comprobar documentación oficial actual de:

- Cloudflare Workers Builds / Git integration;
- Cloudflare Workers variables/secrets/observability;
- OpenAI Realtime SIP y Calls API;
- OpenAI Webhooks;
- Twilio Elastic SIP Trunking Origination.

La documentación oficial de cada proveedor prevalece sobre capturas de pantalla antiguas, tutoriales de terceros o nombres de menús obsoletos.
