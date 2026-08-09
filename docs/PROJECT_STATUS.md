# IA_RealTime_CenterCall — PROJECT STATUS

> **Estado operativo actual del proyecto**  
> **Fecha:** 2026-08-09  
> Este documento registra progreso y cierre de fases. La definición de arquitectura y del roadmap sigue perteneciendo a `docs/architecture/SYSTEM_ARCHITECTURE.md`.

## Estado de fases

```text
F0 Voz E2E                              ✅ CERRADA — PASS
F1 Baseline + observabilidad + TenantResolver ✅ CERRADA — PASS con baseline cuantitativo CANCELADO por decisión de proyecto
F2 Latencia + barge-in                  ✅ CERRADA SIN CAMBIOS DE OPTIMIZACIÓN — comportamiento actual aceptado como satisfactorio por decisión de proyecto
F3 ToolGateway                          🟡 EN CURSO
F4 Clínica + validación multi-negocio   ⬜ NO INICIADA
F5 Persistencia/post-call               ⬜ NO INICIADA
F6 Handoff humano                       ⬜ NO INICIADA
F7 Concurrencia                         ⬜ NO INICIADA
F8 Hardening producción                 ⬜ NO INICIADA
```

## Evidencia de F0

FASE 0 quedó validada con pruebas reales de voz, incluyendo conversación prolongada, barge-in, silencios, cierre manual y por intención, llamadas consecutivas y estabilidad E2E. La evidencia detallada permanece en `docs/tests/PHASE0.md` y en la documentación de cierre por intención.

## Evidencia de F1

Validado:

- `TenantResolver` independiente;
- routing `called_number → tenant_id`;
- `+34910789057 → clinica-estetica-madrid`;
- `TenantConfiguration` para Clínica Estética Madrid;
- asistente configurada como Carolina;
- tenant binding propagado hasta `CallSession`;
- saludo inicial personalizado validado mediante llamada real;
- comportamiento fail-closed para número desconocido;
- pruebas contractuales del resolver: 7/7 PASS;
- logs de tenant resolution/bootstrap implementados.

Decisión de alcance F1:

- el baseline cuantitativo de latencia/setup fue CANCELADO por decisión de proyecto;
- no se considera fallo ni pendiente bloqueante.

## Disposición de F2

La fase de Latencia + barge-in se cerró sin introducir nuevas optimizaciones. El sistema ya había demostrado barge-in e interacción satisfactoria durante F0 y el comportamiento actual fue aceptado por decisión de proyecto. Se prioriza no modificar un flujo de voz estable sin un defecto reproducible que lo justifique.

Esto no significa que la latencia quede fuera del proyecto: si aparece un problema medible o reproducible, se reabre como trabajo de rendimiento/regresión.

## F3 — ToolGateway

FASE 3 está EN CURSO.

Primer bloque implementado:

- contrato `ToolGateway` independiente de SDKs externos;
- `tenant_id` obligatorio;
- allowlist explícita por tenant;
- fail-closed para tools desconocidas/no autorizadas;
- validación de argumentos antes de ejecutar;
- errores estructurados;
- clasificación `READ` / `WRITE`;
- pruebas contractuales iniciales 7/7 PASS.

Guía activa: `docs/implementation/PHASE_3_IMPLEMENTATION_GUIDE.md`.

## Próximo paso

Integrar ToolGateway con `CallSession` y OpenAI Realtime sin romper la política de cierre semántico v9:

```text
conversation_intent
→ CONTINUE
→ response con tools autorizadas del tenant
→ ToolGateway
→ function_call_output
→ respuesta hablada
```
