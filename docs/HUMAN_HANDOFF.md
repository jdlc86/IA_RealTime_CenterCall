# Human handoff — Gemini Fast

> Estado: operativo con limitaciones conocidas  
> Última revisión: 2026-08-27

Human handoff es una capacidad de control del producto de llamadas. En Gemini Fast, el modelo aporta comprensión semántica del lenguaje natural y el kernel conserva la autoridad sobre identidad, tenant, configuración, efectos telefónicos, auditoría y lifecycle terminal.

## Principio central: semántica sin listas rígidas

La autorización **no debe implementar comprensión lingüística mediante catálogos de frases**.

No mantener reglas del tipo:

```text
sí | vale | de acuerdo | adelante | hazlo | ...
```

Gemini decide semánticamente si existe una de estas autoridades:

```text
EXPLICIT_REQUEST   — el caller pide hablar con una persona
CONFIRMED_OFFER    — el caller acepta una oferta previa de transferencia
```

Además debe aportar `caller_authority_evidence`: una cita del turno actual que fundamenta esa decisión.

El kernel no vuelve a interpretar el significado del español. Canoniza texto sólo para verificar grounding y exige que la evidencia declarada esté realmente contenida en el transcript capturado para ese tool call.

### Contrato real que llega a Gemini

`FAST_TRANSFER_TOOL` se define inicialmente en `apps/gemini-control-plane/src/telnyx/fast-human-handoff.ts` con los campos funcionales de transferencia. Ese objeto **no es todavía la declaración final enviada al modelo**.

En `apps/gemini-media-edge/src/fast-gemini31.mjs`, `buildFastGemini31Setup()` detecta `transfer_call` y amplía el schema con:

```text
authorization               required
caller_authority_evidence   required
```

También añade a la descripción que la autoridad es semántica y que Gemini no debe exigir frases exactas ni keyword matching.

Esta distinción es importante al auditar el contrato: leer sólo `FAST_TRANSFER_TOOL` del Worker produce la impresión errónea de que faltan esos campos.

## Corrección de carrera de transcript

La autorización asíncrona no debe leer un `callerTranscript` mutable después de haber encolado el tool call.

El runtime actual captura el transcript en el momento de procesar el frame Gemini:

```text
input transcription
  → snapshot del transcript para transfer_call
  → tool queda encolado
  → puede llegar turnComplete y limpiar el estado mutable
  → executeTransferTool usa el snapshot, no el valor ya limpiado
```

Existe una regresión específica donde `inputTranscription`, `transfer_call` y `turnComplete` coexisten en el mismo mensaje/ciclo. El objetivo es impedir que una confirmación válida se convierta artificialmente en una cadena de preguntas repetidas.

## Invariantes

- El número de destino procede exclusivamente de configuración de tenant y nunca se expone al modelo.
- La capability de transferencia y `humanHandoff.enabled=true` deben estar habilitadas; de lo contrario no se ofrece la tool.
- Un efecto no se ejecuta sólo porque Gemini lo solicite: se validan autoridad semántica grounded, tenant, llamada, capability y configuración.
- Cada handoff aceptado obtiene un `handoffId` estable antes de iniciar la transferencia.
- La persistencia de auditoría Fast es asíncrona/fail-open respecto a la latencia: no debe bloquear speech ni telephony.
- Una vez aceptado el handoff, la IA entra en lifecycle terminal y no vuelve a conversación normal.
- En `call.bridged`, el humano pasa a ser dueño de la conversación.
- En no-answer, busy, timeout o fallo, se registra el resultado y la necesidad de callback cuando corresponde.
- Caller input posterior al punto terminal no debe abrir un nuevo turno Gemini.

## Flujo Fast actual

```text
Caller expresa intención natural
        │
        ▼
Gemini decide semánticamente
        │
        ▼
transfer_call
  authorization
  caller_authority_evidence
  reason
  context_summary (opcional)
        │
        ▼
Fast Media Edge
  - usa snapshot del transcript
  - verifica grounding
        │
        ▼
Fast Worker / transfer authorize
  - tenant/call/capability/config
  - crea handoffId/audit
        │
        ▼
Gemini anuncia successMessage
        │ turnComplete
        ▼
Fast Worker / transfer start
        │
        ▼
Telnyx actions/transfer
```

## Configuración de tenant KV

Ejemplo documental:

```json
{
  "humanHandoff": {
    "enabled": true,
    "destination": {
      "type": "PHONE",
      "phone": "+34XXXXXXXXX",
      "label": "Recepción"
    },
    "transfer": {
      "mode": "BLIND",
      "answerTimeoutSeconds": 25
    },
    "failurePolicy": {
      "action": "TERMINATE_AND_CALLBACK",
      "message": "Ahora mismo no ha sido posible comunicarte con una persona del equipo. Hemos registrado tu solicitud para que puedan devolverte la llamada. Gracias."
    },
    "successMessage": "De acuerdo, te paso con una persona del equipo para que continúe contigo. Un momento, por favor."
  }
}
```

`+34XXXXXXXXX` es un placeholder de documentación y falla intencionadamente la validación E.164. Sustituirlo por el número real únicamente en la configuración operativa segura.

`answerTimeoutSeconds: 25` es un **ejemplo de configuración**, no una afirmación de que todos los tenants activos usen 25 segundos. Para diagnosticar una llamada concreta hay que consultar la configuración realmente cargada y los timestamps del handoff.

## Auditoría y callback

Cada handoff aceptado puede crear/actualizar una fila en:

```text
public.human_handoff_events
```

La auditoría contiene tenant, call id, caller, motivo, destino, timestamps, resultado de transferencia y estado de callback.

Estados de lifecycle utilizados por la implementación incluyen:

```text
REQUESTED
ANNOUNCING
DIALING
ANSWERED
TRANSFERRED
NO_ANSWER
BUSY
FAILED
CALLBACK_REQUIRED
TERMINATED
```

Estados de callback:

```text
PENDING
CONTACTED
RESOLVED
UNREACHABLE
CANCELLED
```

`callback_required=true` + `callback_status=PENDING` significa que el sistema **registró una necesidad operativa de devolución de llamada**. No significa por sí solo que exista un proceso automático que ya haya llamado al caller.

## Limitaciones conocidas — no declarar resueltas

### 1. Ringback audible para el caller

El control de transferencia actual no sintetiza de forma determinista un ringback local. El caller puede depender del early media que Telnyx/terminación hagan llegar.

Consecuencia posible:

```text
"Te paso con recepción"
→ transferencia realmente en curso
→ caller oye silencio en lugar de tuut... tuut...
```

Esto es un problema de UX/control de transferencia, no evidencia suficiente de fallo de Gemini/VAD/audio bridge.

### 2. TTS terminal después de no-answer/fallo

La implementación solicita un `speak` fijo en el source leg y cuelga al completar el lifecycle esperado, pero una llamada real mostró que el caller no oyó de forma fiable ese mensaje.

Por tanto, no documentar como garantía E2E que “Lucía habla exactamente un mensaje y después cuelga”. La garantía actual es más limitada:

- el sistema **intenta** iniciar el mensaje terminal configurado;
- el lifecycle de fallo queda auditado;
- la llamada termina;
- la audibilidad real del TTS requiere hardening/observabilidad adicional.

### 3. Prompt base con estados históricos

`fastHumanHandoffPrompt()` todavía contiene referencias a respuestas `OFFER_REQUIRED` y `CALLER_REJECTED` procedentes de la política anterior. La política semántica Fast actual devuelve fuentes/errores diferentes (`CALLER_AUTHORITY_REQUIRED`, `CALLER_AUTHORITY_EVIDENCE_MISMATCH`, etc.).

La declaración final de tool instruye correctamente a Gemini a no llamar cuando la autoridad sea ambigua, pero esta divergencia de prompt debe eliminarse en una corrección de control posterior para que exista un único contrato conceptual.

## Diagnóstico de una transferencia

Separar siempre estos hitos:

1. **intención/autoridad** — ¿Gemini emitió `transfer_call` con evidencia grounded?;
2. **aceptación** — ¿existe `HUMAN_HANDOFF_ACCEPTED` / `REQUESTED`?;
3. **inicio Telnyx** — ¿se ejecutó transfer y se registró `DIALING`?;
4. **target leg** — ¿existe target call control id / hangup cause / bridge?;
5. **audio de progreso** — ¿el caller oyó ringback/early media?;
6. **resultado** — `TRANSFERRED`, `NO_ANSWER`, `BUSY`, `FAILED`;
7. **mensaje terminal** — ¿fue solicitado, aceptado y realmente audible?;
8. **callback** — ¿sólo quedó `PENDING` o hubo ejecución posterior?

No inferir un hito a partir de otro. Por ejemplo, un target leg creado no demuestra ringback audible y un `call.speak.ended` no demuestra por sí solo que el caller escuchara el audio.