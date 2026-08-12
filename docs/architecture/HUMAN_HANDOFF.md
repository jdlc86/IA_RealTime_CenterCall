# Human Handoff — capacidad transversal

> **Estado:** DECISIÓN ARQUITECTÓNICA / FASE FUTURA  
> **Fase de implementación:** F6 — Handoff humano  
> **Fecha:** 2026-08-12

## 1. Decisión

La transferencia de una llamada desde el asistente de IA hacia una persona es una **capacidad transversal del Core** y no una funcionalidad específica de `CLINIC` o `RESTAURANT`.

La plataforma debe permitir que cualquier tenant habilite, configure o deshabilite el handoff humano sin introducir condicionales específicos por cliente ni duplicar lógica por vertical.

F6 implementará esta capacidad. Hasta entonces queda documentada como contrato futuro y **no debe simularse una transferencia que todavía no existe**.

## 2. Principio de atención

El asistente es el primer nivel de atención, pero no debe convertirse en una barrera para acceder a una persona.

Modelo objetivo:

```text
IA resuelve lo automatizable
        ↓
App resuelve gestión administrativa/asíncrona
        ↓
Humano resuelve excepciones o solicitudes de atención personal
```

Estos caminos son complementarios. La existencia de la futura app no sustituye la posibilidad de solicitar atención humana.

## 3. Casos de activación

El sistema debe poder ofrecer handoff cuando, al menos:

- el usuario pide explícitamente hablar con una persona;
- el usuario prefiere hablar directamente con el negocio;
- una operación no puede completarse de forma segura por IA;
- una política del tenant requiere autorización/intervención humana;
- se producen fallos repetidos que impiden resolver la petición;
- el usuario manifiesta de forma clara que la resolución automática no le sirve.

Salvo una política explícita del negocio o una situación que requiera escalado inmediato, el asistente debe **ofrecer** la transferencia de manera natural antes de ejecutarla.

Ejemplo conceptual: `Si prefieres, puedo pasarte con una persona del restaurante.`

## 4. Contrato transversal previsto

Capacidad/tool conceptual:

```text
transfer_to_human
```

Debe pasar por las mismas fronteras de autorización y observabilidad que cualquier acción controlada de la plataforma. El modelo puede solicitar la acción, pero no decide por sí mismo permisos ni destinos.

Configuración conceptual por tenant:

```text
humanHandoff:
  enabled: true
  destination: <destino configurado por el tenant>
  businessHoursOnly: true
  fallback: take_message
```

Los nombres/campos definitivos se fijarán durante F6; este ejemplo no constituye todavía esquema KV normativo.

## 5. Separación de responsabilidades

### Core / CallOrchestrator

- detecta/recibe la solicitud de handoff;
- aplica políticas y autorización;
- selecciona el flujo de transferencia;
- mantiene estados y observabilidad.

### TenantConfiguration

- habilita/deshabilita handoff;
- define política y destino autorizado;
- puede definir comportamiento fuera de horario.

### TelephonyProvider

- implementa la operación concreta de transferencia para Telnyx u otro carrier;
- evita acoplar el Core a una API telefónica específica.

### Vertical de negocio

`CLINIC` y `RESTAURANT` pueden definir razones empresariales para recomendar escalado, pero no implementan el mecanismo telefónico de transferencia.

## 6. Estado de llamada objetivo

Se conserva el estado transversal ya previsto:

```text
ACTIVE → HANDOFF → COMPLETED / FAILED
```

La transferencia deberá contemplar como mínimo:

- inicio de handoff;
- aceptación/resultado del proveedor telefónico;
- destino no disponible;
- timeout/fallo;
- fallback definido por tenant;
- cierre correcto de la sesión IA cuando corresponda;
- correlación por `call_id` y auditoría sin exponer datos innecesarios.

## 7. Consentimiento comercial y handoff

Para altas de marketing realizadas por llamada entrante se adopta como política de diseño que el número receptor de promociones debe coincidir con el número llamante normalizado (`CALLER_ID_MATCH`) cuando ese sea el mecanismo de verificación utilizado.

El teléfono de contacto de una reserva y el teléfono autorizado para marketing son conceptos distintos.

```text
reservation_phone != necesariamente marketing_phone
marketing_phone = caller_phone para alta automática por voz
```

Si una persona llama desde A e intenta autorizar promociones para B, la IA **no activa marketing para B**.

Para una baja automática por voz, la IA puede actuar sobre el mismo número llamante cuando exista un consentimiento asociado. Si se solicita gestionar otro número, no debe modificarlo automáticamente mediante `CALLER_ID_MATCH`; debe ofrecer un mecanismo alternativo seguro, que podrá ser:

- gestión mediante la futura app/canal administrativo;
- transferencia a una persona cuando F6 esté implementada.

La verificación del canal y el consentimiento comercial permanecen separados: `CALLER_ID_MATCH` no equivale por sí mismo a consentimiento.

## 8. Experiencia conversacional

El flujo debe ser amable, breve y no burocrático.

Principios:

- no pedir datos que el sistema ya conoce de forma confiable;
- explicar de forma sencilla por qué una acción no puede realizarse automáticamente;
- ofrecer alternativas en lugar de terminar en un error técnico;
- no afirmar que se ha transferido una llamada hasta recibir confirmación real del proveedor;
- no prometer disponibilidad humana si el sistema no la conoce.

## 9. Fuera de alcance actual

Hasta iniciar F6 no se implementará todavía:

- `transfer_to_human` como tool activa;
- transferencia Telnyx real;
- ring groups/colas de agentes;
- horarios de agentes;
- fallback `take_message` definitivo;
- UI de configuración de destinos en la futura app.

Estos puntos no bloquean el desarrollo actual de `ReservationModule` ni del consentimiento comercial, pero ambos deben diseñarse sin asumir que la IA será siempre el único canal de resolución.

## 10. Criterios preliminares de F6

F6 no se considerará validada únicamente por disponer de código. Como mínimo requerirá evidencia E2E de:

1. solicitud explícita de humano;
2. autorización por tenant;
3. transferencia real mediante `TelephonyProvider`;
4. aislamiento entre tenants/destinos;
5. fallo de destino con fallback controlado;
6. cierre coherente de la sesión IA;
7. trazabilidad del handoff;
8. ausencia de falsa confirmación cuando la transferencia falle.
