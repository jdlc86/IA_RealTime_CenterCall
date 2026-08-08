# IA_RealTime_CenterCall — ARCHITECTURE SPECIFICATION

> **Estado:** Especificación de arquitectura oficial — v1.0  
> **Fecha base:** 2026-08-08  
> **Repositorio:** `jdlc86/IA_RealTime_CenterCall`  
> **Rama base:** `main`  
> **Objetivo:** Diseñar y construir una centralita telefónica con IA de voz en tiempo real, alto rendimiento, alta disponibilidad y latencia conversacional mínima.

> **Carácter normativo:** Este documento constituye la **especificación oficial de arquitectura** del proyecto. Las decisiones de diseño, restricciones, fases, gates y criterios de aceptación definidos aquí son obligatorios para la implementación salvo modificación explícita y versionada de esta especificación.

## Historial de versiones

| Versión | Fecha | Cambio |
|---|---|---|
| 1.0 | 2026-08-08 | Consolidación de arquitectura oficial, FASE 0 de voz E2E, independencia de proveedores, reglas no negociables y Twilio como proveedor inicial. |

---

# 0. Cómo usar este documento

Este archivo es la **fuente de verdad técnica del proyecto**. Toda decisión relevante de arquitectura, requisito, métrica, prueba, dependencia externa y criterio de aceptación debe quedar registrada aquí.

Reglas:

1. Ninguna fase termina sin superar su gate de aceptación.
2. Las decisiones arquitectónicas importantes se registran como ADR.
3. La latencia se mide; no se estima por percepción subjetiva.
4. El camino crítico de audio debe tener el mínimo número posible de saltos.
5. Se prioriza primero una llamada impecable; después herramientas; después concurrencia y escalado.
6. No añadir infraestructura al media path salvo necesidad demostrada.
7. Toda optimización relevante debe registrar medida antes/después.
8. Este documento se actualiza junto con el código.
9. Ninguna implementación puede violar una regla arquitectónica no negociable sin modificar previamente esta especificación mediante una decisión explícita.
10. Las dependencias de proveedores externos deben permanecer fuera del dominio.

Estados:

- `[ ]` No iniciado
- `[~]` En curso
- `[x]` Completado y validado
- `[!]` Bloqueado

---

# 1. Visión del producto

Construir una centralita telefónica inteligente capaz de:

- recibir llamadas desde la red telefónica pública;
- responder automáticamente con una IA de voz;
- mantener conversación natural en español;
- operar con latencia conversacional mínima;
- permitir interrupciones naturales (*barge-in*);
- utilizar herramientas empresariales cuando sea necesario;
- transferir a un agente humano;
- registrar métricas y trazabilidad;
- escalar posteriormente a múltiples llamadas simultáneas.

El producto no se considera inicialmente una suite completa de contact center. El núcleo es el **motor de llamada IA realtime**.

---

# 2. Arquitectura oficial

## 2.1 Decisión

La arquitectura oficial del proyecto es:

```text
Cliente / PSTN
      │
      ▼
Número telefónico / proveedor SIP
      │
      │ SIP / RTP
      ▼
OpenAI Realtime
      │
      │ speech-to-speech nativo
      │ VAD / barge-in / conversación
      │
      ├──────────► Tool calling / MCP
      │                 │
      │                 ▼
      │           Cloudflare Control Plane
      │             ├── Worker
      │             ├── autenticación
      │             ├── herramientas
      │             ├── CRM / ERP
      │             ├── persistencia
      │             ├── auditoría
      │             └── observabilidad
      │
      ▼
Cliente / PSTN
```

## 2.2 Principio fundamental

**Cloudflare NO transportará el audio de la llamada en la arquitectura principal.**

El audio debe viajar por la ruta más directa posible entre telefonía/SIP y OpenAI Realtime.

Cloudflare se utiliza como **control plane**, no como media bridge.

## 2.3 Motivo

La prioridad del proyecto es ultra baja latencia. Añadir un relay WebSocket propio para el audio implicaría:

- un salto adicional de red;
- más buffering;
- más copias de memoria;
- más posibilidades de jitter;
- más complejidad operacional;
- más superficie de fallo.

No desarrollaremos dos arquitecturas en paralelo.

---

# 3. Decisiones de Diseño Obligatorias

Estas decisiones no son recomendaciones. Son restricciones de diseño que deben guiar la implementación y la revisión de código.

## DD-001 — Independencia de proveedores

**Decisión:** el núcleo del sistema no dependerá directamente de proveedores concretos de telefonía, IA realtime ni sistemas empresariales.

**Motivación:** precios, capacidades, disponibilidad, regulación y calidad de los proveedores pueden cambiar. La plataforma debe poder migrar de proveedor sin reescribir la lógica de negocio.

**Interfaces arquitectónicas obligatorias:**

- `TelephonyProvider`: contrato del núcleo para capacidades telefónicas necesarias por la aplicación. La implementación inicial utilizará Twilio, pero el dominio no conocerá Twilio.
- `RealtimeProvider`: contrato del núcleo para conversación realtime. La implementación inicial utilizará OpenAI Realtime, pero el dominio no conocerá el SDK ni tipos específicos de OpenAI.
- `ToolGateway`: única frontera autorizada entre el modelo y sistemas empresariales como CRM, ERP, pedidos, facturación o servidores MCP.

**Reglas de implementación:**

1. `domain` no importará SDKs, tipos ni clientes de Twilio, OpenAI, Cloudflare ni futuros proveedores.
2. Las particularidades de un proveedor se traducen dentro de su adaptador.
3. Los contratos del núcleo expresan capacidades del sistema, no nombres ni estructuras del proveedor.
4. Sustituir un proveedor debe requerir principalmente un nuevo adaptador y configuración, no cambios en reglas de negocio.
5. Una Pull Request que introduzca dependencia directa del dominio hacia un proveedor se considera defecto arquitectónico salvo ADR explícito que modifique esta decisión.

## DD-002 — Separación Dominio / Infraestructura

**Decisión:** el sistema separará explícitamente lógica de dominio e infraestructura.

**Dominio:**

- lifecycle y estado lógico de llamada;
- políticas;
- contratos de telefonía/realtime/herramientas;
- reglas de negocio;
- decisiones de handoff;
- semántica de errores del sistema.

**Infraestructura:**

- SDKs de proveedores;
- HTTP/SIP/webhooks;
- Cloudflare Workers;
- D1/R2;
- credenciales;
- serialización específica;
- adaptadores Twilio/OpenAI/MCP/CRM.

**Regla:** la infraestructura puede depender del dominio; el dominio no puede depender de infraestructura.

## DD-003 — Audio Path Mínimo

**Decisión:** el media plane debe contener únicamente los elementos imprescindibles para transportar y procesar audio.

La ruta objetivo es:

```text
PSTN / teléfono
      │
      ▼
Proveedor telefónico / SIP
      │
      ▼
OpenAI Realtime
      │
      ▼
PSTN / teléfono
```

Cloudflare, bases de datos, MCP, CRM, observabilidad y Tool Gateway no forman parte del transporte de audio.

Cualquier propuesta para introducir un componente nuevo en esta ruta requiere:

1. necesidad funcional demostrada;
2. estimación del impacto;
3. benchmark antes/después;
4. ADR aprobado.

## DD-004 — Tool Gateway obligatorio

**Decisión:** el modelo no accederá directamente a sistemas empresariales.

Toda herramienta de negocio deberá atravesar `ToolGateway`, que será responsable de:

- validación de esquema;
- autenticación y autorización;
- allowlist;
- timeouts;
- idempotencia;
- clasificación de riesgo;
- auditoría;
- normalización de errores;
- adaptación a CRM/ERP/MCP u otros sistemas.

El modelo puede decidir **solicitar** una herramienta. El sistema decide si puede ejecutarse.

## DD-005 — Proveedor telefónico inicial

**Decisión:** Twilio es el proveedor telefónico inicial seleccionado para desarrollo y FASE 0.

**Motivación:** priorizar madurez, documentación, soporte de telefonía/SIP y reducción del riesgo de integración durante el arranque.

**Implicación:** Twilio es una elección de implementación inicial, no una dependencia del dominio.

**Objetivo de portabilidad:** debe ser posible migrar posteriormente a Telnyx u otro carrier SIP competitivo implementando otro `TelephonyProvider` y cambiando configuración, sin reescribir el núcleo.

---

# 4. Reglas Arquitectónicas No Negociables

- **RA-001 — Dominio libre de SDKs externos.** `domain` no puede importar Twilio, OpenAI, Cloudflare, MCP SDKs ni clientes de proveedores.
- **RA-002 — Adaptador obligatorio.** Toda integración externa debe quedar detrás de una interfaz/puerto del núcleo.
- **RA-003 — Cloudflare fuera del audio path.** Cloudflare no transporta audio en la arquitectura oficial.
- **RA-004 — Tool Gateway único.** Ninguna API empresarial se expone directamente al modelo.
- **RA-005 — Audio path mínimo.** No se añade ningún salto al media plane sin benchmark y ADR.
- **RA-006 — Métricas antes que optimización.** No se aceptan optimizaciones de rendimiento sin baseline reproducible.
- **RA-007 — Gate obligatorio.** Una fase no puede cerrarse sin demostrar sus criterios de aceptación.
- **RA-008 — Sustitución de proveedor preservada.** Nuevas features no pueden acoplar el dominio a Twilio u OpenAI.
- **RA-009 — Secretos fuera del código.** Ningún secreto o credencial se almacena en Git.
- **RA-010 — Permisos fuera del modelo.** El modelo nunca es autoridad de autorización para una acción empresarial.

Las RA se revisan en cada Pull Request que afecte arquitectura, proveedores, media plane o herramientas.

---

# 5. Principios arquitectónicos

## P1. El audio manda

Todo componente no imprescindible queda fuera del camino crítico de voz.

## P2. Speech-to-speech nativo

La conversación principal utiliza un modelo realtime audio-audio. No se impondrá un pipeline secuencial obligatorio:

`STT → LLM → TTS`

## P3. Una llamada = una sesión aislada

Cada llamada mantiene su propio identificador, contexto, estado, métricas y lifecycle.

## P4. Media plane y control plane separados

**Media plane:** telefonía + audio realtime.  
**Control plane:** configuración, políticas, herramientas, persistencia, observabilidad, seguridad y administración.

## P5. Proveedor telefónico encapsulado

El número/SIP debe poder cambiar sin reescribir lógica de negocio.

## P6. Cancelación prioritaria

Cuando el usuario interrumpe a la IA, la generación obsoleta debe cancelarse rápidamente.

## P7. Métricas por percentiles

Se utilizarán p50, p95 y p99.

## P8. No optimizar antes de medir

Toda afirmación de rendimiento debe estar respaldada por pruebas reproducibles.

---

# 6. Stack inicial

## 6.1 Telefonía

Proveedor telefónico con capacidad de:

- número público;
- recepción de llamadas;
- trunk o routing SIP;
- encaminamiento hacia OpenAI Realtime.

**Proveedor inicial seleccionado: Twilio.**

Twilio se utilizará para FASE 0 y las primeras integraciones por madurez y reducción del riesgo técnico. Su uso deberá permanecer encapsulado detrás de `TelephonyProvider` para permitir migración futura a Telnyx u otro carrier SIP sin modificar el dominio.

## 6.2 Modelo de voz

- OpenAI Realtime API;
- speech-to-speech nativo;
- SIP para llamadas telefónicas;
- VAD;
- barge-in;
- tool calling;
- voz y modelo configurables.

## 6.3 Cloudflare

Cloudflare alojará progresivamente:

- control API;
- webhooks;
- Tool Gateway;
- autenticación/autorización;
- estado empresarial cuando sea necesario;
- integración MCP;
- observabilidad;
- panel de administración futuro.

## 6.4 Datos

Cuando se incorporen:

- D1 u otra SQL para metadatos transaccionales;
- R2 para objetos grandes si se almacenan grabaciones;
- sistema de métricas/analytics para telemetría.

No guardar audio crudo en SQL.

---

# 7. Requisitos funcionales globales

## RF-001 Recepción de llamada

Aceptar una llamada entrante a un número público configurado.

## RF-002 Sesión IA

Cada llamada debe iniciar una sesión realtime independiente.

## RF-003 Saludo

La IA debe poder emitir un saludo inicial configurable.

## RF-004 Conversación bidireccional

Cliente e IA deben mantener diálogo natural de voz en ambos sentidos.

## RF-005 Barge-in

El usuario debe poder interrumpir a la IA sin esperar a que termine de hablar.

## RF-006 Fin de llamada

La llamada debe poder finalizar limpiamente por:

- cuelgue del cliente;
- acción de la IA;
- timeout;
- error controlado;
- futura transferencia a humano.

## RF-007 Tool calling

La IA podrá invocar herramientas aprobadas en fases posteriores.

## RF-008 Transferencia humana

El sistema podrá transferir una llamada activa a un destino telefónico/SIP.

## RF-009 Trazabilidad

Cada llamada tendrá un `call_id` y métricas correlacionadas.

---

# 8. Requisitos no funcionales

## RNF-001 Latencia

Objetivos iniciales de ingeniería:

| Métrica | Objetivo inicial |
|---|---:|
| Fin de turno → primer audio IA p50 | < 700 ms |
| Fin de turno → primer audio IA p95 | < 1.2 s |
| Barge-in perceptible | natural, sin cola larga de audio |
| Setup de llamada | estable y reproducible |

Estos valores se recalibrarán con pruebas reales.

## RNF-002 Calidad de audio

La conversación debe ser inteligible, sin cortes frecuentes, eco anormal ni degradaciones introducidas por nuestra arquitectura.

## RNF-003 Aislamiento

Una llamada no debe compartir estado accidentalmente con otra.

## RNF-004 Seguridad

- secretos fuera de Git;
- mínimo privilegio;
- webhooks validados;
- logs sin secretos;
- herramientas bajo allowlist.

## RNF-005 Observabilidad

Toda llamada debe poder reconstruirse mediante eventos y timestamps cuando el control plane esté incorporado.

---

# 9. Presupuesto conceptual de latencia

```text
T_total =
  T_telco_in
+ T_sip_transport
+ T_turn_detection
+ T_model_first_audio
+ T_sip_transport_back
+ T_telco_playout
```

En la arquitectura oficial no existe un `T_cloudflare_audio_relay` porque Cloudflare queda fuera del media path.

---

# 10. FASE 0 — PRUEBA END-TO-END DEL CANAL DE AUDIO

## 10.1 Propósito

Esta fase existe exclusivamente para demostrar el **camino completo de audio real**.

No se desarrollará todavía una centralita empresarial. No habrá CRM, MCP, base de datos, dashboard, herramientas ni transferencia humana.

La pregunta que FASE 0 debe responder es únicamente:

> **¿Puedo llamar desde un teléfono real a un número, ser atendido por OpenAI Realtime, mantener una conversación natural y colgar correctamente?**

Si la respuesta no es demostrablemente sí, el proyecto no avanza.

---

## 10.2 Alcance exacto

```text
Teléfono del usuario
      │
      ▼
Número telefónico de prueba
      │
      ▼
Proveedor SIP
      │
      ▼
OpenAI Realtime
      │
      ▼
Conversación de voz
      │
      ▼
Cuelgue / fin de sesión
```

### Incluido

- adquirir/configurar número de prueba;
- configurar routing SIP;
- conectar llamada con OpenAI Realtime;
- configurar modelo realtime;
- configurar voz;
- configurar idioma español;
- definir prompt mínimo;
- recibir saludo de la IA;
- hablar con la IA;
- escuchar respuestas;
- mantener varios turnos;
- probar interrupción básica;
- colgar desde el teléfono;
- comprobar cierre de la llamada;
- medir manual/técnicamente la latencia inicial.

### Excluido explícitamente

- CRM;
- MCP;
- D1;
- R2;
- Tool Gateway;
- dashboard;
- autenticación de clientes;
- tickets;
- pedidos;
- facturación;
- transferencia a operador humano;
- grabación persistente;
- campañas;
- escalado masivo;
- optimización prematura.

---

## 10.3 Prompt mínimo de FASE 0

La IA debe tener comportamiento simple y determinista:

```text
Eres un asistente de voz de pruebas para una centralita telefónica.
Habla en español.
Responde de forma natural, breve y clara.
Mantén una conversación general con el usuario.
No inventes capacidades empresariales.
Si el usuario se despide, despídete brevemente.
```

No incluir lógica de negocio.

---

## 10.4 Checklist de implementación FASE 0

### Telefonía

- [x] Seleccionar proveedor SIP inicial: **Twilio**
- [ ] Obtener número telefónico de prueba
- [ ] Verificar que el número puede recibir llamadas
- [ ] Configurar routing/trunk SIP
- [ ] Confirmar que el INVITE llega al destino realtime

### OpenAI Realtime

- [ ] Configurar credenciales fuera del repositorio
- [ ] Configurar sesión realtime para SIP
- [ ] Seleccionar modelo inicial
- [ ] Seleccionar voz inicial
- [ ] Configurar idioma/prompt
- [ ] Configurar VAD inicial
- [ ] Verificar audio de entrada
- [ ] Verificar audio de salida

### Conversación

- [ ] La IA atiende la llamada
- [ ] La IA emite saludo
- [ ] Usuario puede hablar
- [ ] IA entiende y responde
- [ ] Realizar al menos 10 turnos consecutivos
- [ ] Probar interrupción mientras la IA habla
- [ ] Probar silencio de varios segundos
- [ ] Probar despedida

### Cierre

- [ ] Cuelgue iniciado por usuario funciona
- [ ] Sesión realtime termina
- [ ] No queda llamada activa huérfana
- [ ] Repetir una nueva llamada inmediatamente

### Medición

- [ ] Medir tiempo desde fin de frase hasta inicio de respuesta
- [ ] Registrar percepción de cortes/jitter
- [ ] Registrar fallos de setup
- [ ] Registrar duración de llamada
- [ ] Registrar modelo/voz/configuración usados

---

## 10.5 Casos de prueba FASE 0

### F0-T01 — Setup básico

1. Marcar número.
2. Esperar respuesta.
3. Confirmar saludo audible.

**PASS:** la llamada conecta y la IA habla.

### F0-T02 — Conversación mínima

1. Usuario: «Hola, ¿cómo estás?»
2. IA responde.
3. Usuario realiza al menos 5 preguntas generales.

**PASS:** diálogo coherente en ambos sentidos.

### F0-T03 — Conversación prolongada

Mantener una llamada de al menos 5 minutos.

**PASS:** no hay desconexión inesperada ni degradación progresiva evidente.

### F0-T04 — Barge-in

1. Esperar a que la IA esté hablando.
2. Interrumpir con una nueva pregunta.

**PASS:** la IA deja de insistir con la respuesta anterior y atiende el nuevo turno de forma natural.

### F0-T05 — Silencio

Guardar silencio durante 5-10 segundos.

**PASS:** la llamada no entra en un estado roto.

### F0-T06 — Cuelgue del cliente

Colgar durante conversación normal.

**PASS:** la llamada termina y no queda una sesión activa indefinidamente.

### F0-T07 — Repetibilidad

Realizar 20 llamadas consecutivas de prueba.

**PASS:** al menos 19/20 completan setup y conversación básica sin fallo atribuible a nuestra configuración.

---

## 10.6 Métricas mínimas FASE 0

Por cada llamada registrar:

```text
run_id
fecha_hora
numero_origen_anonimizado
proveedor_telefonia
modelo
voz
vad_config
duracion_segundos
setup_ok
conversation_ok
barge_in_ok
hangup_ok
latencia_aprox_p50
fallos
notas
```

En esta fase se acepta medición manual asistida para establecer baseline, siempre que quede documentada.

---

## 10.7 Gate F0 — criterio obligatorio para avanzar

FASE 0 se marca `[x]` únicamente si se demuestra todo lo siguiente:

1. una llamada real entra desde PSTN;
2. la IA atiende automáticamente;
3. el usuario escucha a la IA correctamente;
4. la IA escucha y entiende al usuario;
5. existe conversación de varios turnos;
6. el usuario puede interrumpir razonablemente a la IA;
7. una llamada de 5 minutos permanece estable;
8. el cuelgue termina correctamente la sesión;
9. se completan al menos 20 llamadas de prueba con ≥95 % de setup correcto;
10. existe un baseline inicial de latencia documentado.

**Hasta superar Gate F0 no se implementan CRM, MCP, persistencia empresarial ni dashboard.**

---

# 11. FASE 1 — Baseline técnico y observabilidad mínima

Objetivo: convertir la prueba funcional de F0 en una integración reproducible y medible.

- [ ] Crear estructura TypeScript/Cloudflare
- [ ] Crear `package.json`
- [ ] Crear `tsconfig.json`
- [ ] Configurar Wrangler
- [ ] Crear `.gitignore`
- [ ] Crear `.env.example`
- [ ] Crear endpoint `/health`
- [ ] Añadir CI básica
- [ ] Crear endpoint/webhook de control necesario
- [ ] Crear `call_id`
- [ ] Registrar lifecycle de llamada
- [ ] Registrar configuración modelo/voz
- [ ] Registrar timestamps disponibles

**Gate F1:** build reproducible, deploy correcto, `/health` estable y cada llamada de prueba puede correlacionarse con un `call_id`.

---

# 12. FASE 2 — Latencia y barge-in

Objetivo: optimizar la experiencia conversacional después de tener una baseline real.

- [ ] medir first-audio latency
- [ ] medir p50/p95/p99
- [ ] ajustar VAD
- [ ] probar diferentes condiciones de silencio
- [ ] evaluar voz rápida/lenta
- [ ] validar barge-in repetidamente
- [ ] documentar configuración ganadora

**Gate F2:** configuración de conversación estable y latencia dentro del SLO acordado.

---

# 13. FASE 3 — Tool Gateway

Objetivo: primera capacidad empresarial sin degradar el audio path.

```text
OpenAI Realtime
      │
      ▼
Cloudflare Tool Gateway
      │
      ├── validación
      ├── autorización
      ├── timeout
      ├── auditoría
      └── adapters
```

- [ ] definir interfaz ToolExecutor
- [ ] implementar primera herramienta READ
- [ ] schema validation
- [ ] timeout
- [ ] manejo de errores
- [ ] auditoría
- [ ] resultado al modelo

**Gate F3:** herramienta real/simulada responde correctamente y ante fallo la IA no inventa resultados.

---

# 14. FASE 4 — Persistencia y post-call

- [ ] registro de llamadas
- [ ] eventos
- [ ] métricas
- [ ] transcripción opcional
- [ ] resumen post-call
- [ ] política de retención

**Gate F4:** cada llamada puede reconstruirse cronológicamente.

---

# 15. FASE 5 — Transferencia humana

- [ ] destino configurable
- [ ] trigger explícito
- [ ] transferencia SIP
- [ ] contexto de handoff
- [ ] éxito/fallo
- [ ] fallback

**Gate F5:** transferencia validada en caso normal y error.

---

# 16. FASE 6 — Integraciones MCP / negocio

- [ ] definir MCP realmente necesario
- [ ] conectar CRM/ERP/pedidos/etc.
- [ ] permisos por herramienta
- [ ] política de riesgos
- [ ] idempotencia para escritura
- [ ] circuit breakers

**Gate F6:** herramientas empresariales seguras, auditables y sin bloquear indefinidamente conversación.

---

# 17. FASE 7 — Concurrencia

Escalado progresivo:

- [ ] 10 llamadas
- [ ] 50 llamadas
- [ ] 100 llamadas
- [ ] 500 llamadas
- [ ] 1.000+ cuando el negocio lo justifique

No avanzar si:

- p95 degrada >20 %;
- error rate >1 %;
- aparecen sesiones huérfanas;
- el coste se desvía inesperadamente.

---

# 18. FASE 8 — Hardening producción

- [ ] rate limits
- [ ] secretos auditados
- [ ] alertas
- [ ] runbooks
- [ ] pruebas de fallo
- [ ] retención/eliminación
- [ ] revisión de seguridad
- [ ] plan de contingencia de telefonía
- [ ] plan de contingencia del modelo realtime

---

# 19. Estado de llamada

```text
CREATED
   │
   ▼
RINGING
   │
   ▼
ACTIVE
   │
   ├────► HANDOFF ───► COMPLETED
   │
   └────► COMPLETED

Any state ───► FAILED
```

Durante `ACTIVE` pueden existir estados derivados:

- LISTENING
- THINKING
- SPEAKING
- TOOL_WAIT
- INTERRUPTED

---

# 20. Tool Gateway

El modelo no accede directamente a APIs internas de forma arbitraria.

Cada herramienta declara:

```ts
{
  timeoutMs: number,
  retryable: boolean,
  idempotent: boolean,
  risk: "read" | "low" | "high"
}
```

Clasificación:

- READ: consultas sin efectos secundarios;
- WRITE LOW-RISK: tickets, notificaciones;
- WRITE HIGH-RISK: pagos, cancelaciones, cambios críticos.

Las operaciones de alto riesgo requieren políticas adicionales.

---

# 21. Seguridad

Nunca commitear:

- `OPENAI_API_KEY`
- credenciales del proveedor de telefonía
- tokens CRM
- secretos MCP
- secretos de webhook

Reglas:

- validar webhooks;
- mínimo privilegio;
- allowlist de herramientas;
- no confiar en metadata del caller;
- no guardar PII innecesaria;
- proteger frente a prompt injection por voz;
- el modelo nunca decide permisos.

---

# 22. Observabilidad

Métricas principales:

### Telefonía

- llamadas entrantes;
- aceptadas;
- fallidas;
- duración;
- transferencias.

### Conversación

- first-audio latency;
- interruptions/call;
- silence time;
- turns/call;
- barge-in behavior.

### Herramientas

- success rate;
- timeout rate;
- p50/p95/p99.

### Coste

- telecom cost/call;
- model cost/call;
- model cost/minute;
- total cost/resolved call.

---

# 23. Estrategia de pruebas

## Unit

- estado de llamada;
- políticas;
- parsers;
- idempotencia;
- herramientas.

## Integration

- control plane ↔ OpenAI;
- control plane ↔ proveedor telefónico;
- Tool Gateway ↔ backend.

## E2E

Siempre debe existir una prueba con llamada telefónica real.

## Load

Escalar progresivamente; no comenzar con cargas masivas.

## Soak

Detectar sesiones huérfanas, degradación p99 y costes anómalos.

---

# 24. Definition of Done

Una feature no está terminada hasta tener:

1. implementación;
2. prueba apropiada;
3. manejo de error;
4. timeout cuando aplique;
5. métricas/logs;
6. secretos externalizados;
7. documentación actualizada;
8. criterio de aceptación demostrado;
9. cumplimiento verificado de todas las Reglas Arquitectónicas No Negociables aplicables.

---

# 25. ADR / Decision Log

## ADR-001 — Speech-to-speech nativo

**Estado:** Accepted  
**Decisión:** utilizar OpenAI Realtime speech-to-speech como ruta principal.

## ADR-002 — Direct SIP como media plane oficial

**Estado:** Accepted  
**Decisión:** telefonía/SIP conecta directamente con OpenAI Realtime. No se desarrollará un media bridge Cloudflare como arquitectura paralela.

**Razón:** reducir saltos, buffering, jitter, complejidad y superficie de fallo.

## ADR-003 — Cloudflare como control plane

**Estado:** Accepted  
**Decisión:** Cloudflare aloja progresivamente herramientas, políticas, persistencia, webhooks y administración, pero no transporta audio en la ruta principal.

## ADR-004 — MCP fuera del camino crítico de audio

**Estado:** Accepted  
**Decisión:** MCP se usa para interoperabilidad empresarial cuando aporte valor; nunca como requisito para que el audio fluya.

## ADR-005 — FASE 0 es audio E2E

**Estado:** Accepted  
**Decisión:** el primer milestone del proyecto no es infraestructura web sino demostrar una llamada telefónica real, conversación IA bidireccional y cierre correcto.

**Razón:** el mayor riesgo técnico del producto es el canal de voz realtime. Debe validarse antes de desarrollar capas periféricas.

## ADR-006 — Independencia de proveedores

**Estado:** Accepted

**Problema:** acoplar el dominio a Twilio, OpenAI u otro proveedor elevaría el coste y riesgo de futuras migraciones.

**Decisión:** las integraciones externas se implementarán mediante `TelephonyProvider`, `RealtimeProvider`, `ToolGateway` y adaptadores de infraestructura.

**Motivación:** preservar sustituibilidad, capacidad de prueba y evolución tecnológica/comercial.

**Consecuencias:** se acepta una pequeña capa adicional de abstracción desde el inicio a cambio de reducir vendor lock-in.

**Alternativas descartadas:** utilizar SDKs de Twilio/OpenAI directamente desde el dominio por rapidez inicial.

---

# 26. Riesgos principales

| ID | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| R-001 | Latencia variable del modelo | Alto | medir p50/p95/p99 |
| R-002 | Problemas de routing SIP | Crítico F0 | prueba E2E primero |
| R-003 | Barge-in deficiente | Alto | ajuste VAD + pruebas |
| R-004 | Calidad telefónica limitada | Alto | validar con llamadas reales |
| R-005 | Tool backend lento | Alto | timeout/circuit breaker |
| R-006 | Hallucination empresarial | Crítico | tools como fuente de verdad |
| R-007 | Acciones sensibles incorrectas | Crítico | policy gateway |
| R-008 | Coste/minuto elevado | Alto | medir coste por llamada resuelta |
| R-009 | PII en logs | Alto | redaction |
| R-010 | Sesiones huérfanas | Alto | lifecycle + cleanup |
| R-011 | Vendor lock-in | Medio | `TelephonyProvider` + `RealtimeProvider` + `ToolGateway` + adaptadores |

---

# 27. Modelo de coste

```text
Cost_per_call =
  telecom
+ realtime_model
+ tools
+ storage
+ observability
+ infrastructure
```

KPI preferente:

```text
Cost_per_resolved_call =
  total_cost / successfully_resolved_calls
```

---

# 28. Estructura prevista del repositorio

```text
IA_RealTime_CenterCall/
├── README.md
├── docs/
│   ├── ARCHITECTURE_SPECIFICATION.md
│   ├── adr/
│   ├── benchmarks/
│   └── runbooks/
├── apps/
│   ├── control-plane/
│   └── admin-web/        # futuro
├── packages/
│   ├── domain/
│   ├── telephony/
│   ├── realtime/
│   ├── tools/
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

FASE 0 puede requerir muy poco o ningún código propio si la configuración SIP → Realtime puede validarse directamente. **Eso es aceptable y deseable.** No escribir código solo para aparentar progreso.

---

# 29. Configuración conceptual

```text
ENVIRONMENT=dev
TELEPHONY_PROVIDER=twilio
REALTIME_PROVIDER=openai
REALTIME_MODEL=<configurable>
REALTIME_VOICE=<configurable>
DEFAULT_LANGUAGE=es
CALL_MAX_DURATION_SECONDS=1800
LOG_LEVEL=info
```

Secretos fuera de Git.

---

# 30. Fuentes técnicas a verificar antes de implementar

Las APIs pueden cambiar. Antes de cada fase se debe verificar documentación oficial actual de:

- OpenAI Realtime API;
- OpenAI Realtime SIP/calls;
- proveedor SIP seleccionado;
- Cloudflare Workers/Agents cuando se incorpore control plane.

No asumir nombres de modelos, precios, límites o firmas API sin verificación actual.

---

# 31. Próximo trabajo — únicamente FASE 0

El siguiente trabajo del proyecto es exclusivamente:

```text
1. crear/configurar cuenta Twilio y obtener número de prueba
2. configurar SIP
3. conectar a OpenAI Realtime
4. realizar primera llamada
5. conversar
6. colgar
7. repetir
8. medir baseline
9. cerrar Gate F0
```

No comenzar todavía:

- estructura compleja de Cloudflare;
- D1;
- MCP;
- CRM;
- dashboard;
- transferencia humana;
- load testing.

---

# 32. Estado actual

**Arquitectura:** Direct SIP → OpenAI Realtime + Cloudflare como control plane.  
**Proveedor telefónico inicial:** Twilio, encapsulado mediante `TelephonyProvider`.  
**FASE activa:** FASE 0 — Prueba end-to-end del canal de audio.  
**Código:** todavía no requerido para dar por iniciada F0.  
**Gate inmediato:** conseguir una llamada telefónica real, conversación bidireccional estable y cierre correcto.
