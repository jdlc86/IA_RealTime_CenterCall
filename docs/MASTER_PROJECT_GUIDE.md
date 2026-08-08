# IA_RealTime_CenterCall — MASTER PROJECT GUIDE

> **Estado:** Documento maestro inicial — v0.1  
> **Fecha base:** 2026-08-08  
> **Repositorio:** `jdlc86/IA_RealTime_CenterCall`  
> **Rama base:** `main`  
> **Objetivo:** Diseñar y construir una centralita telefónica con IA de voz en tiempo real, alto rendimiento, alta disponibilidad y latencia conversacional mínima.

---

## 0. Cómo usar este documento

Este archivo es la **fuente de verdad técnica del proyecto**. Toda decisión relevante de arquitectura, requisito, métrica, prueba, dependencia externa y criterio de aceptación debe quedar reflejada aquí antes de considerarse cerrada.

Reglas de mantenimiento:

1. Ninguna fase se considera terminada si sus criterios de aceptación no están comprobados.
2. Las decisiones arquitectónicas importantes se registran en la sección **ADR / Decision Log**.
3. Las cifras de latencia deben proceder de mediciones, no de percepciones subjetivas.
4. Los proveedores deben estar encapsulados detrás de interfaces para evitar acoplamiento innecesario.
5. El camino crítico de audio debe contener el mínimo número posible de saltos, conversiones y copias.
6. Toda optimización debe comparar un valor **antes/después**.
7. Se prioriza primero una llamada impecable; después concurrencia; después escalado masivo.
8. Este documento debe actualizarse conforme avance el código.

### 0.1 Estado de fases

Usar estas marcas:

- `[ ]` No iniciado
- `[~]` En curso
- `[x]` Completado y validado
- `[!]` Bloqueado

---

# 1. Visión del producto

Construir una centralita telefónica inteligente capaz de recibir llamadas de clientes, mantener una conversación natural en español mediante IA de voz nativa en tiempo real, utilizar herramientas empresariales durante la llamada y transferir la conversación a un agente humano cuando corresponda.

El sistema debe estar diseñado desde el principio para:

- latencia conversacional mínima;
- interrupción natural del agente (*barge-in*);
- llamadas simultáneas;
- tolerancia a fallos;
- trazabilidad completa;
- herramientas empresariales seguras;
- observabilidad en tiempo real;
- sustitución de proveedor de telefonía o modelo sin reescribir el dominio;
- escalado horizontal del plano stateless;
- estado aislado por llamada;
- control de costes;
- pruebas reproducibles de rendimiento.

No se pretende crear inicialmente una suite completa de contact center. El núcleo del proyecto es el **motor de llamada IA en tiempo real**. Dashboard, campañas, analítica avanzada y otras capacidades se añadirán alrededor del núcleo sin degradar el camino crítico.

---

# 2. Principios arquitectónicos

## P1. El audio manda

La ruta de audio es el camino más sensible del sistema. Todo componente que no sea imprescindible debe quedar fuera del camino crítico.

## P2. Speech-to-speech nativo como arquitectura principal

La arquitectura principal utilizará un modelo realtime capaz de **audio de entrada → razonamiento → audio de salida**, evitando un pipeline obligatorio y secuencial:

`STT → LLM → TTS`

El pipeline clásico podrá existir como fallback o para experimentación, pero no será la primera opción para producción de ultra baja latencia.

## P3. Una llamada = una sesión aislada

Cada llamada tendrá un identificador único, contexto, métricas, estado y lifecycle independientes.

## P4. Control plane separado del media plane

Diferenciar explícitamente:

- **Media plane:** audio y señales necesarias para conversación inmediata.
- **Control plane:** configuración, estado, autenticación, herramientas, registros, métricas, administración y políticas.

## P5. Proveedores intercambiables

Telefonía, modelo realtime, almacenamiento y herramientas empresariales deben implementarse mediante adaptadores.

## P6. Backpressure obligatorio

Nunca permitir que buffers de audio crezcan sin límite. Ante congestión se debe descartar/cancelar trabajo obsoleto antes que aumentar latencia indefinidamente.

## P7. Cancelación como operación de primera clase

Cuando el usuario interrumpe, cualquier audio pendiente o generación obsoleta debe cancelarse inmediatamente.

## P8. Medir percentiles, no solo medias

Las métricas principales utilizarán `p50`, `p95` y `p99`.

---

# 3. Arquitecturas candidatas

## 3.1 Arquitectura A — Media Bridge controlado

```text
PSTN / móvil
    │
    ▼
Proveedor telefonía
    │  WebSocket bidireccional / Media Stream
    ▼
Cloudflare Edge
    │
    ▼
Call Session / Durable Object
    │  WebSocket cliente
    ▼
Modelo Realtime Speech-to-Speech
    │
    ├── Tool Gateway / MCP
    ├── CRM / pedidos / reservas
    └── políticas
```

### Ventajas

- control completo del flujo de audio;
- telemetría detallada por chunk;
- desacoplamiento fuerte del proveedor de IA;
- posibilidad de transformación, inspección y routing dinámico;
- sencillo comparar distintos modelos.

### Desventajas

- Cloudflare queda en el camino del audio;
- salto de red adicional;
- mayor complejidad de buffering;
- riesgo de conversiones de codec;
- mayor superficie para jitter.

### Uso recomendado

MVP, experimentación, benchmarking y casos en los que necesitemos controlar directamente el media plane.

---

## 3.2 Arquitectura B — Direct SIP al modelo realtime

```text
PSTN / móvil
    │
    ▼
Proveedor telefonía / SIP trunk
    │ SIP/RTP
    ▼
OpenAI Realtime SIP
    │
    ├── conversación speech-to-speech
    │
    └── Control Plane
          │
          ▼
      Cloudflare
        ├── Webhooks
        ├── Call state
        ├── Tool Gateway / MCP
        ├── CRM
        ├── auditoría
        └── dashboard
```

### Ventajas

- elimina un puente de audio de nuestro código;
- menos procesamiento propio en el camino crítico;
- potencialmente menor latencia y jitter;
- menor riesgo de bugs en relay de audio;
- permite transferencias SIP mediante mecanismos de telefonía.

### Desventajas

- mayor dependencia de las capacidades SIP del proveedor realtime;
- menos control directo sobre cada chunk de audio;
- requiere diseñar bien observabilidad y herramientas fuera del audio path.

### Uso recomendado

Candidato preferente para producción **si los benchmarks demuestran menor latencia y mantiene las capacidades de negocio necesarias**.

---

## 3.3 Decisión provisional

**No fijar todavía una única ruta.** Implementar el dominio y control plane de forma que podamos comparar A y B con el mismo conjunto de pruebas.

La arquitectura ganadora se escogerá mediante benchmark reproducible:

- tiempo hasta primer audio de respuesta;
- interrupción efectiva;
- jitter;
- errores;
- calidad percibida;
- facilidad de tool calling;
- transferencia a humano;
- coste por minuto;
- estabilidad con concurrencia.

---

# 4. Stack inicial propuesto

## 4.1 Runtime / Edge

- Cloudflare Workers
- Cloudflare Durable Objects para estado por llamada cuando corresponda
- TypeScript
- Wrangler

## 4.2 Modelo de voz principal

Primera integración de referencia:

- OpenAI Realtime API
- modelo realtime configurable por variable de entorno
- speech-to-speech nativo
- VAD e interrupción habilitados
- function calling / MCP cuando sea apropiado

**Regla:** no codificar el nombre del modelo de forma rígida en lógica de negocio.

## 4.3 Telefonía

Primera integración de referencia:

- Twilio Programmable Voice
- opción A: Bidirectional Media Streams con `<Connect><Stream>`
- opción B: SIP trunk hacia endpoint realtime, si se adopta arquitectura Direct SIP

El proveedor de telefonía debe estar encapsulado tras `TelephonyProvider`.

## 4.4 Datos

Separar datos por naturaleza:

- estado efímero por llamada → memoria de sesión / Durable Object;
- metadatos transaccionales → D1 u otra base SQL adecuada;
- objetos grandes / grabaciones → R2 si se habilita grabación;
- métricas de alta cardinalidad → sistema de observabilidad/Analytics Engine cuando corresponda.

No guardar audio crudo en la base relacional.

## 4.5 Herramientas / Integraciones empresariales

- Tool Gateway propio
- adaptadores HTTP internos
- MCP cuando aporte interoperabilidad real
- timeouts estrictos
- circuit breakers
- idempotencia para operaciones con efectos secundarios

---

# 5. Requisitos funcionales

## RF-001 Recepción de llamada

El sistema debe aceptar una llamada entrante a un número público configurado.

**Aceptación:** una llamada real llega al sistema y obtiene respuesta controlada.

## RF-002 Inicio automático de sesión IA

Cada llamada aceptada debe crear una sesión lógica independiente.

Campos mínimos:

- `call_id`
- `provider_call_id`
- `session_id`
- `started_at`
- `direction`
- `caller_number` cuando esté disponible y permitido
- `status`
- `architecture_mode`
- `model`

## RF-003 Saludo inicial

La IA debe responder con un saludo configurado por tenant/empresa.

## RF-004 Conversación speech-to-speech

La llamada debe permitir diálogo bidireccional continuo sin requerir un pipeline STT/TTS externo secuencial.

## RF-005 Interrupción / barge-in

Si el cliente habla mientras la IA responde:

1. detectar nuevo speech;
2. cancelar generación obsoleta;
3. eliminar audio pendiente no reproducido;
4. dar prioridad al turno del cliente.

## RF-006 Detección de fin de turno

Soportar VAD configurable.

Parámetros experimentales:

- threshold;
- silence duration;
- prefix padding;
- semantic VAD / eagerness cuando esté disponible.

No optimizar estos valores sin dataset de llamadas.

## RF-007 Tool calling

La IA debe poder invocar herramientas aprobadas durante la llamada.

Ejemplos:

- `lookup_customer`
- `lookup_order`
- `create_ticket`
- `lookup_booking`
- `send_sms`
- `request_human_handoff`

## RF-008 Transferencia a humano

El sistema debe poder transferir una llamada activa a un número, extensión o destino SIP configurado.

Debe registrarse:

- motivo;
- timestamp;
- herramienta/acción que lo solicitó;
- destino;
- resultado.

## RF-009 Fin de llamada

Cualquier terminación debe cerrar la sesión de forma idempotente.

Estados sugeridos:

`CREATED → RINGING → ACTIVE → HANDOFF | COMPLETED | FAILED`

## RF-010 Transcripción auxiliar

Cuando se habilite, mantener transcripción para auditoría/analítica, pero **no convertir la transcripción en dependencia obligatoria del camino de voz**.

## RF-011 Resumen post-llamada

Generar fuera del camino crítico:

- resumen;
- intención principal;
- resolución;
- herramientas utilizadas;
- transferencia sí/no;
- errores;
- duración;
- métricas de latencia.

## RF-012 Configuración por empresa/tenant

Debe ser posible definir:

- nombre de la empresa;
- prompt/política;
- idioma;
- voz;
- modelo;
- horario;
- destino de transferencia;
- herramientas disponibles;
- límites de llamada;
- reglas de grabación;
- mensajes obligatorios.

---

# 6. Requisitos no funcionales

## RNF-001 Latencia

Objetivo de diseño inicial:

| Métrica | Objetivo inicial | Gate de producción |
|---|---:|---:|
| Edge ingress processing | p95 < 20 ms | obligatorio medir |
| Relay overhead propio por dirección | p95 < 30 ms | obligatorio medir |
| Tool routing overhead interno | p95 < 25 ms sin contar backend | obligatorio medir |
| Barge-in → cancelación local | p95 < 100 ms | objetivo crítico |
| Fin de turno → primer audio IA | p50 < 700 ms | objetivo |
| Fin de turno → primer audio IA | p95 < 1.2 s | objetivo |
| Errores internos en llamada | < 0.5 % | objetivo inicial |

**Importante:** estas cifras son SLO de ingeniería iniciales, no garantías de proveedores. Deben recalibrarse con mediciones reales.

## RNF-002 Concurrencia

Fases de carga:

- L0: 1 llamada
- L1: 10 simultáneas
- L2: 50 simultáneas
- L3: 100 simultáneas
- L4: 500 simultáneas
- L5: 1.000+ simultáneas

No avanzar a L(n+1) si en L(n):

- p95 de latencia degrada > 20 %;
- errores > 1 %;
- aparecen leaks o colas crecientes;
- el coste por llamada cambia de forma inesperada.

## RNF-003 Disponibilidad

Diseñar hacia `99.9%` o superior para el control plane, sin afirmar SLO contractual hasta que se mida el sistema completo.

## RNF-004 Aislamiento

Un error en una llamada no debe afectar a otra.

## RNF-005 Idempotencia

Webhooks y finalización de llamada deben soportar reintentos.

## RNF-006 Seguridad

- secretos fuera del repositorio;
- API keys por entorno;
- mínimo privilegio;
- validación de webhooks;
- allowlist de herramientas;
- sanitización de entradas a sistemas legacy;
- rate limiting de endpoints públicos;
- logs sin secretos.

## RNF-007 Privacidad

Antes de almacenar transcripciones o grabaciones debe existir política explícita de retención, acceso y eliminación. Cualquier requisito regulatorio aplicable debe validarse legalmente antes de producción.

## RNF-008 Observabilidad

Toda llamada debe ser trazable usando un `correlation_id`/`call_id` coherente.

---

# 7. Presupuesto de latencia

La latencia conversacional debe modelarse como presupuesto.

```text
T_total =
  T_telco_in
+ T_ingress
+ T_transport_to_model
+ T_turn_detection
+ T_model_first_audio
+ T_transport_back
+ T_telco_playout
```

Para tool calling:

```text
T_tool_turn =
  T_model_tool_decision
+ T_tool_gateway
+ T_backend
+ T_model_resume
```

## 7.1 Regla de optimización

Nunca optimizar `T_backend` suponiendo que es el cuello de botella. Instrumentar cada término de forma independiente.

## 7.2 Timestamps mínimos por turno

Capturar, cuando sea técnicamente posible:

- `audio_in_first_chunk_at`
- `speech_started_at`
- `speech_stopped_at`
- `model_response_created_at`
- `model_first_audio_at`
- `audio_out_first_chunk_at`
- `playback_mark_at`
- `barge_in_detected_at`
- `response_cancelled_at`
- `tool_call_started_at`
- `tool_call_completed_at`

---

# 8. Diseño del Media Plane — Arquitectura A

## 8.1 Flujo Twilio → Cloudflare

Twilio Bidirectional Media Streams entrega audio por WebSocket.

Referencia de implementación esperada:

- `<Connect><Stream>`
- WebSocket seguro `wss://`
- eventos `connected`, `start`, `media`, `dtmf`, `stop`, `mark`

Para Twilio Media Streams, el payload hacia/desde Twilio utiliza `audio/x-mulaw` a `8000 Hz` codificado en Base64.

## 8.2 Codec strategy

OpenAI Realtime soporta formatos telefónicos G.711/PCMU y PCMA además de PCM según configuración.

**Objetivo:** si ambos extremos admiten PCMU, probar una ruta **sin transcodificación**.

```text
Twilio PCMU 8 kHz
   │
   │ relay / envelope conversion only
   ▼
Realtime audio/pcmu
```

### Hipótesis a validar

La eliminación de resampling/transcoding reducirá:

- CPU;
- copias de memoria;
- latencia;
- artefactos de audio.

Debe demostrarse con benchmark A/B frente a PCM 24 kHz.

## 8.3 Buffers

Principios:

- chunks pequeños;
- evitar concatenaciones repetidas;
- no decodificar Base64 si el receptor puede aceptar el payload en formato compatible;
- límite máximo de cola;
- política `drop/cancel stale audio` antes que acumular segundos de retraso.

## 8.4 Barge-in

Ante detección de speech del usuario mientras existe audio IA en reproducción:

```text
1. mark interruption timestamp
2. cancel current model response
3. clear provider playback buffer
4. invalidate pending outbound chunks
5. resume listening
```

En Twilio, utilizar el mecanismo `clear` para vaciar audio buffered y `mark` para conocer estado de reproducción.

---

# 9. Diseño Direct SIP — Arquitectura B

OpenAI Realtime permite sesiones mediante SIP y expone eventos de llamada entrante.

Flujo conceptual:

```text
1. PSTN llama al número
2. proveedor enruta mediante SIP
3. OpenAI recibe INVITE
4. webhook realtime.call.incoming → Cloudflare
5. Cloudflare aplica política
6. aceptar/rechazar llamada
7. sesión realtime gestiona audio
8. herramientas/control siguen integradas con backend
9. transferencia mediante SIP REFER cuando proceda
```

## 9.1 Requisito crítico

El webhook de control **no debe convertirse en proxy del audio**.

## 9.2 Transferencia

La API realtime permite referir una llamada SIP a otro destino. Esto se utilizará para evaluar handoff nativo a operador humano.

## 9.3 Benchmark obligatorio

Comparar Direct SIP vs Media Bridge con:

- misma ubicación del caller si es posible;
- mismo guion de prueba;
- mismo modelo;
- misma voz;
- mismas herramientas;
- mínimo 100 turnos por variante antes de sacar conclusiones serias.

---

# 10. Call Session State Machine

```text
                ┌─────────┐
                │ CREATED │
                └────┬────┘
                     ▼
                ┌─────────┐
                │ RINGING │
                └────┬────┘
                     ▼
                ┌─────────┐
                │ ACTIVE  │
                └──┬───┬──┘
                   │   │
        ┌──────────┘   └──────────┐
        ▼                         ▼
   ┌─────────┐               ┌───────────┐
   │ HANDOFF │               │ COMPLETED │
   └────┬────┘               └───────────┘
        ▼
   ┌───────────┐
   │ COMPLETED │
   └───────────┘

Any state ───────────────► FAILED
```

## 10.1 Estados internos adicionales

Durante `ACTIVE`:

- `LISTENING`
- `THINKING`
- `SPEAKING`
- `TOOL_WAIT`
- `INTERRUPTED`

Estos estados pueden ser derivados, no necesariamente persistidos en cada evento.

---

# 11. Interfaces de dominio

## 11.1 TelephonyProvider

```ts
interface TelephonyProvider {
  acceptCall(input: AcceptCallInput): Promise<void>;
  rejectCall(input: RejectCallInput): Promise<void>;
  transferCall(input: TransferCallInput): Promise<void>;
  hangupCall(input: HangupCallInput): Promise<void>;
}
```

## 11.2 RealtimeModelProvider

```ts
interface RealtimeModelProvider {
  createSession(input: CreateRealtimeSessionInput): Promise<RealtimeSession>;
  cancelResponse(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}
```

## 11.3 ToolExecutor

```ts
interface ToolExecutor {
  execute(call: ToolCall, ctx: CallContext): Promise<ToolResult>;
}
```

## 11.4 CallRepository

```ts
interface CallRepository {
  create(call: CallRecord): Promise<void>;
  transition(callId: string, next: CallStatus): Promise<void>;
  appendEvent(event: CallEvent): Promise<void>;
  finish(callId: string, result: CallResult): Promise<void>;
}
```

---

# 12. Tool Gateway

No permitir que el modelo acceda arbitrariamente a APIs internas.

Arquitectura:

```text
Realtime Model
     │
     ▼
Tool Gateway
  ├── schema validation
  ├── authz
  ├── timeout
  ├── retry policy
  ├── idempotency
  ├── audit
  └── adapters
       ├── CRM
       ├── Orders
       ├── Tickets
       └── MCP
```

## 12.1 Tipos de herramientas

### READ

Sin efectos secundarios:

- buscar cliente;
- consultar pedido;
- consultar reserva.

### WRITE LOW-RISK

- crear ticket;
- enviar SMS informativo.

### WRITE HIGH-RISK

- cancelar pedido;
- cambiar datos críticos;
- realizar pagos;
- emitir reembolsos.

Las operaciones high-risk deben requerir política adicional y, cuando corresponda, confirmación explícita o intervención humana.

## 12.2 Timeout budget

Cada herramienta debe declarar:

```ts
{
  timeoutMs: number,
  retryable: boolean,
  idempotent: boolean,
  risk: "read" | "low" | "high"
}
```

Una herramienta lenta no debe bloquear indefinidamente la conversación. La IA debe poder decir al usuario que está consultando información o pasar a estrategia alternativa.

---

# 13. Prompt / Voice Policy

La personalidad conversacional se tratará como configuración versionada.

Debe definir:

- identidad de la empresa;
- idioma por defecto;
- tono;
- longitud máxima recomendada de respuestas habladas;
- cuándo hacer preguntas;
- cuándo usar una herramienta;
- qué información no inventar;
- reglas de identificación del cliente;
- condiciones de transferencia;
- manejo de silencio;
- manejo de ruido;
- manejo de insultos/abuso;
- manejo de emergencias según dominio;
- cierre de llamada.

## 13.1 Regla de latencia conversacional

Las respuestas de voz deben ser concisas. Un agente telefónico que genera párrafos largos aumenta tiempo de llamada y empeora la percepción aunque el primer token sea rápido.

---

# 14. Observabilidad

## 14.1 Log estructurado mínimo

```json
{
  "ts": "...",
  "level": "info",
  "call_id": "...",
  "session_id": "...",
  "event": "model.first_audio",
  "duration_ms": 483,
  "architecture_mode": "media_bridge",
  "provider": "twilio",
  "model_provider": "openai"
}
```

## 14.2 Métricas principales

### Telefonía

- llamadas entrantes;
- llamadas aceptadas;
- llamadas rechazadas;
- llamadas fallidas;
- duración;
- transferencias.

### Conversación

- turns/call;
- interruptions/call;
- silence time;
- first-audio latency;
- VAD latency;
- cancellation latency.

### Herramientas

- calls/tool;
- success rate;
- timeout rate;
- p50/p95/p99 latency.

### Infraestructura

- active sessions;
- websocket errors;
- reconnects;
- memory/session;
- CPU/event duration cuando esté disponible.

### Costes

- telecom cost/call;
- model cost/call;
- model cost/minute;
- tool cost/call;
- total cost/resolved call.

---

# 15. SLO y KPI de producto

No confundir métricas técnicas con éxito de negocio.

## Técnicos

- first audio latency;
- interruption latency;
- call setup success;
- tool success;
- error rate;
- availability.

## Negocio

- containment rate: % resuelto sin humano;
- transfer rate;
- first-call resolution;
- average handling time;
- abandonment rate;
- cost per resolved call;
- customer satisfaction cuando exista medición válida.

---

# 16. Seguridad

## 16.1 Secretos

Nunca commitear:

- `OPENAI_API_KEY`
- credenciales Twilio;
- tokens CRM;
- credenciales MCP privadas;
- secretos de webhook.

Usar secretos del entorno/despliegue.

## 16.2 Webhooks

- verificar autenticidad/firma según proveedor;
- timestamps y protección frente a replay cuando exista soporte;
- idempotency keys;
- no confiar en caller-provided metadata.

## 16.3 Tool security

El modelo nunca decide permisos. El gateway decide si la acción está permitida.

## 16.4 PII

No incluir datos personales innecesarios en logs técnicos.

## 16.5 Prompt injection por voz

Tratar las instrucciones del usuario como datos no privilegiados. La conversación no puede modificar políticas de sistema, permisos o secretos.

---

# 17. Gestión de fallos

## 17.1 Modelo realtime no disponible

Estrategias posibles:

1. reintento únicamente antes de comenzar conversación;
2. fallback a segundo proveedor/modelo;
3. transferir a humano;
4. mensaje IVR de contingencia.

No intentar reconexiones largas mientras el cliente escucha silencio.

## 17.2 Tool timeout

La llamada continúa. El agente debe responder sin inventar el resultado.

## 17.3 WebSocket cerrado

Registrar causa y evitar duplicar sesiones al reconectar.

## 17.4 Persistencia caída

El media plane no debería detener una conversación activa solo porque falle telemetría no crítica. Distinguir escrituras críticas y best-effort.

## 17.5 Telefonía degradada

Health monitoring independiente del modelo.

---

# 18. Estructura inicial del repositorio

```text
IA_RealTime_CenterCall/
├── README.md
├── docs/
│   ├── MASTER_PROJECT_GUIDE.md
│   ├── adr/
│   ├── benchmarks/
│   └── runbooks/
├── apps/
│   ├── edge-gateway/
│   └── admin-web/                 # futuro
├── packages/
│   ├── domain/
│   ├── telephony/
│   │   └── twilio/
│   ├── realtime/
│   │   └── openai/
│   ├── tools/
│   ├── observability/
│   └── test-fixtures/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   ├── e2e/
│   └── load/
├── scripts/
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```

La estructura podrá simplificarse para el MVP, pero el dominio debe permanecer separado de adaptadores externos.

---

# 19. Entornos

## local

- mocks de telefonía;
- replay de eventos;
- modelo real opcional;
- sin números públicos obligatorios.

## dev

- Worker desplegado;
- número de prueba;
- APIs sandbox/test cuando existan;
- logs verbosos.

## staging

- configuración equivalente a producción;
- números de test dedicados;
- load tests controlados;
- datos sintéticos.

## production

- secretos independientes;
- mínimo logging sensible;
- alertas;
- límites y presupuestos.

---

# 20. Estrategia de pruebas

## 20.1 Unit tests

Cubrir:

- state machine;
- codecs/envelopes;
- parsers de eventos;
- tool policy;
- retry/idempotencia;
- métricas.

## 20.2 Contract tests

Fixtures de eventos reales anonimizados de:

- Twilio;
- OpenAI Realtime;
- webhooks.

Evitar depender exclusivamente de mocks escritos a mano.

## 20.3 Integration tests

- Worker ↔ Durable Object;
- Worker ↔ OpenAI;
- Worker ↔ Twilio test flow;
- Tool Gateway ↔ backend sandbox.

## 20.4 End-to-end

Llamada telefónica real:

1. marcar número;
2. recibir saludo;
3. hacer pregunta;
4. interrumpir IA;
5. invocar tool;
6. obtener respuesta;
7. transferir o finalizar;
8. verificar registros.

## 20.5 Load tests

Nunca comenzar por 1.000 llamadas. Escalar por gates L0-L5.

## 20.6 Soak tests

Mantener tráfico prolongado para detectar:

- memory leaks;
- sesiones huérfanas;
- acumulación de buffers;
- aumento de p99;
- coste inesperado.

---

# 21. Banco de pruebas de latencia

Crear un harness capaz de reproducir audio conocido.

Dataset mínimo:

- voz limpia;
- voz rápida;
- voz lenta;
- ruido de calle;
- manos libres;
- interrupciones;
- números de pedido;
- nombres propios;
- silencio prolongado;
- DTMF.

Para cada test guardar:

```text
run_id
commit_sha
architecture_mode
telephony_provider
model
voice
vad_config
region
codec
concurrency
p50
p95
p99
errors
notes
```

Sin `commit_sha` y configuración, el benchmark no es reproducible.

---

# 22. Roadmap por fases

## FASE 0 — Base del repositorio

- [ ] Inicializar TypeScript
- [ ] Configurar lint/format/test
- [ ] Configurar Wrangler
- [ ] Crear README
- [ ] Crear estructura mínima
- [ ] Crear CI básica
- [ ] Definir variables de entorno

**Gate F0:** build + tests vacíos + deploy hello-world correctos.

---

## FASE 1 — Telefonía mínima

Objetivo: recibir llamada sin IA.

- [ ] Comprar/configurar número de prueba
- [ ] Endpoint inbound
- [ ] Validación webhook
- [ ] Respuesta TwiML
- [ ] Log `call_id`
- [ ] Finalización limpia

**Gate F1:** 20 llamadas consecutivas sin fallo de setup.

---

## FASE 2 — Media Stream loopback

Objetivo: validar WebSocket y audio.

- [ ] `<Connect><Stream>`
- [ ] aceptar WS
- [ ] parsear `connected/start/media/stop`
- [ ] contar chunks
- [ ] loopback/audio de prueba
- [ ] `mark/clear`
- [ ] medir jitter

**Gate F2:** llamada bidireccional estable 10 minutos sin crecimiento de buffer.

---

## FASE 3 — OpenAI Realtime básico

Objetivo: primera conversación IA real.

- [ ] crear sesión realtime
- [ ] configurar `audio/pcmu` si el test lo valida
- [ ] relay inbound
- [ ] relay outbound
- [ ] saludo
- [ ] cierre coordinado
- [ ] métricas first-audio

**Gate F3:** 20 conversaciones reales completas, sin herramientas.

---

## FASE 4 — Barge-in

- [ ] detectar speech durante salida
- [ ] cancelar respuesta del modelo
- [ ] limpiar playback buffer
- [ ] descartar chunks stale
- [ ] instrumentar cancel latency

**Gate F4:** p95 interrupción dentro del SLO definido en pruebas controladas.

---

## FASE 5 — Tool Gateway

- [ ] schema validation
- [ ] primera tool READ
- [ ] timeout
- [ ] auditoría
- [ ] resultado al modelo
- [ ] tool failure handling

**Gate F5:** 100 llamadas de herramienta simuladas sin resultados inventados ante fallo.

---

## FASE 6 — Persistencia y post-call

- [ ] call records
- [ ] call events
- [ ] métricas
- [ ] transcripción opcional
- [ ] resumen post-call
- [ ] política de retención

**Gate F6:** cada llamada puede reconstruirse cronológicamente desde eventos persistidos.

---

## FASE 7 — Transferencia humana

- [ ] destino configurable
- [ ] trigger explícito
- [ ] handoff context
- [ ] transfer success/failure
- [ ] fallback

**Gate F7:** transferencia correcta en escenarios normal, ocupado y error.

---

## FASE 8 — Direct SIP experimental

- [ ] trunk SIP
- [ ] `realtime.call.incoming`
- [ ] accept/reject
- [ ] conversación
- [ ] control plane
- [ ] SIP REFER
- [ ] observabilidad comparable

**Gate F8:** benchmark A/B completo contra Media Bridge.

---

## FASE 9 — Concurrencia

- [ ] 10 llamadas
- [ ] 50 llamadas
- [ ] 100 llamadas
- [ ] 500 llamadas
- [ ] profiling
- [ ] coste

**Gate F9:** alcanzar objetivo acordado sin violar p95/error budget.

---

## FASE 10 — Hardening producción

- [ ] rate limits
- [ ] abuse controls
- [ ] secrets audit
- [ ] incident runbooks
- [ ] alertas
- [ ] chaos/failure tests
- [ ] backup/config restore
- [ ] retention/deletion procedures
- [ ] security review

**Gate F10:** checklist de producción firmado.

---

# 23. Definition of Done por feature

Una funcionalidad no está terminada hasta cumplir:

1. código implementado;
2. test unitario cuando proceda;
3. test integración cuando proceda;
4. logs/metrics;
5. manejo de error;
6. timeout definido;
7. documentación actualizada;
8. benchmark si afecta media plane;
9. secretos/config externalizados;
10. criterio de aceptación demostrado.

---

# 24. ADR / Decision Log

## ADR-001 — Speech-to-speech nativo

**Estado:** Accepted provisional  
**Decisión:** utilizar modelo realtime nativo audio-audio como ruta principal.  
**Razón:** minimizar etapas secuenciales y facilitar conversación/interruptions en tiempo real.  
**Revisión:** si calidad, coste o fiabilidad no cumplen SLO.

## ADR-002 — Cloudflare como control plane

**Estado:** Accepted  
**Decisión:** Cloudflare alojará el control plane inicial y, en arquitectura A, también el media bridge.  
**Razón:** edge runtime, WebSockets, estado mediante Durable Objects y capacidad de integrar herramientas.

## ADR-003 — Media Bridge vs Direct SIP

**Estado:** Open / Benchmark required  
**Decisión:** no escoger por intuición. Implementar benchmark equivalente.  
**Criterio:** latencia, fiabilidad, control, handoff, coste y complejidad.

## ADR-004 — Evitar transcodificación si es posible

**Estado:** Experiment required  
**Hipótesis:** PCMU end-to-end puede reducir overhead frente a transcoding a PCM.  
**Criterio:** calidad + p95 + CPU/memoria.

## ADR-005 — MCP no obligatorio en el camino crítico

**Estado:** Accepted  
**Decisión:** MCP se utilizará donde aporte interoperabilidad; una integración interna simple no se convertirá artificialmente en MCP si añade latencia/complejidad sin beneficio.

---

# 25. Registro de riesgos

| ID | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| R-001 | Latencia del modelo variable | Alto | medir p95/p99, fallback, respuestas concisas |
| R-002 | Tool backend lento | Alto | timeouts, cache cuando sea válido, circuit breaker |
| R-003 | Buffer de audio crece | Crítico | backpressure, clear/cancel, límites |
| R-004 | Conversaciones se solapan | Alto | VAD tuning + barge-in tests |
| R-005 | Hallucination empresarial | Crítico | tools como fuente de verdad, no inventar |
| R-006 | Acción sensible incorrecta | Crítico | policy gateway + confirmación/humano |
| R-007 | Vendor lock-in | Medio | interfaces/provider adapters |
| R-008 | Coste por minuto alto | Alto | medir coste/resolved-call, model routing |
| R-009 | PII en logs | Alto | redaction + logging policy |
| R-010 | Sesiones huérfanas | Medio | TTL/lifecycle/idempotent cleanup |
| R-011 | Webhook duplicado | Medio | idempotency |
| R-012 | Cambio de modelo altera comportamiento | Alto | pinning/evals/config versioning |

---

# 26. Cost model

No optimizar únicamente coste/minuto de IA.

Calcular:

```text
Cost_per_call =
  telecom
+ realtime_model
+ tools
+ storage
+ observability
+ infrastructure
```

Y el KPI relevante:

```text
Cost_per_resolved_call =
  total_cost / successfully_resolved_calls
```

Comparación humana correcta:

```text
Human_effective_cost_per_handled_minute =
  total_employer_cost /
  productive_call_minutes
```

No dividir simplemente salario entre todos los minutos contractuales si se busca una comparación operativa real; hay tiempos no productivos, disponibilidad, pausas y tareas post-llamada.

---

# 27. Convenciones de eventos

Formato recomendado:

```ts
type CallEvent = {
  id: string;
  callId: string;
  ts: string;
  type: string;
  source: "telephony" | "realtime" | "tool" | "system";
  data: Record<string, unknown>;
};
```

Eventos sugeridos:

- `call.created`
- `call.ringing`
- `call.accepted`
- `media.connected`
- `speech.started`
- `speech.stopped`
- `model.response.started`
- `model.audio.first_chunk`
- `model.response.cancelled`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `handoff.requested`
- `handoff.completed`
- `call.completed`
- `call.failed`

---

# 28. Configuración

Ejemplo conceptual, no commitear secretos:

```text
ENVIRONMENT=dev
ARCHITECTURE_MODE=media_bridge
TELEPHONY_PROVIDER=twilio
REALTIME_PROVIDER=openai
REALTIME_MODEL=<configurable>
REALTIME_VOICE=<configurable>
DEFAULT_LANGUAGE=es
CALL_MAX_DURATION_SECONDS=1800
TOOL_DEFAULT_TIMEOUT_MS=3000
LOG_LEVEL=info
```

Secretos:

```text
OPENAI_API_KEY
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
CRM_API_TOKEN
WEBHOOK_SECRET
```

---

# 29. Reglas de rendimiento de implementación

1. Evitar JSON parse/stringify adicionales en loops de media cuando no sean necesarios.
2. Evitar logging por cada chunk en producción; muestrear o agregar.
3. No escribir DB sincrónicamente por cada paquete de audio.
4. No ejecutar herramientas en serie si son independientes y la semántica permite paralelo.
5. No mantener buffers ilimitados.
6. No bloquear audio por telemetría.
7. No transcodificar por comodidad.
8. No usar retries agresivos sobre operaciones realtime obsoletas.
9. Cancelar respuestas antiguas tras barge-in.
10. Separar tareas post-call del cierre crítico de la llamada.

---

# 30. Dashboard futuro

No pertenece al MVP crítico, pero deberá mostrar:

- llamadas activas;
- estado por llamada;
- duración;
- intención;
- herramienta activa;
- latencia en vivo;
- transferencias;
- errores;
- coste estimado;
- histórico y búsqueda.

El dashboard nunca debe ser dependencia del media plane.

---

# 31. Runbooks mínimos antes de producción

Crear posteriormente:

- `docs/runbooks/openai-realtime-outage.md`
- `docs/runbooks/telephony-outage.md`
- `docs/runbooks/tool-backend-outage.md`
- `docs/runbooks/high-latency.md`
- `docs/runbooks/cost-spike.md`
- `docs/runbooks/security-incident.md`

---

# 32. Fuentes técnicas oficiales de referencia

Las APIs cambian. Antes de implementar una fase, verificar documentación oficial actual.

## OpenAI

- Realtime API: `https://platform.openai.com/docs/api-reference/realtime`
- Realtime calls / SIP control: `https://platform.openai.com/docs/api-reference/realtime-calls`
- Modelos realtime: `https://developers.openai.com/api/docs/models/`

Hechos arquitectónicos verificados en la fecha base:

- Realtime soporta interfaces de baja latencia mediante WebRTC, WebSocket y SIP.
- Realtime admite speech-to-speech nativo.
- Admite formatos telefónicos PCMU/PCMA además de PCM configurado.
- La configuración realtime ofrece VAD e interrupción automática.
- Las llamadas SIP permiten aceptar/rechazar, finalizar y transferir mediante REFER.

## Twilio

- Media Streams: `https://www.twilio.com/docs/voice/media-streams`
- WebSocket messages: `https://www.twilio.com/docs/voice/media-streams/websocket-messages`
- TwiML Stream: `https://www.twilio.com/docs/voice/twiml/stream`

Hechos verificados en la fecha base:

- Bidirectional Media Streams permite recibir audio de una llamada y enviar audio de vuelta.
- Se inicia mediante `<Connect><Stream>`.
- Twilio usa `audio/x-mulaw` 8 kHz Base64 para media outbound hacia la llamada en esta interfaz.
- `clear` permite vaciar audio pendiente y `mark` ayuda a conocer reproducción.

## Cloudflare

- Durable Objects WebSockets: `https://developers.cloudflare.com/durable-objects/best-practices/websockets/`
- Agents: `https://developers.cloudflare.com/agents/`

Hechos verificados en la fecha base:

- Workers y Durable Objects pueden actuar como endpoints WebSocket.
- Durable Objects son adecuados para sesiones WebSocket de larga duración y coordinación con estado.
- La WebSocket Hibernation API es útil para conexiones servidor inactivas, aunque el media path de una llamada activa no debe diseñarse suponiendo que estará inactivo.

---

# 33. Checklist de la próxima sesión de desarrollo

## Próximo objetivo: FASE 0

- [ ] Crear `package.json`
- [ ] Crear `tsconfig.json`
- [ ] Crear `wrangler.jsonc`
- [ ] Crear Worker mínimo
- [ ] Crear test runner
- [ ] Añadir lint/format
- [ ] Crear `.gitignore`
- [ ] Crear `.env.example` sin secretos
- [ ] Crear `README.md` enlazando este documento
- [ ] Ejecutar build
- [ ] Ejecutar tests
- [ ] Desplegar endpoint health en entorno dev

### Endpoint mínimo esperado

```text
GET /health
```

Respuesta:

```json
{
  "status": "ok",
  "service": "ia-realtime-centercall",
  "version": "dev"
}
```

### Gate F0

No comenzar telefonía hasta que:

- build sea reproducible;
- test command funcione;
- Worker pueda desplegarse;
- secrets estén fuera de Git;
- `/health` responda correctamente.

---

# 34. Próximas decisiones pendientes

- [ ] País/número telefónico inicial para pruebas
- [ ] Media Bridge primero vs Direct SIP primero
- [ ] Región telefónica/edge de prueba
- [ ] Modelo realtime inicial exacto
- [ ] Voz inicial
- [ ] Configuración VAD inicial
- [ ] Estrategia de grabación: deshabilitada por defecto hasta definir política
- [ ] Persistencia inicial: D1 sí/no en MVP temprano
- [ ] Primera herramienta empresarial real
- [ ] Número/destino para transferencia humana
- [ ] SLO final tras primeras mediciones

---

# 35. Regla de evolución del proyecto

El orden de prioridad es:

```text
CORRECTNESS
    ↓
UNA LLAMADA ESTABLE
    ↓
LATENCIA MEDIDA
    ↓
BARGE-IN NATURAL
    ↓
TOOLS FIABLES
    ↓
HANDOFF HUMANO
    ↓
OBSERVABILIDAD
    ↓
CONCURRENCIA
    ↓
COSTE
    ↓
HARDENING PRODUCCIÓN
```

No sacrificar estabilidad por demostrar concurrencia prematuramente.

---

# 36. Estado actual

**Proyecto:** inicializado conceptualmente.  
**Código:** todavía no implementado.  
**Documento maestro:** creado.  
**Fase activa siguiente:** FASE 0 — Base del repositorio.

**Próximo cambio recomendado:** implementar el esqueleto Cloudflare Worker + TypeScript + tests + `/health`, actualizar este documento con resultados reales y abrir el primer benchmark únicamente después de tener una base reproducible.
