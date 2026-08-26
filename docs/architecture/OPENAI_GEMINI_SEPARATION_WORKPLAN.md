# Plan de trabajo — separación OpenAI / Gemini

> **Estado:** ACTIVO  
> **Fecha de inicio:** 2026-08-26  
> **ADR autoridad:** [`ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md`](./ADR-003-INDEPENDENT-OPENAI-GEMINI-RUNTIMES.md)  
> **Rama única:** `rebuild/v39-stable-baseline`  
> **PR único:** `#85`

## Objetivo

Transformar la integración híbrida actual en **dos productos realtime independientes y eficientes**:

- producto OpenAI con Worker/runtime propios, optimizados para OpenAI Realtime;
- producto Gemini con Worker/runtime propios, optimizados para Gemini Live;
- Supabase y contratos de dominio compartidos en esta fase;
- sin obligación de coexistencia simultánea de ambos productos para un mismo cliente;
- sin failover entre proveedores durante una llamada.

El código existente es evidencia histórica y funcional, **no especificación arquitectónica**. Una pieza no se conserva únicamente porque ya exista o porque hoy esté en el Worker principal.

## Principio de evaluación

Toda pieza inspeccionada se clasifica por **propósito real**, no por ubicación actual.

Etiquetas obligatorias:

- `SHARED_DOMAIN` — dominio/persistencia/contrato realmente neutral al proveedor.
- `OPENAI_NATIVE` — runtime o comportamiento específico de OpenAI que sigue siendo necesario y razonable.
- `GEMINI_NATIVE` — runtime o comportamiento específico de Gemini que debe vivir en el producto Gemini.
- `LEGACY_COMPAT_REDESSIGN` — compatibilidad histórica, abstracción artificial, duplicación de ownership o diseño que debe reevaluarse aunque hoy funcione.
- `UNRESOLVED` — no hay evidencia suficiente todavía; no mover ni borrar hasta resolver.

Para cada componente se debe registrar:

1. ruta / símbolo principal;
2. responsabilidad actual;
3. problema que resuelve;
4. proveedor o motivo de origen cuando pueda demostrarse;
5. dependencias entrantes/salientes relevantes;
6. estado mutable que posee;
7. latencia o pasos adicionales que introduce en camino crítico;
8. tests que prueban su necesidad;
9. clasificación;
10. acción propuesta: `KEEP`, `MOVE`, `EXTRACT`, `REWRITE`, `DELETE_LATER`, `INVESTIGATE`.

## Arquitectura objetivo

```text
                         SUPABASE COMPARTIDO
                    estado empresarial persistente
                               ▲       ▲
                               │       │
                     contratos de dominio
                         ▲             ▲
                         │             │
              ┌──────────┘             └──────────┐
              │                                   │
     OPENAI PRODUCT                      GEMINI PRODUCT
     --------------                      --------------
     OpenAI Worker                       Gemini Worker
     OpenAI runtime                      Gemini runtime
     OpenAI lifecycle                    Gemini lifecycle
     OpenAI tool flow                    Gemini tool flow
     OpenAI audio/voz                    Gemini audio/voz
              │                                   │
       OpenAI Realtime                  Gemini Media Edge
                                                  │
                                             Gemini Live
```

La separación física de Workers es la dirección aprobada. El Media Edge Gemini sigue siendo un servicio separado cuando el transporte continuo de audio lo requiera.

## Reglas durante la refactorización

1. No crear nuevas ramas ni PRs; usar únicamente `rebuild/v39-stable-baseline` y PR #85.
2. No merge, no ready-for-review, no force-push, no reescritura de historia.
3. No continuar corrigiendo defectos del camino híbrido salvo que:
   - bloqueen la propia separación;
   - afecten también al producto OpenAI independiente;
   - o exista evidencia de que el código sobrevivirá a la nueva arquitectura.
4. No copiar automáticamente lógica del Worker actual al Worker Gemini.
5. No considerar el Worker actual como diseño óptimo de OpenAI; también será auditado y simplificado después.
6. No borrar hardening útil sólo porque fue descubierto durante el trabajo Gemini. Seguridad, concurrencia, diagnóstico y reglas de negocio se conservan si son realmente generales.
7. No compartir orchestration conversacional por obligación. La reutilización se justifica después, con evidencia.
8. Supabase permanece único en esta fase. La base compartida no implica runtime compartido.
9. Una futura topología con N bases deberá preservar los mismos contratos y requerirá decisión posterior.
10. Cada fase debe dejar este documento actualizado para relevo entre sesiones.

---

# Fases y progreso

## Fase 0 — Decisión y documentación

**Objetivo:** congelar la nueva dirección antes de modificar runtime.

- [x] ADR-003 creado y aceptado.
- [x] Dos sistemas realtime independientes definidos.
- [x] Dos Workers separados fijados como arquitectura objetivo.
- [x] Gemini Media Edge conservado como servicio específico Gemini.
- [x] Supabase único compartido en esta fase.
- [x] No coexistencia simultánea por cliente declarada fuera del requisito actual.
- [x] Futuro N-Supabase reconocido como evolución posterior por contratos.
- [x] Limpieza posterior del Worker OpenAI incluida como fase explícita.
- [x] Plan operativo/checklist persistente creado.
- [ ] `SESSION_HANDOFF.md` actualizado para apuntar a ADR-003 y este plan.
- [ ] `PROJECT_STATUS.md` actualizado para declarar obsoleto el plan híbrido G1–G5 como dirección de producto.

**Criterio de salida:** cualquier sesión nueva entiende que no debe seguir perfeccionando el runtime híbrido.

## Fase 1 — Inventario arquitectónico del sistema actual

**Estado:** PENDIENTE / PRÓXIMA FASE.

**Objetivo:** saber qué existe realmente antes de mover código.

### 1A. Topología y entrypoints

- [ ] Enumerar `apps/`, `packages/`, Workers, servicios y entrypoints efectivos.
- [ ] Identificar Worker productivo actual y sus bindings/configuración.
- [ ] Identificar Gemini Media Edge, endpoints y responsabilidades.
- [ ] Identificar pipelines CI/deploy que hoy mezclan responsabilidades.

### 1B. Inventario del Control Plane / Worker actual

- [ ] Catalogar archivos/símbolos de lifecycle conversacional.
- [ ] Catalogar response coordination / response ownership.
- [ ] Catalogar turn ownership / concurrency / watchdogs.
- [ ] Catalogar OpenAI adapters y wire handling.
- [ ] Catalogar Gemini branches, sideband, bootstrap y adapters dentro del Worker.
- [ ] Catalogar ToolGateway y herramientas empresariales.
- [ ] Catalogar reservas, horarios, identidad y autorización.
- [ ] Catalogar persistencia y Supabase adapters.
- [ ] Catalogar observabilidad/diagnóstico.
- [ ] Catalogar Telnyx neutral vs Telnyx específico de un producto.

### 1C. Inventario Gemini Media Edge

- [ ] Conexión Telnyx Media Streaming.
- [ ] Conexión Gemini Live.
- [ ] VAD/STT/input authority.
- [ ] semantic preselection/tool gate.
- [ ] playback/mark/clear.
- [ ] governed speech/TTS actual.
- [ ] reconnect/session rotation.
- [ ] sideband/control-plane coupling.
- [ ] diagnóstico y health/E2E.

### 1D. Clasificación

- [ ] Etiquetar cada pieza `SHARED_DOMAIN` / `OPENAI_NATIVE` / `GEMINI_NATIVE` / `LEGACY_COMPAT_REDESSIGN` / `UNRESOLVED`.
- [ ] Registrar dependencias cruzadas que impiden separación física.
- [ ] Identificar owners duplicados o abstracciones que traducen OpenAI↔Gemini artificialmente.
- [ ] Identificar piezas en camino crítico que añaden latencia o saltos evitables.
- [ ] Identificar tests que preservan comportamiento valioso frente a tests que sólo preservan arquitectura histórica.

**Entregable:** `docs/architecture/PROVIDER_RUNTIME_INVENTORY.md`.

**Criterio de salida:** ninguna migración estructural empieza hasta que las dependencias críticas estén clasificadas.

## Fase 2 — Diseño detallado del producto Gemini independiente

**Estado:** BLOQUEADA por Fase 1.

- [ ] Definir entrypoint del Gemini Worker.
- [ ] Definir estado/lifecycle Gemini desde semántica real de Gemini Live.
- [ ] Definir frontera Gemini Worker ↔ Gemini Media Edge.
- [ ] Definir tool flow y post-tool continuation Gemini nativos.
- [ ] Definir barge-in/input detection/reconnect Gemini.
- [ ] Definir estrategia de una sola identidad vocal por sesión.
- [ ] Definir interacción con dominio/Supabase compartidos.
- [ ] Definir observabilidad y correlación Gemini.
- [ ] Definir secretos/bindings propios Gemini.
- [ ] Definir CI y E2E Gemini independientes.
- [ ] Revisar qué código existente se puede reutilizar sin importar semántica OpenAI.

**Entregable:** diseño implementable del Worker Gemini y contratos con Media Edge.

## Fase 3 — Construcción y migración Gemini

**Estado:** BLOQUEADA por Fase 2.

- [ ] Crear Worker Gemini en la rama existente.
- [ ] Migrar sólo piezas `GEMINI_NATIVE` aprobadas.
- [ ] Reescribir piezas `LEGACY_COMPAT_REDESSIGN` cuando sean necesarias para Gemini.
- [ ] Conectar dominio/Supabase compartidos por contratos explícitos.
- [ ] Eliminar dependencia runtime de OpenAI en el producto Gemini.
- [ ] Garantizar que pipeline Gemini no requiere secretos OpenAI.
- [ ] E2E: saludo, conversación, reserva multi-turno, herramientas, alternativas, confirmación, barge-in, cierre, reconexión.
- [ ] E2E: una sola identidad vocal durante toda la llamada.

**Criterio de salida:** Gemini funciona como producto autónomo sin runtime/credenciales OpenAI.

## Fase 4 — Limpieza y optimización del producto OpenAI

**Estado:** BLOQUEADA hasta que Gemini independiente esté probado.

**Objetivo:** no dejar el Worker OpenAI como fósil de la integración híbrida.

- [ ] Inventariar toda referencia Gemini restante en el Worker OpenAI.
- [ ] Retirar sideband/bootstrap/configuración Gemini que ya no pertenezca a OpenAI.
- [ ] Retirar branches de provider y adapters creados sólo por convivencia híbrida.
- [ ] Retirar secretos/bindings Gemini del deploy OpenAI.
- [ ] Revisar coordinadores/owners introducidos por compatibilidad histórica.
- [ ] Simplificar caminos OpenAI cuando la semántica real de OpenAI permita menos capas.
- [ ] Conservar hardening general demostrado: seguridad, concurrencia, dominio, diagnóstico, confirmación backend, etc.
- [ ] Verificar que OpenAI compila y despliega sin paquete/runtime Gemini.
- [ ] E2E completo OpenAI después de limpieza.

**Criterio de salida:** producto OpenAI eficiente y autónomo, no simplemente “el Worker viejo sin Gemini”.

## Fase 5 — Separación operacional

- [ ] CI OpenAI independiente.
- [ ] CI Gemini independiente.
- [ ] Deploy OpenAI independiente.
- [ ] Deploy Gemini independiente.
- [ ] Secretos/bindings segregados.
- [ ] Health/readiness separados.
- [ ] Runbooks separados.
- [ ] Diagnóstico en Supabase identifica inequívocamente producto/runtime/deployment.

## Fase 6 — Evolución futura (fuera de alcance actual)

- [ ] Coexistencia simultánea de productos para un mismo cliente, sólo si aparece requisito real.
- [ ] Selección/failover entre providers, sólo mediante ADR específico.
- [ ] N proyectos/bases Supabase manteniendo contratos de persistencia.
- [ ] Packaging/comercialización por cliente y automatización de provisioning.

---

# Registro de trabajo

Este apartado se actualiza al cerrar cada bloque significativo. No sustituye Git ni `PROJECT_STATUS.md`; sirve para continuidad entre sesiones.

## 2026-08-26 — Cambio de paradigma aprobado

**Completado:**

- Se abandona como objetivo la orquestación realtime universal OpenAI/Gemini.
- Se aprueban dos productos con dos Workers independientes.
- Supabase permanece compartido durante esta fase.
- Se decide no invertir más esfuerzo en defectos del runtime híbrido que vayan a desaparecer con la separación.
- Se declara que el código actual no es necesariamente óptimo ni siquiera para OpenAI; será auditado posteriormente.
- Se formaliza ADR-003.
- Se crea este plan/checklist.

**Siguiente acción exacta:**

1. actualizar `SESSION_HANDOFF.md` y `PROJECT_STATUS.md` para que ninguna sesión continúe el plan híbrido anterior;
2. comenzar Fase 1 creando `PROVIDER_RUNTIME_INVENTORY.md` a partir de evidencia del repositorio, sin mover runtime todavía.

## Cómo debe trabajar una sesión posterior

Al comenzar:

1. verificar HEAD remoto, PR #85 y estado de CI;
2. leer ADR-003;
3. leer este plan;
4. leer `SESSION_HANDOFF.md` y `PROJECT_STATUS.md` vigentes;
5. localizar la primera casilla pendiente de la fase activa;
6. trabajar sólo esa frontera con evidencia;
7. actualizar este checklist antes de cerrar la sesión;
8. registrar commit/SHA y siguiente acción exacta.

No reabrir decisiones marcadas como aprobadas salvo nueva evidencia que obligue a un ADR posterior.
