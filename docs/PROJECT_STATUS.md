# IA_RealTime_CenterCall — PROJECT STATUS

> **Estado operativo actual del proyecto**
> **Fecha:** 2026-08-17
> La arquitectura normativa pertenece a `docs/architecture/SYSTEM_ARCHITECTURE.md`.
> Para continuidad entre sesiones leer también `docs/SESSION_HANDOFF_2026-08-17.md`.

## Estado resumido

```text
F0 Voz E2E                                   ✅ CERRADA
F1 Baseline + observabilidad + TenantResolver ✅ CERRADA
F2 Latencia + barge-in                       🟡 REABIERTO OPERATIVAMENTE PARA HARDENING v40
F3 ToolGateway                               🟡 EN CURSO
F4 Clínica + validación multi-negocio        🟡 EN CURSO
F5 Persistencia empresarial + Supabase       🟡 EN CURSO
F6 Handoff humano                            🟡 IMPLEMENTADO / VALIDADO PARCIALMENTE E2E
F7 Concurrencia                              🟡 IMPLEMENTACIÓN PARCIAL v36/v40
F8 Hardening producción                      🟡 EN CURSO
F9 App de gestión                            ⬜ NO INICIADA
```

## Estado de código/CI actual

Rama:

```text
rebuild/v39-stable-baseline
```

Último SHA funcional con CI verde antes de los commits documentales:

```text
f69f37de06cc953d50dd18884cb7bcd2132251c3
Control Plane CI #254 — SUCCESS
```

Estado de `f69f37de...`:

- IMPLEMENTADO: sí;
- CI VERDE: sí;
- DESPLEGADO: no confirmado al generar este documento;
- VALIDADO E2E: pendiente de nueva llamada posterior al despliegue.

## RESTAURANT — reservas

Estado funcional vigente:

- CREATE con disponibilidad, datos incrementales, caller ID confiable y confirmación explícita;
- QUERY por `tenant_id + caller_phone`;
- CANCEL individual/múltiple/ALL;
- `reservation_code` público `R-######` separado del UUID interno;
- grounding temporal en `Europe/Madrid`;
- Truth Guard para no afirmar BOOKED/CANCELLED sin evidencia backend;
- marketing separado de reservas.

Última llamada registrada durante la sesión 2026-08-17 completó una reserva `BOOKED` y permitió continuar conversación; el cierre automático indebido fue bloqueado por v41.

## Barge-in — reconstrucción v40

Objetivo: recuperar interrupción natural sin volver a introducir silencios, cancelaciones espurias ni dependencia de `response.done`.

Arquitectura actual:

- escucha durante playback con auto-interrupt y auto-create desactivados;
- clasificación semántica `INTERRUPT | IGNORE` fuera de conversación;
- un único response owner;
- v36 cede ownership para un barge-in confirmado;
- `response.done` es reconciliación, no gate;
- candidato sin transcript útil -> `IGNORE` inmediato;
- saludo/recovery/handoff protegidos no son interruptibles.

Evidencia E2E positiva observada:

```text
BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD
BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD
TURN_CONCURRENCY_BYPASSED_V36
BARGE_IN_CONFIRMED_V40_REBUILD
response_done_gate=false
```

También:

```text
BARGE_IN_UNCLASSIFIABLE_IGNORED_V40_REBUILD
resolved_without_watchdog=true
```

## Concurrencia v36/v40

v36 sigue protegiendo turnos normales. Cuando v40 confirma un barge-in, el `item_id` queda bajo ownership superior y v36 no adquiere lock ni puede descartarlo como solapado.

Aun se han observado `TURN_CONCURRENCY_OVERLAPPING_TURN_DROPPED_V36` en turnos normales. No se deben eliminar esas defensas sin nueva evidencia; deben investigarse caso por caso.

## User presence / “¿Sigues ahí?”

Se detectó un defecto real: presence recovery podía activarse durante una conversación todavía activa y generar respuestas concurrentes.

Correcciones:

- guardas para no recuperar presencia mientras Lucía está reproduciendo/procesando/herramienta activa;
- v42 impide que `background_input_ignored_v29` vuelva a armar/reiniciar el deadline como un periodo nuevo de espera.

Pendiente: validar E2E que tras `f69f37de...` ya no aparece `USER_PRESENCE_RECOVERY_REQUESTED` inducido por background ignored.

## Cierre de llamada — v41

Incidente: después de `BOOKED`, el modelo seleccionó `restaurant_end_call {confirmed:true}` sin despedida del usuario y el runtime colgó.

v41 añade autorización determinista:

- `confirmed:true` del modelo no basta;
- se exige evidencia del último transcript útil del usuario;
- despedida explícita o confirmación a una pregunta de cierre pendiente permiten cerrar;
- reserva terminada, marketing o cortesía de Lucía no autorizan hangup.

En la llamada posterior la defensa funcionó: `closing_authorized=false` y no hubo cierre automático.

## Human handoff — F6 ya activo

La documentación anterior que decía “F6 no iniciada / no hay transferencia activa” quedó obsoleta.

Estado actual:

- v37: transporte determinista, trazabilidad, anuncio protegido y transferencia Telnyx;
- v38: manejo de fallos terminales;
- v39: `call.bridged` es señal intermedia; solo `call.answered` en target leg confirma transferencia contestada;
- existen llamadas reales donde el flujo de handoff llegó a `HUMAN_HANDOFF_TRANSFER_STARTED_V37`.

### Regresión detectada

En una llamada del 2026-08-17:

```text
usuario pregunta horario
→ restaurant_business_info(HOURS)
→ backend FOUND
→ respuesta correcta disponible
→ modelo selecciona restaurant_human_assistance
→ v37 acepta OTHER_RESTAURANT_MATTER
→ comienza transferencia
```

El transporte v37/v39 funcionó; el defecto estaba en la frontera de autorización: el modelo podía pedir una acción irreversible aunque el turno ya estuviera resuelto.

### Corrección v42

Si el turno actual acaba de resolverse con:

```text
restaurant_business_info -> FOUND
```

y la respuesta ya terminó, `restaurant_human_assistance` queda bloqueado en ese mismo turno. Un nuevo transcript útil del usuario inicia un turno nuevo y vuelve a permitir handoff legítimo.

La política es intencionadamente conservadora: no extenderla a todas las tools sin evidencia.

## Supabase / observabilidad

Proyecto:

```text
vutekfkbtvfogouwcfvc
```

Fuente principal de diagnóstico:

```text
public.call_diagnostic_events
```

Regla operativa: toda regresión de llamada debe reconstruirse desde esta tabla antes de modificar código.

## Cloudflare

- Worker control-plane activo en Cloudflare;
- tenant config rápida en KV `TENANT_CONFIG`;
- CI ejecuta `wrangler deploy --dry-run`;
- deploy real: `wrangler deploy` por el flujo disponible;
- la disponibilidad de un conector Cloudflare de escritura depende de la sesión de ChatGPT; no afirmar un deploy si no existe herramienta capaz de ejecutarlo/verificarlo.

## Metodología obligatoria

1. Recibir síntoma.
2. No cambiar código.
3. Consultar `call_diagnostic_events` de la llamada afectada.
4. Reconstruir orden de eventos.
5. Identificar la capa que tomó la decisión errónea.
6. Comparar con v39 cuando aporte información, distinguiendo garantías reales de comportamiento de facto.
7. Crear una corrección estructural mínima.
8. Añadir test de regresión.
9. Exigir CI verde: tests + Wrangler dry-run.
10. Confirmar SHA desplegado.
11. Realizar llamada controlada.
12. Revisar logs antes de cualquier siguiente modificación.

No apilar timers/parches. Para acciones irreversibles (WRITE, hangup, handoff) el modelo/prompt no debe ser la única autoridad.

## Próximo paso operativo

1. Confirmar si `f69f37de06cc953d50dd18884cb7bcd2132251c3` está realmente desplegado.
2. Si procede, repetir la llamada controlada.
3. Revisar la nueva traza completa sin hacer cambios.
4. Verificar:
   - background ignored no provoca un nuevo presence recovery;
   - `business_info -> FOUND` no desemboca en handoff en el mismo turno;
   - un turno nuevo sí puede solicitar handoff legítimo;
   - barge-in v40 sigue funcionando;
   - v41 sigue bloqueando cierre sin despedida real.
5. No avanzar a otra corrección hasta tener evidencia de esa llamada.
