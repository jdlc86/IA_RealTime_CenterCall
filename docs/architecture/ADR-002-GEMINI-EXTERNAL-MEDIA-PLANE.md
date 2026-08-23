# ADR-002 — Media plane externo para Gemini Live

> **Estado:** Propuesto — no habilita tráfico  
> **Fecha:** 2026-08-23  
> **Ámbito:** RealtimeProvider / Gemini Live / Telnyx Media Streaming

## Contexto

La arquitectura canónica establece dos reglas relevantes:

1. el media plane debe ser mínimo;
2. Cloudflare Control Plane no transporta audio continuo.

La integración OpenAI actual cumple ambas reglas mediante SIP directo entre Telnyx y OpenAI Realtime. Gemini Live, en cambio, no dispone en este diseño de un destino SIP directo equivalente. La topología registrada para Gemini es `GEMINI_MEDIA_BRIDGE`, lo que exige terminar el WebSocket de Telnyx Media Streaming, conectar Gemini Live y transformar audio/eventos entre ambos extremos.

Ese relay no puede añadirse silenciosamente al Worker actual: `SYSTEM_ARCHITECTURE.md` exige benchmark, justificación y ADR para cualquier cambio que introduzca transporte continuo de audio.

El repositorio ya contiene componentes de dominio/transporte para ese futuro bridge —ordenación Telnyx, conversión L16/PCM, playback, sesión Gemini y coordinador de entrada diferida— pero Gemini permanece registrado y deshabilitado para tráfico.

## Decisión propuesta

Si Gemini Live se habilita en el futuro, su audio usará un **media edge externo y dedicado**, separado del Cloudflare Control Plane:

```text
PSTN
  ↕
Telnyx
  ↕  WSS Media Streaming (L16/RTP, autenticado)
Gemini Media Edge
  ↕  WSS
Gemini Live

Cloudflare Control Plane
  └─ admission + routing + streaming_start/stop + estado/control
```

El término `externo` significa externo al Worker/Durable Object que implementa el Control Plane. Este ADR no selecciona todavía proveedor de hosting ni producto concreto para el media edge; esa selección queda bloqueada hasta disponer de benchmark reproducible.

### Responsabilidades del Control Plane

El Control Plane conserva exclusivamente:

- tenant binding y provider affinity;
- selección `OPENAI`/`GEMINI`;
- admission/readiness antes de cualquier efecto del proveedor;
- generación de bootstrap/configuración autorizada;
- comando Telnyx `streaming_start` hacia una URL `wss://` del media edge;
- token de autenticación efímero del stream o referencia segura equivalente;
- `streaming_stop` y control de lifecycle cuando corresponda;
- observabilidad de señalización y resultados, sin transportar frames de audio.

### Responsabilidades del Gemini Media Edge

El media edge será propietario, por llamada, de:

- WebSocket entrante de Telnyx;
- validación del token del stream y binding inequívoco a la llamada admitida;
- validación del `start.media_format` real antes de aceptar media;
- reordenación bounded por `media.chunk`; nunca por tiempo de llegada;
- WebSocket saliente a Gemini Live;
- `GeminiTelnyxDeferredInputCoordinator` o composición equivalente;
- VAD/STT/autorización semántica previa al commit de audio caller cuando aplique;
- resampling/framing de salida Gemini → Telnyx;
- `mark`/`clear` y evidencia de playback/interruption;
- cierre fail-closed de ambos sockets ante identidad, formato o protocolo inválido.

El media edge no será propietario de tenant selection, reglas empresariales, ToolGateway ni fallback de provider.

## Contrato de audio inicial

El comando Telnyx solicitado por Control Plane usa:

- `stream_track = inbound_track`;
- `stream_codec = L16`;
- `stream_bidirectional_mode = rtp`;
- `stream_bidirectional_codec = L16`;
- `stream_bidirectional_sampling_rate = 16000`;
- `stream_bidirectional_target_legs` explícito por routing;
- `stream_auth_token` obligatorio;
- `command_id` idempotente.

El media edge **no presupone** que la petición garantice el formato de ingreso. Debe validar el frame `start` recibido de Telnyx y fallar cerrado si no coincide con el contrato soportado (actualmente mono L16/16000 Hz) hasta que exista una conversión explícita y probada para otros formatos.

## Seguridad

- Gemini continúa fuera de `ENABLED_REALTIME_PROVIDERS` mientras este ADR no esté validado y las capabilities requeridas sigan incompletas.
- Admission se ejecuta antes de `streaming_start` y antes de crear conexiones Gemini.
- `stream_url` debe usar `wss://`.
- Todo stream debe autenticarse; no se acepta un WebSocket público basado sólo en conocimiento de URL.
- El token del stream no se escribe en logs, URLs ni metadata observable.
- El media edge debe verificar que la identidad Telnyx del frame `start` coincide con la sesión autorizada.
- No existe fallback Gemini → OpenAI dentro de una llamada ya fijada a Gemini.
- Límites de tamaño, reorder window y buffers son bounded y fallan cerrados.

## Benchmark obligatorio antes de aceptar este ADR

La plataforma/hosting del media edge sólo podrá seleccionarse tras comparar al menos dos candidatos con el mismo workload y región equivalente. La prueba debe medir:

1. latencia añadida p50/p95/p99 desde frame Telnyx recibido hasta write a Gemini;
2. latencia añadida p50/p95/p99 Gemini → write Telnyx;
3. jitter y comportamiento ante frames fuera de orden;
4. estabilidad de WebSocket en llamadas prolongadas;
5. consumo CPU/memoria por llamada y con concurrencia;
6. límite práctico de conexiones concurrentes;
7. comportamiento de backpressure y cierre ante peer lento;
8. tiempo de establecimiento de ambos WebSockets;
9. disponibilidad regional respecto a Telnyx y Gemini;
10. coste por minuto/conexión bajo carga representativa.

No se acepta una plataforma sólo porque soporte WebSockets nominalmente.

## Criterios de habilitación de Gemini

Además del benchmark/selección del media edge, Gemini no puede pasar a tráfico hasta demostrar simultáneamente:

1. todas las capabilities exigidas por `requireRealtimeProviderTrafficReadiness` están implementadas y probadas;
2. admission fail-closed ocurre antes de cualquier socket/comando externo;
3. `streaming_start` y autenticación del media edge funcionan E2E;
4. Telnyx `start.media_format` satisface el contrato o existe adaptación explícita;
5. caller audio no llega a Gemini antes de la autoridad VAD/STT/semántica definida;
6. audio Gemini retorna al caller con correlación de respuesta y playback verificable;
7. barge-in/interruption y `clear` están demostrados E2E;
8. cierre limpia stream Telnyx y socket Gemini sin sesión huérfana;
9. observabilidad permite atribuir errores a Telnyx, media edge o Gemini sin exponer secretos;
10. una llamada Gemini nunca cambia silenciosamente a OpenAI.

## Consecuencias

### Positivas

- mantiene el Control Plane fuera del audio continuo;
- conserva separación clara entre routing/policy y media;
- permite escalar el relay según conexiones y ancho de banda, no según webhooks;
- mantiene provider affinity y admission como autoridades previas;
- hace verificable el coste real de introducir un relay.

### Costes / limitaciones

- Gemini necesita un servicio desplegable adicional;
- añade un salto de red respecto al SIP directo de OpenAI;
- requiere lifecycle, backpressure, observabilidad y capacidad operativa propios;
- exige benchmark antes de seleccionar hosting;
- mientras esas condiciones no se cumplan, Gemini permanece traffic-disabled.

## Estado de implementación al proponer el ADR

Ya existen en el repositorio fronteras inertes para componer `GEMINI_MEDIA_BRIDGE`, coordinación diferida de caller input y control Telnyx `streaming_start/stop`. Ninguna de ellas habilita tráfico Gemini ni convierte Cloudflare en media relay.
