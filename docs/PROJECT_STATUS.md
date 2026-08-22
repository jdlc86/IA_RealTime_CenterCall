# IA_RealTime_CenterCall — estado operativo

> Snapshot: 2026-08-22
> Para continuar: [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md)

Los datos de GitHub y Cloudflare deben verificarse de nuevo al comenzar otra sesión. Este archivo distingue siempre implementación, CI, despliegue y E2E.

## Baseline actual

```text
rama              rebuild/v39-stable-baseline
PR                 #85, OPEN / DRAFT / MERGEABLE
último HEAD código  00feb33f0bb2053d6e4a143c01299fa1326736a1
CI                 Control Plane CI 32585791710 — SUCCESS
Workers Build      SUCCESS para 00feb33
producción          fe2f21e9-488b-4f69-9c40-15dc3a86d69f — 100 % tráfico
tests               770 Node + 4 Workers runtime
dry-runs            production + preview + dev — PASS
```

El commit documental que actualice este snapshot será posterior a `00feb33`; por ello nunca se usa este SHA como expectativa rígida.

## Estado por preocupación

| Área | Implementado | CI | Producción | E2E / evidencia pendiente |
|---|---:|---:|---:|---|
| Fronteras provider-neutral y saneamiento cross-generation | ✅ | ✅ | ✅ | auditar solo ante violación demostrada |
| Conversación natural, presencia y cierre | ✅ | ✅ | ✅ | seguir revisando llamadas anómalas por trazas |
| Reservas, fechas, alternativas y concurrencia en commit | ✅ | ✅ | ✅ | repetir escenarios de voz tras cambios relacionados |
| Necesidades especiales y handoff inclusivo | ✅ | ✅ | ✅ | validación de lenguaje/caso real |
| Seguridad semántica y sanciones durables | ✅ | ✅ | ✅ | pruebas adversariales periódicas |
| Diagnóstico técnico mínimo, redactado y de retención corta | ✅ | ✅ | ✅ | verificar utilidad en próximas incidencias |
| Saludo protegido frente a voz/ruido | ✅ | ✅ | ✅ | llamada posterior a `fe2f21e9…` todavía requerida |
| Segundo realtime provider / Gemini | ❌ | — | — | bloqueado; OpenAI sigue siendo el único activo |

## Último incidente corregido

Llamada `rtc_u7_EFivDhNSDehpAqBZKzsuO`:

```text
saludo empieza
→ caller/ruido activa VAD a ~2,1 s
→ provider borra output buffer
→ caller oye solo «Buenas»
→ lifecycle queda LUCIA_SPEAKING
→ sideband termina sin respuesta ni hangup gobernado
```

Causa: la protección anterior desactivaba `interrupt_response`, pero mantenía VAD y trataba `ASSISTANT_AUDIO_CLEARED` como finalización correcta.

Corrección `00feb33`:

- suspender completamente input detection durante saludo/recuperación;
- limpiar audio captado antes y durante el mensaje protegido;
- emitir texto exacto aislado;
- si el buffer se borra, esperar el `response.done` correlacionado y reemitir de forma acotada;
- mantener `LUCIA_SPEAKING` entre intentos;
- restaurar VAD únicamente tras `ASSISTANT_AUDIO_STOPPED`.

## Siguiente validación

Realizar una llamada en producción:

1. hablar o generar ruido mientras Lucía pronuncia el saludo inicial;
2. comprobar que el saludo se oye completo o se reinicia, pero nunca queda truncado en silencio;
3. comprobar que lo hablado durante el saludo no entra como turno semántico;
4. esperar al final y formular una petición real;
5. verificar que Lucía responde normalmente;
6. reconstruir diagnósticos si falla antes de modificar código.

Aceptación técnica:

```text
PROTECTED_SPEECH_STARTED_V35
input_detection_suspended=true
ASSISTANT_AUDIO_CLEARED (si ocurre) → protection_released=false
PROTECTED_SPEECH_REPLAYED_AFTER_CLEAR_V35 (si ocurre)
ASSISTANT_AUDIO_STOPPED → PROTECTED_SPEECH_COMPLETED_V35
después: input detection restaurado y caller transcript usable
```

## Restricciones vigentes

- No añadir `CallSession` V55+ ni reactivar V47/V52.
- No habilitar Gemini ni cambiar el media path sin gates, ADR y benchmark.
- No modificar el drain terminal de 750 ms sin evidencia causal.
- No añadir listas de frases para resolver intención conversacional abierta.
- No confundir una tool/CI verde con una reserva, deploy o E2E real.
- No tocar producción manualmente sin reconciliar el resultado en GitHub.

Historial detallado: [`SESSION_HANDOFF_PROMPT_2026-08-22.md`](./SESSION_HANDOFF_PROMPT_2026-08-22.md), [`SESSION_HANDOFF_2026-08-19.md`](./SESSION_HANDOFF_2026-08-19.md) y [`DEVELOPMENT_LOG.md`](./DEVELOPMENT_LOG.md).
