# IA_RealTime_CenterCall — Design Rules

> **Versión:** 3.1
> **Estado:** vigente y normativo
> **Última revisión:** 2026-08-29
> **Aplicabilidad:** reglas transversales; un mecanismo específico de provider sólo es obligatorio cuando la regla o una ADR lo indiquen.

Estas reglas son obligatorias salvo ADR posterior que las modifique explícitamente. **No se debe convertir una implementación histórica de OpenAI o de la arquitectura Gemini previa al Fast Path en una regla universal por accidente.**

- **RA-001** — El dominio no importa SDKs externos.
- **RA-002** — Toda integración externa tiene contrato/provider/adaptador o una frontera explícita equivalente dentro del runtime que la posee.
- **RA-003** — Cloudflare queda fuera del audio path continuo.
- **RA-004** — Toda herramienta empresarial entra por `ToolGateway` o por la frontera de efectos autorizada del runtime antes de llegar a módulos/providers. Un Fast Path puede ejecutar localmente la coordinación realtime sin saltarse capability, schema, tenant e invariantes.
- **RA-005** — No se amplía el media plane con nuevos hops obligatorios sin benchmark + ADR.
- **RA-006** — No se optimiza sin baseline o evidencia medible.
- **RA-007** — Ningún gate se cierra sin evidencia adecuada al comportamiento que afirma probar.
- **RA-008** — Nuevas features preservan la independencia estructural de los productos realtime y la sustituibilidad donde exista un contrato neutral real.
- **RA-009** — Ningún secreto se almacena en Git ni se copia a documentación.
- **RA-010** — El modelo nunca es autoridad de permisos, tenant, credenciales ni invariantes empresariales.
- **RA-011** — El Core/dominio no contiene lógica específica de clínica/restaurante/cliente concreto.
- **RA-012** — El modelo no inventa disponibilidad ni confirma operaciones sin fuente de verdad.
- **RA-013** — Toda sesión/operación empresarial tiene `tenant_id` confiable.
- **RA-014** — Los módulos de dominio no dependen de SDKs/modelos de datos de sistemas externos.
- **RA-015** — El tenant de llamada se resuelve desde routing confiable; inicialmente `called_number → tenant_id`.
- **RA-016** — La personalización se realiza mediante configuración, módulos y providers; nunca mediante forks o condicionales específicos por cliente.
- **RA-017** — No comienza conversación específica de negocio antes de completar tenant binding/admission necesario para el runtime.
- **RA-018** — La configuración conversacional neutral sólo incluye conceptos realmente compartidos; cada runtime traduce o posee sus detalles específicos sin forzar falsa paridad de wire.
- **RA-019** — GitHub es la fuente de verdad; cambios manuales remotos sólo se permiten como diagnóstico/contingencia y deben reconciliarse.
- **RA-020** — Todo deploy de producción parte de un SHA publicado y de los gates aplicables. Deben verificarse versión efectiva, bindings/routing y E2E cuando el cambio lo requiera.
- **RA-021 — One state owner per concern.** Cada estado mutable, permiso o transición importante tiene una sola autoridad. Un port expone una capacidad; no crea un segundo owner.
- **RA-022 — Capability first.** Los efectos se expresan como capacidades de producto (`checkAvailability`, `createReservation`, `transferCall`, etc.); las capas de dominio no invocan wire formats/SDKs arbitrarios.
- **RA-023 — Provider details at the edge/runtime owner.** OpenAI, Gemini, Telnyx, Supabase y Cloudflare se traducen en las fronteras que los poseen; no contaminan el dominio neutral.
- **RA-024 — Sin estado privado entre generaciones o productos.** Ninguna capa alcanza internals de otra mediante casts, prototipos, flags heredados o estado compartido accidental. OpenAI y Gemini no comparten estado efímero de llamada.
- **RA-025 — Ordering por evidencia, no por tiempo.** Carreras de voz, tools y lifecycle se resuelven con identidad, ownership, sequence/eventos y estado explícito. No se añaden `sleep`, delays ni ventanas heurísticas para tapar desorden.
- **RA-026 — La intención conversacional pertenece al modelo.** No se enumeran todas las frases posibles del usuario para simular comprensión. Los matchers léxicos sólo son apropiados para protocolos cerrados y acotados, no para lenguaje natural abierto.
- **RA-027 — Determinismo sólo en invariantes.** Permisos, validación, idempotencia, tenant binding, confirmación empresarial, concurrencia, seguridad y lifecycle son deterministas. Interpretación abierta y formulación natural siguen siendo model-owned dentro de esos límites.
- **RA-028 — Habla protegida sólo cuando el lifecycle la declara.** Saludos, anuncios de handoff u otros mensajes que un runtime marque explícitamente como protegidos/atómicos deben tener un owner claro de playback y reglas de interrupción verificables. Los mecanismos concretos (`VAD suspend`, `assistant_audio_stopped`, marks, etc.) son provider/runtime-specific y no se extrapolan automáticamente a todos los caminos.
- **RA-029 — Una respuesta activa y una decisión de efecto por turno/owner.** Ninguna capa crea respuestas o consume tools en paralelo saltándose el owner de respuesta, turno o autorización aplicable.
- **RA-030 — Confirmación empresarial basada en backend.** El modelo nunca afirma reserva, cancelación, transferencia completada o escritura hasta recibir evidencia estructurada adecuada. Una confirmación conversacional no sustituye el resultado del sistema.
- **RA-031 — Concurrencia adjudicada en commit.** La disponibilidad conversacional es informativa. PostgreSQL/sistema fuente decide el ganador al confirmar; el perdedor recibe una nueva alternativa, nunca un éxito ficticio.
- **RA-032 — Handoff inclusivo.** Necesidades de movilidad, audición, bebés u otras adaptaciones se derivan con lenguaje cuidadoso y orientado a asegurar una buena experiencia; nunca como exclusión.
- **RA-033 — Seguridad por intención y fronteras.** Prompt extraction, manipulación de tools e intentos abusivos se gobiernan por políticas/autoridades; no exclusivamente por listas de palabras. No se exponen prompts privados, secretos o wire interno.
- **RA-034 — Diagnóstico mínimo y redactado.** Se conserva sólo trazabilidad técnica necesaria, bounded y con retención apropiada. No se persisten audio, secretos ni datos personales/transcripts crudos sin necesidad explícita.
- **RA-035 — Una fuente documental por decisión.** Arquitectura estable vive aquí/ADR; estado operativo en `PROJECT_STATUS.md`; relevo en `SESSION_HANDOFF.md`; procedimientos en runbooks. Los documentos históricos deben marcarse como tales y no duplicar una segunda “verdad actual”.
- **RA-036 — Provider realtime seleccionado por tenant y fijado por llamada.** Una llamada no cambia silenciosamente OpenAI↔Gemini. Cualquier failover cross-provider requiere ADR que preserve contexto, ownership, tools y audio pendiente.
- **RA-037 — Aislamiento estricto entre productos realtime.** OpenAI y Gemini no comparten sockets, buffers, wire events ni estado privado. El dominio neutral no contiene ramas para compensar semántica específica de un provider; cada producto puede tener su propio runtime y lifecycle.
- **RA-038 — Paridad de invariantes, no paridad de wire.** Cuando ambos productos ofrecen una misma capacidad, deben preservar sus invariantes de producto/seguridad, pero no necesitan implementar idéntico lifecycle, STT, VAD, response IDs ni transporte.
- **RA-039 — Identidad suficiente para causalidad.** Cada runtime debe conservar/generar identidades estables suficientes para correlación, idempotencia y diagnóstico; el dominio no depende de identificadores propietarios concretos si no son necesarios.
- **RA-040 — Media plane por provider es explícito.** OpenAI puede conservar SIP/direct media; Gemini puede usar Media Edge. Ninguna diferencia justifica introducir audio continuo en Cloudflare.
- **RA-041 — Activación de provider por gates.** Registrar/codificar un provider no equivale a habilitar llamadas. Contratos, media, seguridad, deployment y E2E se prueban antes de activación. **Para Gemini Fast este gate histórico ya fue cruzado; no debe leerse como “Gemini sigue deshabilitado”.**
- **RA-042 — Setup Live y propiedad de sesión siguen el contrato real del provider.** En Gemini Live el setup inicial se compone antes de tráfico y se espera `setupComplete`; no se finge mutación dinámica mediante un segundo setup incompatible.
- **RA-043 — No falsificar roles para obtener paridad.** Una orden del sistema/asistente o continuación post-tool no se inyecta como caller input sólo porque otro provider tuviera una primitiva diferente.
- **RA-044 — Evidencia de transcript/lifecycle debe existir realmente.** Un adapter/runtime no inventa completion ni promueve evidencia parcial a definitiva. Si eventos coexisten o llegan con ordering distinto, el owner los correlaciona explícitamente.
- **RA-045 — Capabilities describen semántica validada.** Que el vendor anuncie una feature o un unit test pase no autoriza a declarar comportamiento E2E que no se ha observado.
- **RA-046 — Autoridad semántica grounded para efectos conversacionales.** Cuando el modelo decide una intención abierta que habilita un efecto sensible, el kernel puede exigir evidencia del turno; esa comprobación valida grounding/estado, no vuelve a interpretar el lenguaje mediante una lista de frases.
- **RA-047 — Capturar evidencia antes de encolar efectos asíncronos.** Si un tool depende del turno actual, la evidencia/transcript relevante se snapshottea antes de que `turnComplete`, cleanup u otro lifecycle pueda mutar o borrar el estado. La ejecución posterior usa ese snapshot.
- **RA-048 — Routing etiquetado es tráfico real.** En despliegues donde un Worker apunta directamente a una URL etiquetada de Cloud Run, `0%` de tráfico general del servicio no implica que esa revisión no atienda llamadas. La ruta efectiva se determina por el binding/URL usado por el caller path.
- **RA-049 — Evidencia de control no demuestra experiencia acústica.** `call.bridged`, `call.speak.ended`, un target leg creado o un HTTP 2xx no demuestran por sí solos que el caller oyera ringback/TTS. Los problemas acústicos requieren evidencia acústica/E2E proporcional.
- **RA-050 — Fallos de observabilidad/deploy gate no se convierten automáticamente en fallos del hot path.** Debe identificarse qué capa falló antes de modificar audio, VAD, codecs o runtime estable.
- **RA-051 — Presupuesto de latencia obligatorio.** Ningún cambio introduce inferencia, RPC, persistencia, `sleep`, buffer o transformación síncrona en audio/turn/post-tool sin baseline, presupuesto explícito y medición p50/p95/p99. El trabajo por chunk requiere ADR y benchmark.
- **RA-052 — Capacidades transversales frente a verticales.** Seguridad, admission/identidad, voz/lifecycle, autorización de tools, handoff, tiempo autoritativo, diagnóstico/redacción y comunicación externa pertenecen al kernel transversal. Reservas, citas, disponibilidad, mesas y reglas sectoriales pertenecen al vertical/tenant y no se duplican por provider.
- **RA-053 — Contrato mínimo de toda tool.** Toda tool declara nombre y schema cerrado, `authority`, `effect`, `capability`, `evidence`, handler permitido y contexto confiable de tenant/call. Las mutaciones añaden idempotencia, confirmación e invariantes de dominio. El modelo propone; el kernel autoriza; el dominio valida; el backend ejecuta.
- **RA-054 — Seguridad durable sin transcript crudo.** Las señales semánticas de seguridad se persisten de forma autenticada, idempotente y sideband cuando la invariante lo permite. No se almacenan audio, prompts, secretos, payload hostil ni transcript crudo.
- **RA-055 — Comunicaciones externas opt-in.** Cada canal/modo se autoriza por capability de tenant. WhatsApp separa `message.whatsapp.transactional` de `message.whatsapp.realtime_support`; habilitar una no autoriza la otra.
- **RA-056 — La autorización debe ser exigible en el sink.** El orden `kernel → executor/handler` no basta como convención. Cada sink effectful exige una prueba no fabricable ligada a la operación exacta y al contexto tenant/call; ejecuta la instantánea autorizada y falla cerrado ante ausencia, rebinding o contexto distinto.
- **RA-057 — Capability grant explícito y tenant-bound.** Cada tool admitida declara su capability en el bootstrap autenticado. El runtime exige coincidencia exacta entre esa concesión y la policy local antes de exponer la tool o aceptar una function call. Una capability ausente, desconocida, perteneciente a otro contrato o procedente de otro tenant falla cerrada antes de cualquier side effect.

## Applicability notes del Fast Path Gemini

ADR-004 supersede para el Fast Path la obligatoriedad de mecanismos de la arquitectura Gemini anterior como:

- Google STT como gate de cada turno;
- semantic preselection aislada antes de entregar audio a Gemini;
- output quarantine como paso normal de cada respuesta;
- Durable Object/control WSS en el camino de cada turno;
- TTS externo como voz normal de conversación.

Esos módulos pueden seguir existiendo para compatibilidad, experimentación o rutas no Fast. **Existencia de código ≠ participación en producción Fast.**

## Definition of Done arquitectónica

Una feature no está terminada si:

- viola una regla aplicable;
- carece de prueba de comportamiento;
- cambia una frontera sin guard/contrato suficiente;
- no maneja error/observabilidad proporcional;
- deja documentación canónica afirmando algo distinto del runtime real.

Para cambios de voz/telefonía, una suite verde no sustituye la evidencia E2E adecuada. Para cambios de documentación, `docs:check` no sustituye la comprobación contra código, workflows y estado remoto cuando se describen producción o despliegues.

`CI verde`, `desplegado` y `validado E2E` siguen siendo estados distintos.
