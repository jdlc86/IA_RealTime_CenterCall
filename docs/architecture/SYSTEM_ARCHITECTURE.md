# IA_RealTime_CenterCall — System Architecture

> **Arquitectura oficial v3.0**
> **Estado:** vigente
> **Última revisión:** 2026-08-29
> **Carácter:** normativo
> **ADR de runtime Gemini aplicable:** [`ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md`](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

Este documento describe la arquitectura estable del sistema completo. Cuando una ADR posterior define un mecanismo más específico para un runtime, prevalece esa ADR en su ámbito.

## 1. Principios

1. Media plane mínimo y explícito.
2. Cloudflare no transporta audio continuo.
3. OpenAI y Gemini son runtimes de voz independientes.
4. Dominio, persistencia y contratos se comparten sólo cuando son realmente neutrales al proveedor.
5. Multi-tenant desde la raíz: una llamada se vincula a un tenant desde contexto de routing confiable.
6. Configuración por negocio, no forks por cliente.
7. El modelo conversa e interpreta lenguaje natural; el kernel/sistema es autoridad de permisos, identidad, invariantes y efectos.
8. No se simula comprensión lingüística abierta mediante listas crecientes de frases.
9. Los sistemas empresariales son fuente de verdad para disponibilidad, reservas, citas, estados y escrituras.
10. GitHub es fuente de verdad de código y documentación; producción debe poder reconciliarse con un SHA publicado.
11. `IMPLEMENTADO`, `CI VERDE`, `DESPLEGADO` y `VALIDADO E2E` son estados distintos.
12. Una optimización o cambio de audio exige evidencia; problemas de control no justifican tocar VAD/codecs/resampling sin causalidad demostrada.

## 2. Productos realtime independientes

La decisión estructural vigente es ADR-003: dos productos ejecutables independientes.

```text
PRODUCTO OPENAI                         PRODUCTO GEMINI FAST

PSTN                                    PSTN
  ↕                                       ↕
Telnyx                                  Telnyx
  ↕ señalización / SIP                   ↕ webhook + media WSS
OpenAI Control Plane                    Gemini Fast Worker
  ↕                                      │ admission / tenant / tools / control
OpenAI Realtime                         │
                                          └──► Fast Media Edge (Cloud Run)
                                                   ↕
                                               Gemini Live
```

Aplicaciones del repositorio:

```text
OpenAI:
  apps/control-plane
  apps/media-edge

Gemini:
  apps/gemini-control-plane
  apps/gemini-media-edge
```

No se comparte estado efímero de conversación entre OpenAI y Gemini. No existe failover cross-provider a mitad de llamada.

## 3. Gemini Fast — topología operativa actual

La ruta Gemini que atiende llamadas configuradas para este producto es:

```text
                                  ┌───────────────────────────┐
                                  │ Gemini Fast Worker        │
Telnyx webhook ──────────────────►│ Cloudflare                │
                                  │                           │
                                  │ - firma Telnyx            │
                                  │ - tenant routing/KV       │
                                  │ - session configuration   │
                                  │ - admission/credentials   │
                                  │ - transfer/control        │
                                  │ - diagnostics ingest      │
                                  └────────────┬──────────────┘
                                               │ bootstrap / control
                                               │ no audio continuo
                                               ▼
Caller ─ PSTN ─ Telnyx media WSS ◄────► Fast Media Edge ◄────► Gemini Live
                                          Cloud Run
```

### Fast Worker

Responsabilidades:

- validar señalización/webhooks Telnyx;
- resolver `called_number → tenant_id`;
- cargar configuración y capabilities del tenant antes de iniciar sesión;
- construir admission y credenciales efímeras;
- suministrar la URL WSS del Media Edge;
- autorizar/ejecutar efectos de control que no deben residir en el audio hot path;
- gobernar transferencia humana y lifecycle Telnyx asociado;
- recibir/persistir diagnóstico bounded fuera del tramo crítico.

### Fast Media Edge

Responsabilidades por llamada:

- socket Telnyx media;
- socket Gemini Live;
- forwarding del audio caller → Gemini;
- única conversión necesaria de audio Gemini → Telnyx;
- VAD/turn-taking Gemini del Fast Path;
- barge-in/interruption y playback;
- parser de eventos Gemini 3.1 incluyendo múltiples parts por frame;
- tool execution realtime local cuando el contrato lo permite;
- captura de evidencia necesaria para tool authorization sin añadir hops al audio.

El Media Edge **no** decide tenant, números privados de transferencia ni permisos empresariales.

## 4. `0%` de tráfico general de Cloud Run no desactiva Gemini Fast

El workflow Fast despliega el Media Edge con una revisión etiquetada y `--no-traffic`:

```text
gemini-media-edge revision
  tag = fast-<sha>
  general service traffic = 0%
```

Después el Worker recibe:

```text
GEMINI_FAST_CANARY_EDGE_URL=wss://<tagged-revision>/telnyx/gemini
```

Las llamadas Fast usan **esa URL etiquetada directamente**. Por tanto:

```text
Cloud Run general traffic 0%
!=
Gemini Fast route inactive
```

Al diagnosticar una llamada, verificar el binding del Worker y la revisión etiquetada; no inferir el Media Edge efectivo únicamente desde `.status.traffic[].percent` del servicio.

## 5. Media plane

### OpenAI

OpenAI puede usar una topología SIP/directa propia de su producto.

### Gemini

Gemini Live requiere un Media Edge dedicado:

```text
Telnyx media WSS
      ↕
Fast Media Edge
      ↕
Gemini Live WSS
```

Cloudflare, Supabase, tenant resolver y sistemas empresariales quedan fuera del transporte continuo de audio.

Regla:

> Todo nuevo hop obligatorio entre audio Telnyx y Gemini, o entre Gemini y Telnyx, necesita justificación, benchmark y una decisión arquitectónica aplicable.

## 6. Audio y turn-taking Gemini Fast

Baseline actual del Fast Path:

- Gemini Live recibe audio inmediatamente después del bootstrap/setup, sin Google STT como gate obligatorio;
- VAD automático de Gemini es el owner de turn-taking conversacional baseline;
- `START_OF_ACTIVITY_INTERRUPTS` permite barge-in natural;
- Gemini produce audio nativo y el Media Edge transforma únicamente lo necesario para Telnyx;
- Google Speech/TTS y módulos híbridos históricos pueden seguir existiendo en el repositorio, pero **no son por ello parte del hot path Fast actual**.

ADR-004 supersede las decisiones antiguas que hacían obligatorios STT externo, semantic preselection, quarantine o control WSS/DO en cada turno Gemini.

## 7. Tools, comprensión semántica y efectos

Gemini function calling es la puerta normal a efectos externos en su runtime.

```text
caller lenguaje natural
        ↓
Gemini comprensión semántica
        ↓
tool call estructurado
        ↓
validación determinista
tenant + capability + schema + estado + invariantes
        ↓
efecto / dominio / sistema externo
        ↓
FunctionResponse
```

La división de autoridad es intencionada:

- **modelo:** intención abierta, lenguaje natural, formulación;
- **kernel:** identidad, permisos, capability, estado, grounding requerido, idempotencia y efectos.

No se deben ampliar regex/listas de expresiones para intentar reemplazar la comprensión del modelo.

Contrato mínimo obligatorio de una tool:

```text
name + closed schema
authority + effect + capability + evidence
allowed handler + trusted tenant/call context
+ idempotency + confirmation + domain invariants para mutaciones
```

El modelo propone; el kernel autoriza; el dominio valida; el backend ejecuta. El contrato es transversal y cada runtime lo adapta sin compartir wire, sockets ni estado efímero.

### Handoff humano

Para `transfer_call`, Gemini declara autoridad semántica y evidencia del caller. El runtime verifica que esa evidencia pertenezca al transcript capturado para el tool call. La política no interpreta de nuevo el significado de la frase mediante listas.

Ver [`../HUMAN_HANDOFF.md`](../HUMAN_HANDOFF.md).

## 8. Multi-tenant y configuración

Modelo conceptual:

```text
called_number
   ↓
TenantResolver / tenant routing KV
   ↓
tenant_id
   ├── tenant_config:<tenant>
   └── tenant_capabilities:<tenant>
```

La personalización vive en configuración y módulos, no en ramas específicas de cliente dentro del Core.

Una conversación específica del negocio no debe iniciarse antes de resolver el tenant de forma confiable.

La configuración puede contener, entre otros:

- identidad/nombre del negocio;
- instrucciones/persona;
- idioma/voz aplicables al runtime;
- capabilities/tools habilitadas;
- políticas de handoff;
- configuración operativa necesaria antes de la llamada.

Las capacidades transversales se expresan por tenant sin mezclarlas con el vertical. Entre ellas están seguridad, admission/identidad, voz/lifecycle, autorización de tools, handoff, tiempo autoritativo, diagnóstico/redacción y comunicación externa. WhatsApp mantiene dos flags distintos: `message.whatsapp.transactional` y `message.whatsapp.realtime_support`.

Las capacidades verticales —reservas, citas, disponibilidad, mesas y reglas sectoriales— pertenecen a los módulos del negocio. El vertical consume capacidades transversales; no las reimplementa.

No confundir configuración con estado empresarial transaccional.

## 9. Cloudflare y Supabase

### Cloudflare

Plano de routing/configuración/control de baja latencia:

- tenant routing;
- configuración/capabilities;
- admission;
- secretos/bindings operativos backend;
- Worker Gemini/OpenAI según producto;
- coordinación/control que no transporte audio continuo.

### Supabase

Persistencia empresarial y operativa duradera detrás de fronteras backend.

Además de tablas de negocio, el producto actual utiliza trazabilidad como:

```text
public.call_diagnostic_events
public.human_handoff_events
public.caller_security_events
```

La persistencia de diagnósticos/handoff Fast se diseña para no bloquear el audio hot path.

El sink Gemini de `call_diagnostic_events` reconstruye los eventos desde un schema cerrado y aplica una allowlist de metadatos técnicos antes de usar la credencial privilegiada de Supabase. La redacción del productor es defensa en profundidad, no la única barrera. La auditoría especializada `human_handoff_events` mantiene un contrato separado para los datos operativos estrictamente necesarios de la transferencia.

`callback_required=true` expresa una necesidad registrada; no demuestra que exista un ejecutor automático de callbacks.

## 10. Handoff humano y telefonía

El destino de transferencia pertenece a configuración segura del tenant; nunca al modelo.

Lifecycle conceptual:

```text
caller solicita/acepta handoff
  → runtime emite recibo opaco del turno
  → Gemini emite transfer_call con autoridad semántica
  → kernel autoriza
  → anuncio de handoff
  → Telnyx transfer
       ├── bridge → humano
       └── busy/no-answer/failure → auditoría + política terminal/callback
```

Limitaciones abiertas actuales:

- no existe ringback local determinista garantizado para el caller durante el intento;
- el TTS terminal tras fallo/no-answer existe como acción de control, pero su audibilidad E2E no se considera todavía garantizada.

Estas limitaciones pertenecen al control/UX de transferencia y no justifican tocar el audio Fast principal sin evidencia causal.

## 11. Seguridad

- secretos nunca en Git ni en documentación;
- tenant de llamada derivado de routing confiable, no del texto libre del caller/modelo;
- el modelo nunca decide permisos;
- tools/capabilities autorizadas por tenant;
- destino de handoff privado;
- credenciales efímeras/bearer/HMAC no se registran en diagnóstico;
- consultas y escrituras empresariales acotadas al tenant;
- backend privilegiado no se expone a apps cliente;
- datos sensibles/minimizados en logs;
- una evidencia acústica no se infiere de un evento de control distinto.
- señales semánticas de seguridad autenticadas e idempotentes;
- persistencia sideband cuando la invariante lo permita, sin transcript crudo;
- el estado neutral de caller security se comparte en Supabase mediante contrato, no reutilizando lifecycle, SDK, socket, endpoint, cola ni secreto del Worker OpenAI.

Gemini Fast posee físicamente su endpoint autenticado, adaptador Supabase y cola/DLQ de caller security. El Media Edge deriva el endpoint del mismo origen del Fast Worker. La ruta confirma una entrega durable a Queue antes de responder y usa Supabase directo sólo como fallback. La identidad HMAC usa una clave estable separada de la credencial Supabase; CI la contrasta con una huella histórica independiente para que una rotación o error no reinicie la reputación. El endpoint histórico puede coexistir durante la retirada del producto legado, pero no es dependencia de runtime, CI o despliegue Gemini.

La política, decisiones y backlog de seguridad se mantienen en [`../../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx`](../../Security/IA_RealTime_CenterCall_Guia_Viva_Seguridad.docx).

## 12. Observabilidad

Diagnóstico debe permitir separar al menos:

```text
Telnyx signaling
Telnyx media
Fast Worker
Fast Media Edge
Gemini Live
Tool/effect
Human handoff target leg
Persistence
```

Principios:

- métricas bounded;
- persistencia remota preferentemente fuera del tramo crítico;
- no audio ni secretos en diagnóstico por defecto;
- no guardar transcript crudo salvo decisión explícita y necesidad demostrada;
- aplicar una allowlist en el sink persistente, sin confiar únicamente en la redacción del productor;
- usar timestamps/IDs/causalidad para reconstruir carreras, no `sleep` como herramienta de ordering.

## 13. Desarrollo y despliegue

Fuente de verdad:

```text
GitHub SHA publicado
   ↓
CI aplicable
   ↓
deploy específico del producto
   ↓
verificación de servicio/bindings
   ↓
E2E cuando el cambio afecta comportamiento real
```

OpenAI y Gemini tienen pipelines distintos. El runbook genérico antiguo de `apps/control-plane` no describe por sí solo el despliegue Gemini Fast.

Para Gemini Fast, un deploy correcto debe distinguir:

1. imagen/revisión de Media Edge;
2. tag WSS de esa revisión;
3. binding `GEMINI_FAST_CANARY_EDGE_URL` del Worker;
4. health/readiness;
5. preflight/bootstrap/HMAC cuando el gate correspondiente sea válido;
6. llamada E2E cuando el cambio sea telefónico/acústico.

Ver [`../runbooks/Deployment.md`](../runbooks/Deployment.md).

## 14. Historial arquitectónico

Los diseños/reviews de Gemini Fase 2/3, planes cerrados y snapshots de relevo se retiraron del árbol vigente y permanecen disponibles en Git. ADR-002 se conserva porque explica el origen del Media Edge; ADR-004 declara qué partes quedaron superadas.

La mera existencia de un módulo histórico en código no significa que esté conectado al Fast Path.

## 15. Criterio para resolver contradicciones

En caso de conflicto:

```text
ADR posterior aplicable
  → DESIGN_RULES.md
  → este documento
  → PROJECT_STATUS.md
  → SESSION_HANDOFF.md
  → runbook específico
  → documento histórico
```

Y siempre contrastar estado remoto cuando la afirmación dependa de producción.
