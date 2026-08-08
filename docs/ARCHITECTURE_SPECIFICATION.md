# IA_RealTime_CenterCall — ARCHITECTURE SPECIFICATION

> **Estado:** Especificación oficial — v1.4  
> **Fecha base:** 2026-08-08  
> **Repositorio:** `jdlc86/IA_RealTime_CenterCall`  
> **Rama base:** `main`  
> **Objetivo:** construir una centralita telefónica con IA de voz en tiempo real, ultra baja latencia, alta disponibilidad y capacidad de adaptación a múltiples tipos de negocio.

> **Carácter normativo:** este documento es la fuente de verdad de arquitectura, fases, gates y restricciones de implementación. Una decisión marcada como obligatoria solo puede cambiar mediante actualización explícita de esta especificación y su ADR correspondiente.

## Historial

| Versión | Fecha | Cambio |
|---|---|---|
| 1.0 | 2026-08-08 | Arquitectura oficial, FASE 0 voz E2E, independencia de proveedores y Twilio inicial. |
| 1.1 | 2026-08-08 | Fases de integración y ADR normalizados. |
| 1.2 | 2026-08-08 | Core agnóstico al negocio y clínica como primer vertical. |
| 1.3 | 2026-08-08 | Saneamiento: tenant de primera clase, `TenantConfiguration`/`BusinessProfile`, Module/Provider, `ToolGateway`/`ToolExecutor`, control mínimo en F0 y reordenación de fases. |
| 1.4 | 2026-08-08 | Resolución explícita `called_number → tenant_id`, personalización por negocio sin forks y gate multi-negocio clínica/restaurante. |

---

# 0. Reglas de uso

1. Ninguna fase termina sin superar su gate.
2. La latencia se mide con datos reproducibles; no por percepción.
3. El audio utiliza la ruta mínima posible.
4. Cloudflare no transporta audio en la arquitectura oficial.
5. El dominio no depende de SDKs ni tipos de proveedores.
6. Ninguna operación empresarial se confirma sin respuesta válida de su fuente de verdad.
7. Toda optimización debe registrar baseline y resultado.
8. Toda llamada y operación empresarial pertenece a un `tenant_id`.
9. Toda feature debe cumplir las Reglas Arquitectónicas No Negociables.
10. Este documento se actualiza junto con las decisiones de código.
11. El negocio se selecciona por routing/configuración, nunca mediante forks o ramas de código específicas por cliente.

Estados: `[ ]` no iniciado · `[~]` en curso · `[x]` validado · `[!]` bloqueado.

---

# 1. Visión de producto

La plataforma recibe llamadas de la red telefónica, conversa de forma natural mediante IA realtime, responde información autorizada del negocio, ejecuta operaciones empresariales mediante herramientas controladas y puede transferir la llamada a una persona.

El producto es **agnóstico al sector y multi-tenant**. Un mismo despliegue del Core debe poder atender simultáneamente números asociados a negocios distintos. Por ejemplo:

```text
Llamada a número A → tenant clínica → perfil/módulos/providers de clínica
Llamada a número B → tenant restaurante → perfil/módulos/providers de restaurante
```

La clínica es el primer vertical de validación, pero el Core debe poder reutilizarse para restaurante, hotel, taller, peluquería, comercio u otros negocios sin forks ni reescritura de telefonía/realtime.

Ejemplos de capacidades:

- información del negocio;
- citas;
- reservas;
- pedidos;
- transferencia a humano;
- herramientas futuras habilitadas por tenant.

La IA **conversa y solicita acciones**; los sistemas empresariales son la fuente de verdad.

---

# 2. Arquitectura oficial

```text
Cliente / PSTN
      │
      ▼
Número telefónico llamado
      │
      ▼
Proveedor telefónico / SIP
      │
      ├──── metadata/routing ───► TenantResolver
      │                              │
      │                              ▼
      │                           tenant_id
      │                              │
      │                              ▼
      │                      TenantConfiguration
      │
      │ SIP / RTP
      ▼
OpenAI Realtime
      │
      │ speech-to-speech · VAD · barge-in
      │
      └──── tool calls ────► Cloudflare Control Plane
                                  │
                                  ├── ToolGateway
                                  ├── TenantConfiguration
                                  ├── políticas / seguridad
                                  ├── providers empresariales
                                  ├── persistencia
                                  └── observabilidad
      │
      ▼
Cliente / PSTN
```

## 2.1 Media plane

Ruta oficial:

```text
PSTN → proveedor SIP → OpenAI Realtime → proveedor SIP → PSTN
```

Cloudflare, bases de datos, MCP, CRM, `TenantResolver` y ToolGateway quedan fuera del transporte de audio.

## 2.2 Control plane

Cloudflare alojará progresivamente:

- webhook/control de llamadas;
- `TenantResolver`;
- configuración por tenant;
- ToolGateway;
- autorización y políticas;
- providers/adaptadores;
- persistencia;
- observabilidad;
- administración futura.

## 2.3 Proveedores iniciales

- Telefonía: **Twilio**.
- IA realtime: **OpenAI Realtime**.
- Infraestructura/control: **Cloudflare**.

Son implementaciones iniciales, no dependencias del dominio.

---

# 3. Decisiones de Diseño Obligatorias

## DD-001 — Independencia de proveedores

Fronteras arquitectónicas:

- `TelephonyProvider`
- `RealtimeProvider`
- `ToolGateway`

Las particularidades de Twilio, OpenAI, MCP, CRM, agendas u otros proveedores se encapsulan en infraestructura/adaptadores.

**Regla:** sustituir un proveedor debe requerir principalmente un nuevo adaptador y configuración, no cambios en reglas del Core.

Las interfaces se materializan cuando existe su capacidad correspondiente. FASE 0 no necesita `ToolGateway`.

## DD-002 — Dominio / Infraestructura

El dominio contiene:

- lifecycle de llamada;
- contratos;
- políticas;
- reglas compartidas;
- estado lógico;
- semántica de errores.

Infraestructura contiene:

- SDKs;
- HTTP/SIP/webhooks;
- Workers;
- D1/R2;
- serialización de proveedor;
- credenciales;
- adaptadores.

**Dependencia permitida:** infraestructura → dominio.  
**Dependencia prohibida:** dominio → infraestructura.

## DD-003 — Audio Path Mínimo

No se añade un componente al media plane sin:

1. necesidad demostrada;
2. estimación de impacto;
3. benchmark antes/después;
4. ADR aprobado.

## DD-004 — ToolGateway obligatorio

El modelo no accede directamente a APIs empresariales.

```text
Modelo
  │
  ▼
ToolGateway
  ├── schema validation
  ├── policy / authorization
  ├── timeout
  ├── idempotency
  ├── audit
  └── ToolExecutor
        └── Provider / Adapter
              └── sistema externo
```

`ToolGateway` es la frontera pública para herramientas. `ToolExecutor` es un contrato interno para ejecutar una operación ya validada/autorizada.

## DD-005 — Twilio inicial, migrable

Twilio es el carrier inicial para reducir riesgo de FASE 0.

La migración futura a Telnyx u otro SIP carrier debe poder realizarse implementando otro `TelephonyProvider`.

## DD-006 — Core agnóstico al negocio

La clínica es un vertical, no el Core.

```text
TenantConfiguration
  ├── tenant_id
  ├── BusinessProfile
  ├── módulos habilitados
  ├── políticas / permisos
  ├── telefonía
  ├── realtime
  └── configuración de providers
```

`TenantConfiguration` y `BusinessProfile` no son sinónimos:

- `TenantConfiguration`: configuración operativa completa de un negocio.
- `BusinessProfile`: información descriptiva y relativamente estable comunicable al usuario.

Información relativamente estable:

- identidad;
- dirección;
- horarios publicados;
- servicios;
- políticas;
- FAQs.

Información dinámica u operacional:

- disponibilidad actual;
- citas;
- reservas;
- pedidos;
- precios dinámicos;
- estado de una operación.

Los datos dinámicos se consultan mediante `ToolGateway`.

### Módulos compartidos

- `BusinessInformationModule`
- `AppointmentModule`
- `ReservationModule`
- `OrderModule`
- `HumanHandoffModule`

`AppointmentModule` utiliza conceptos genéricos:

```text
service · resource · slot · customer · appointment
```

No contiene `doctor`, `patient` ni otros conceptos clínicos. Los conceptos sectoriales viven en un módulo vertical cuando realmente sean necesarios.

### Module / Provider

```text
AppointmentModule
      │
      ▼
ToolGateway
      │
      ▼
AppointmentProvider
      │
      └── agenda externa
```

El mismo patrón aplica a `ReservationProvider`, `OrderProvider`, etc.

## DD-007 — Tenant de primera clase

Cada llamada y operación empresarial pertenece a un `tenant_id`.

```text
CallSession
  ├── call_id
  ├── tenant_id
  ├── called_number
  ├── telephony_provider_call_id
  ├── realtime_session_id
  └── status
```

Reglas:

1. El tenant se resuelve en el borde de entrada.
2. El número telefónico llamado (`called_number`) es la clave primaria de resolución en el modelo inicial.
3. El mapping `called_number → tenant_id` pertenece a configuración/routing y no al Core de negocio.
4. Ninguna herramienta empresarial se ejecuta sin tenant.
5. No se comparten implícitamente datos, credenciales, prompts ni permisos entre tenants.
6. FASE 0 puede usar un tenant de desarrollo fijo.

## DD-008 — Personalización por negocio mediante configuración

Añadir o modificar un negocio no debe requerir una variante del programa.

El flujo normativo es:

```text
called_number
    ↓
TenantResolver
    ↓
tenant_id
    ↓
TenantConfiguration
    ├── BusinessProfile
    ├── prompt/persona/políticas
    ├── idioma/voz/configuración realtime
    ├── módulos habilitados
    ├── permisos de tools
    ├── providers empresariales
    └── destino de handoff
```

Ejemplo:

```text
+34 ... A
  → clinica_madrid
  → BusinessInformation + Appointment + HumanHandoff
  → AppointmentProvider = agenda clínica

+34 ... B
  → restaurante_centro
  → BusinessInformation + Reservation + Order + HumanHandoff
  → ReservationProvider = sistema de reservas
```

**Reglas:**

- no se permiten `if (tenant === "clinica_madrid")` ni equivalentes en el Core;
- un nuevo negocio se incorpora registrando routing, configuración, datos y módulos/providers existentes;
- si necesita una capacidad realmente nueva, se crea un módulo reusable con contrato genérico;
- no se despliega una copia diferente del Core por cada negocio salvo una decisión operacional futura documentada por ADR.

---

# 4. Reglas Arquitectónicas No Negociables

- **RA-001** — `domain` no importa SDKs externos.
- **RA-002** — toda integración externa tiene interfaz/provider/adaptador.
- **RA-003** — Cloudflare queda fuera del audio path.
- **RA-004** — toda herramienta empresarial pasa por `ToolGateway`.
- **RA-005** — no se amplía el media plane sin benchmark + ADR.
- **RA-006** — no se optimiza sin baseline.
- **RA-007** — ningún gate se cierra sin evidencia.
- **RA-008** — nuevas features preservan sustituibilidad de Twilio/OpenAI.
- **RA-009** — ningún secreto se almacena en Git.
- **RA-010** — el modelo nunca es autoridad de permisos.
- **RA-011** — el Core no contiene lógica específica de clínica/restaurante/etc.
- **RA-012** — el modelo no inventa disponibilidad ni confirma operaciones sin fuente de verdad.
- **RA-013** — toda sesión/operación empresarial tiene `tenant_id`.
- **RA-014** — módulos de negocio no dependen de SDKs/modelos de datos de sistemas externos.
- **RA-015** — el tenant se resuelve desde el routing de entrada; inicialmente `called_number → tenant_id`.
- **RA-016** — la personalización de un cliente/negocio se realiza mediante `TenantConfiguration`, módulos y providers; nunca mediante forks o condicionales específicos en el Core.

Una PR que viole una RA se considera defecto arquitectónico salvo ADR que modifique expresamente la especificación.

---

# 5. Requisitos funcionales

- **RF-001 Recepción:** aceptar llamadas de un número público.
- **RF-002 Sesión IA:** una sesión realtime independiente por llamada.
- **RF-003 Saludo:** saludo configurable por tenant.
- **RF-004 Conversación:** audio bidireccional natural.
- **RF-005 Barge-in:** el usuario puede interrumpir a la IA.
- **RF-006 Finalización:** cliente, IA, timeout, error o handoff.
- **RF-007 Tools:** invocación de herramientas autorizadas para el tenant.
- **RF-008 Handoff:** transferencia a destino SIP/telefónico configurado por tenant.
- **RF-009 Trazabilidad:** `call_id`, `tenant_id`, `called_number` y métricas correlacionadas.
- **RF-010 Business info:** responder información autorizada del negocio correspondiente al número llamado.
- **RF-011 Capacidades:** módulos habilitables por tenant.
- **RF-012 Confirmación:** una escritura externa se comunica como éxito solo tras confirmación.
- **RF-013 Tenant:** resolver `tenant_id` antes de lógica empresarial.
- **RF-014 Fuente:** distinguir información estable de datos dinámicos/fuente de verdad.
- **RF-015 Number routing:** resolver inicialmente el negocio mediante mapping `called_number → tenant_id`.
- **RF-016 Customización:** incorporar un negocio nuevo sin modificar ni redesplegar una variante específica del Core.

---

# 6. Requisitos no funcionales

## RNF-001 Latencia

Objetivos iniciales:

| Métrica | Objetivo |
|---|---:|
| Fin de turno → primer audio IA p50 | < 700 ms |
| Fin de turno → primer audio IA p95 | < 1.2 s |
| Barge-in | natural, sin cola larga |
| Setup | estable y reproducible |

Se recalibrarán con pruebas reales.

## RNF-002 Calidad

Audio inteligible, sin cortes frecuentes, eco anormal o degradación introducida por nuestra arquitectura.

## RNF-003 Aislamiento

- una llamada no comparte estado accidentalmente con otra;
- datos, herramientas, credenciales y configuración quedan aislados por `tenant_id`;
- un número nunca puede cargar accidentalmente la configuración de otro tenant.

## RNF-004 Seguridad

- secretos fuera de Git;
- mínimo privilegio;
- validación de webhooks;
- logs sin secretos;
- allowlist de tools;
- permisos/credenciales aislados por tenant;
- protección frente a prompt injection por voz;
- el modelo nunca decide permisos;
- el `tenant_id` no se acepta como dato confiable aportado libremente por el caller/modelo: se deriva de routing autenticado/configurado.

## RNF-005 Observabilidad

Toda llamada debe poder reconstruirse mediante eventos/timestamps cuando exista el control plane persistente.

## RNF-006 Customización operativa

Dar de alta un nuevo negocio que utilice capacidades existentes debe consistir principalmente en configuración/routing/datos y no en cambios de código del Core.

---

# 7. Presupuesto conceptual de latencia

```text
T_total =
  T_telco_in
+ T_sip_transport
+ T_turn_detection
+ T_model_first_audio
+ T_sip_transport_back
+ T_telco_playout
```

No existe `T_cloudflare_audio_relay` en la arquitectura oficial.

---

# 8. FASE 0 — Voz E2E

## 8.1 Objetivo

Responder únicamente:

> **¿Puedo llamar desde un teléfono real, ser atendido por la IA, conversar, interrumpirla y colgar correctamente?**

No se implementan todavía CRM, MCP, agenda, D1, dashboard, ToolGateway ni transferencia humana.

FASE 0 sí puede incluir **código mínimo de control** para recibir el evento de llamada, aceptar/configurar OpenAI Realtime, establecer prompt/voz/VAD y finalizar sesión. Ese código:

- pertenece al control plane;
- nunca transporta audio;
- no contiene lógica empresarial.

## 8.2 Ruta

```text
Teléfono
  ↓
Número Twilio de prueba
  ↓
SIP
  ↓
OpenAI Realtime
  ↓
Conversación
  ↓
Cuelgue
```

## 8.3 Checklist

### Telefonía
- [x] Twilio seleccionado.
- [ ] Crear/configurar cuenta.
- [ ] Obtener número de prueba.
- [ ] Verificar recepción.
- [ ] Configurar SIP/routing.
- [ ] Confirmar llegada del INVITE.

### Control mínimo
- [ ] Verificar mecanismo actual necesario para incoming call.
- [ ] Implementar webhook/endpoint mínimo si es necesario.
- [ ] Aceptar/configurar/finalizar sesión.
- [ ] Confirmar que Cloudflare no transporta audio.

### Realtime
- [ ] Credenciales fuera del repositorio.
- [ ] Modelo inicial.
- [ ] Voz inicial.
- [ ] Prompt español.
- [ ] VAD inicial.
- [ ] Audio inbound/outbound.

### Conversación
- [ ] Saludo.
- [ ] ≥10 turnos.
- [ ] Barge-in.
- [ ] Silencio 5–10 s.
- [ ] Despedida.
- [ ] Cuelgue limpio.
- [ ] Nueva llamada inmediata.

### Medición
- [ ] Latencia fin-de-frase → primer audio.
- [ ] Cortes/jitter.
- [ ] Fallos de setup.
- [ ] Duración.
- [ ] Modelo/voz/VAD usados.

## 8.4 Casos de prueba

- **F0-T01:** setup y saludo.
- **F0-T02:** conversación ≥5 preguntas.
- **F0-T03:** llamada ≥5 minutos.
- **F0-T04:** interrupción mientras habla la IA.
- **F0-T05:** silencio 5–10 s.
- **F0-T06:** cuelgue del cliente.
- **F0-T07:** 20 llamadas consecutivas.

## 8.5 Gate F0

PASS únicamente si:

1. llamada PSTN real entra;
2. IA atiende automáticamente;
3. audio funciona en ambos sentidos;
4. conversación multi-turno coherente;
5. barge-in razonable;
6. llamada de 5 minutos estable;
7. cuelgue limpia la sesión;
8. ≥19/20 llamadas completan setup/conversación básica;
9. baseline inicial de latencia documentado.

Hasta superar F0 no se inicia integración empresarial.

---

# 9. Fases de Integración

```text
F0 Voz E2E
  ↓
F1 Baseline técnico + observabilidad
  ↓
F2 Latencia + barge-in
  ↓
F3 ToolGateway
  ↓
F4 Primer vertical + prueba multi-negocio
  ↓
F5 Persistencia + post-call
  ↓
F6 Transferencia humana
  ↓
F7 Concurrencia
  ↓
F8 Hardening producción
```

Ninguna fase puede introducir un nuevo elemento en el media plane sin modificar DD-003 mediante ADR.

## FASE 1 — Baseline técnico y observabilidad

- [ ] estructura TypeScript/Cloudflare;
- [ ] `package.json`, `tsconfig`, Wrangler;
- [ ] `.gitignore`, `.env.example`;
- [ ] `/health`;
- [ ] CI;
- [ ] formalizar endpoint mínimo de F0;
- [ ] `CallSession`;
- [ ] `call_id`;
- [ ] `tenant_id` de desarrollo;
- [ ] `called_number` en contexto de llamada;
- [ ] `TenantResolver`;
- [ ] mapping `called_number → tenant_id`;
- [ ] lifecycle/timestamps/modelo/voz.

**Gate F1:** build/deploy reproducible, `/health` estable y toda llamada correlacionada con `call_id` + `called_number` + `tenant_id`.

## FASE 2 — Latencia y barge-in

- [ ] first-audio p50/p95/p99;
- [ ] tuning VAD;
- [ ] escenarios de silencio;
- [ ] validación repetida de barge-in;
- [ ] configuración ganadora documentada.

**Gate F2:** conversación estable dentro del SLO acordado.

## FASE 3 — ToolGateway

- [ ] frontera `ToolGateway`;
- [ ] contrato interno `ToolExecutor`;
- [ ] primera tool READ;
- [ ] schema validation;
- [ ] authorization;
- [ ] timeout;
- [ ] idempotencia;
- [ ] auditoría;
- [ ] manejo de error.

**Gate F3:** herramienta real/simulada funciona y ante fallo la IA no inventa resultado.

## FASE 4 — Primer vertical + validación multi-negocio

### Tenant A — clínica

- [ ] `TenantConfiguration`;
- [ ] `BusinessProfile`;
- [ ] `BusinessInformationModule`;
- [ ] `AppointmentModule` genérico;
- [ ] `AppointmentProvider`;
- [ ] conectar agenda real o sandbox;
- [ ] consultar disponibilidad;
- [ ] crear/consultar/reprogramar/cancelar cita;
- [ ] datos dinámicos desde fuente de verdad.

### Tenant B — restaurante de validación

No es necesario implementar todo el producto restaurante. Su objetivo es demostrar que la customización funciona.

- [ ] segundo número/routing de prueba;
- [ ] segundo `tenant_id`;
- [ ] `BusinessProfile` diferente;
- [ ] saludo/prompt/políticas diferentes;
- [ ] módulos distintos (al menos `BusinessInformationModule`; `ReservationModule` si está disponible);
- [ ] confirmar que no se modifica el Core para darlo de alta.

### Prueba obligatoria

```text
Llamar número A → la IA se identifica y opera como clínica.
Llamar número B → la misma plataforma se identifica y opera como restaurante.
```

**Gate F4:** ambos números resuelven tenants distintos y cargan correctamente perfil, prompt/políticas, módulos y providers sin fork, condicional específico por cliente ni variante del Core. La clínica además gestiona citas mediante ToolGateway/fuente de verdad.

## FASE 5 — Persistencia y post-call

- [ ] registros con `call_id` + `tenant_id` + `called_number`;
- [ ] eventos;
- [ ] métricas;
- [ ] transcripción opcional;
- [ ] resumen post-call;
- [ ] retención;
- [ ] aislamiento cross-tenant.

**Gate F5:** llamada reconstruible cronológicamente y datos aislados por tenant.

## FASE 6 — Handoff humano

- [ ] destino por tenant;
- [ ] trigger explícito;
- [ ] transferencia SIP;
- [ ] contexto;
- [ ] éxito/fallo;
- [ ] fallback.

**Gate F6:** transferencia normal/error preservando tenant y contexto.

## FASE 7 — Concurrencia

Escalado: 10 → 50 → 100 → 500 → 1.000+.

No avanzar si:

- p95 degrada >20%;
- error rate >1%;
- aparecen sesiones huérfanas;
- el coste se desvía inesperadamente.

**Gate F7:** concurrencia objetivo sin violar SLO, aislamiento o presupuesto.

## FASE 8 — Hardening

- rate limits;
- auditoría de secretos;
- alertas;
- runbooks;
- pruebas de fallo;
- retención/eliminación;
- revisión de seguridad;
- contingencia telefonía/modelo.

**Gate F8:** riesgos críticos mitigados y runbooks principales validados.

---

# 10. Estado de llamada

```text
CREATED → RINGING → ACTIVE ──► COMPLETED
                       └─────► HANDOFF → COMPLETED
Any state ───────────────────► FAILED
```

Cada instancia pertenece a una `CallSession(call_id, tenant_id, called_number, ...)`.

Estados derivados durante ACTIVE:

`LISTENING · THINKING · SPEAKING · TOOL_WAIT · INTERRUPTED`

---

# 11. ToolGateway y herramientas

Cada herramienta declara:

```ts
{
  timeoutMs: number,
  retryable: boolean,
  idempotent: boolean,
  risk: "read" | "low" | "high"
}
```

Categorías:

- READ;
- WRITE LOW-RISK;
- WRITE HIGH-RISK.

Las operaciones high-risk requieren política adicional.

Integraciones:

```text
AppointmentModule → ToolGateway → AppointmentProvider → agenda
ReservationModule → ToolGateway → ReservationProvider → reservas
OrderModule       → ToolGateway → OrderProvider       → pedidos
```

Toda ejecución recibe `tenant_id`; la selección de provider/credenciales/configuración se realiza desde `TenantConfiguration`, no desde decisiones libres del modelo.

---

# 12. Observabilidad

Por llamada:

- `call_id`;
- `tenant_id`;
- `called_number`;
- proveedor;
- modelo/voz/VAD;
- setup;
- duración;
- first-audio;
- turnos;
- interrupciones;
- errores;
- tool latency/result;
- transferencia;
- coste estimado.

Métricas: p50/p95/p99 y coste por llamada resuelta.

---

# 13. Estrategia de pruebas

## Unit
Estado, políticas, parsers, idempotencia, módulos y `TenantResolver`.

## Integration
Control plane ↔ OpenAI; control plane ↔ telefonía; routing ↔ tenant; ToolGateway ↔ providers.

## E2E
Siempre debe existir prueba con llamada telefónica real.

## Multi-negocio
Debe existir prueba E2E con al menos dos números/tenants con configuraciones distintas y el mismo Core.

## Cross-tenant
Pruebas explícitas que intenten acceder a datos/configuración de otro tenant y deban fallar.

## Load
Carga gradual, no masiva desde el inicio.

## Soak
Sesiones huérfanas, degradación p99, leaks y costes anómalos.

---

# 14. Definition of Done

Una feature requiere:

1. implementación;
2. prueba;
3. manejo de error;
4. timeout cuando aplique;
5. métricas/logs;
6. secretos externalizados;
7. documentación;
8. criterio de aceptación demostrado;
9. cumplimiento de RA aplicables;
10. aislamiento por tenant cuando toque datos/configuración empresarial;
11. ausencia de lógica específica por cliente en el Core cuando la capacidad sea configurable.

---

# 15. ADR / Decision Log

Plantilla: **Estado · Problema · Decisión · Motivación · Consecuencias · Alternativas descartadas**.

## ADR-001 — Speech-to-speech nativo
**Accepted.** Realtime audio-audio como ruta principal inicial; pipeline STT→LLM→TTS queda fuera del camino principal salvo revisión futura.

## ADR-002 — Direct SIP
**Accepted.** SIP conecta telefonía con OpenAI Realtime; no se construye media bridge Cloudflare paralelo.

## ADR-003 — Cloudflare Control Plane
**Accepted.** Cloudflare aloja control/herramientas/datos/observabilidad, no audio.

## ADR-004 — MCP fuera del audio path
**Accepted.** MCP solo donde aporte interoperabilidad y siempre detrás de ToolGateway.

## ADR-005 — FASE 0 voz E2E
**Accepted.** Validar primero llamada real antes de capas empresariales.

## ADR-006 — Independencia de proveedores
**Accepted.** TelephonyProvider, RealtimeProvider y ToolGateway/adaptadores preservan sustituibilidad.

## ADR-007 — Twilio inicial
**Accepted.** Twilio prioriza madurez; migración futura queda habilitada por diseño.

## ADR-008 — Core agnóstico al negocio
**Accepted.** Clínica es vertical inicial; el Core permanece sector-agnostic.

## ADR-009 — Tenant + Module/Provider
**Accepted.** `tenant_id` es contexto de primera clase; `TenantConfiguration` contiene `BusinessProfile`; módulos acceden a sistemas externos mediante providers/adaptadores.

## ADR-010 — Número llamado como resolución inicial de tenant
**Accepted.** El `called_number` se resuelve en el borde mediante `TenantResolver` y mapping configurado hacia `tenant_id`. La personalización se carga desde `TenantConfiguration`; no se crean forks ni condicionales por cliente en el Core. La resolución podrá evolucionar a rutas SIP/DIDs/aliases más complejos sin cambiar el contrato `TenantResolver`.

---

# 16. Riesgos

| ID | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| R-001 | Latencia variable | Alto | p50/p95/p99 |
| R-002 | Routing SIP | Crítico F0 | E2E primero |
| R-003 | Barge-in deficiente | Alto | tuning + tests |
| R-004 | Calidad telefónica | Alto | llamadas reales |
| R-005 | Backend lento | Alto | timeout/circuit breaker |
| R-006 | Hallucination empresarial | Crítico | fuente de verdad |
| R-007 | Acción sensible incorrecta | Crítico | policy gateway |
| R-008 | Coste/min alto | Alto | coste/resolved-call |
| R-009 | PII en logs | Alto | redaction |
| R-010 | Sesiones huérfanas | Alto | lifecycle/cleanup |
| R-011 | Vendor lock-in | Medio | providers/adapters |
| R-012 | Core acoplado a clínica | Alto | RA-011 |
| R-013 | Business info desactualizada | Alto | ownership/fuente autorizada |
| R-014 | IA inventa disponibilidad | Crítico | RA-012 |
| R-015 | Fuga entre tenants | Crítico | RA-013 + cross-tenant tests |
| R-016 | Módulo acoplado a agenda | Alto | RA-014 |
| R-017 | Número resuelve tenant incorrecto | Crítico | `TenantResolver`, mapping validado y tests E2E |
| R-018 | Customización deriva en forks por cliente | Alto | RA-016 + gate multi-negocio |

---

# 17. Modelo de coste

```text
Cost_per_call =
  telecom
+ realtime_model
+ tools
+ storage
+ observability
+ infrastructure
```

KPI principal:

```text
Cost_per_resolved_call =
  total_cost / successfully_resolved_calls
```

---

# 18. Estructura prevista

```text
IA_RealTime_CenterCall/
├── docs/
│   ├── ARCHITECTURE_SPECIFICATION.md
│   ├── adr/
│   ├── benchmarks/
│   └── runbooks/
├── apps/
│   ├── control-plane/
│   └── admin-web/
├── packages/
│   ├── domain/
│   ├── telephony/
│   ├── realtime/
│   ├── tools/
│   ├── tenant/
│   │   ├── tenant-resolver/
│   │   └── tenant-configuration/
│   ├── business-profile/
│   ├── modules/
│   │   ├── business-information/
│   │   ├── appointments/
│   │   ├── reservations/
│   │   └── orders/
│   ├── business-providers/
│   └── observability/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── load/
├── scripts/
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```

---

# 19. Configuración conceptual

```text
ENVIRONMENT=dev
TELEPHONY_PROVIDER=twilio
REALTIME_PROVIDER=openai
REALTIME_MODEL=<configurable>
REALTIME_VOICE=<configurable>
DEFAULT_LANGUAGE=es
DEFAULT_TENANT_ID=<dev-tenant-only>
TENANT_CONFIG_SOURCE=<configurable>
TENANT_ROUTING_SOURCE=<configurable>
CALL_MAX_DURATION_SECONDS=1800
LOG_LEVEL=info
```

En entornos multi-negocio, `DEFAULT_TENANT_ID` no sustituye la resolución por routing; queda limitado a desarrollo/pruebas controladas.

Secretos fuera de Git.

---

# 20. Próximo trabajo — solo FASE 0

```text
1. crear/configurar Twilio
2. obtener número de prueba
3. configurar SIP
4. verificar mecanismo actual de incoming call en OpenAI Realtime
5. implementar control mínimo si es necesario
6. conectar SIP ↔ Realtime
7. llamar
8. conversar / interrumpir / colgar
9. repetir 20 veces
10. medir baseline
11. cerrar Gate F0
```

No comenzar todavía D1, MCP, CRM, dashboard, handoff ni load testing.

La resolución multi-negocio se formaliza en F1 y se valida E2E con dos negocios en F4; no debe inflar FASE 0.

---

# 21. Estado actual

**Arquitectura:** Direct SIP → OpenAI Realtime + Cloudflare Control Plane.  
**Telefonía inicial:** Twilio detrás de `TelephonyProvider`.  
**Producto:** Core multi-tenant y agnóstico al negocio; número/routing selecciona `tenant_id` y configuración.  
**FASE activa:** FASE 0.  
**Código permitido en F0:** control mínimo de llamada; ningún relay de audio ni lógica empresarial.  
**Gate inmediato:** llamada real, conversación bidireccional estable, barge-in y cierre correcto.
