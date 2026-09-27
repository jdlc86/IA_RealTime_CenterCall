# Autoridad temporal horizontal

> Estado: capability Fast existente; Core neutral extraído y validado localmente
> Última revisión: 2026-09-27

## Propósito

Proporcionar un único dueño del reloj actual, calendario y zona horaria del
tenant sin confiar en el conocimiento temporal del modelo. Es una capacidad
horizontal: clínica, restaurante y futuros verticales consumen el mismo contrato.

## Ownership y fronteras

| Responsabilidad | Owner |
|---|---|
| Validar zona IANA y construir snapshot | `apps/gemini-control-plane/src/kernel/temporal-authority.ts` |
| Cargar configuración KV, autenticar control y adaptar a Fast | `apps/gemini-control-plane/src/fast-temporal-authority.ts` |
| Declaración de tool | `get_authoritative_datetime` / `time.authoritative` |
| Cliente de control y validación del resultado | `apps/gemini-media-edge/src/fast-temporal-control.mjs` |
| Interpretar “mañana”, “esta tarde”, etc. | Gemini, anclado al snapshot del kernel |
| Horarios, horizonte, capacidad y disponibilidad | vertical de negocio |

El Core no conoce Gemini, Media Edge, `businessType`, reservas, citas ni tenants
concretos. El adapter Fast conserva el wire existente y sus nombres de
compatibilidad; no se ha creado una segunda tool.

## Flujo

```text
tenant config → zona IANA validada → reloj Worker → snapshot inicial de bootstrap
                                                  └→ refresh on-demand autenticado
                                                     cuando el turno necesita “ahora”
```

El resultado contiene `source=WORKER_CLOCK`, zona, epoch capturado, ISO con
offset, fecha local, hora local y día de la semana. Un resultado más reciente
sustituye el snapshot inicial sólo para el turno correlacionado.

## Fallo seguro

- una zona inválida falla cerrada;
- una configuración no activa o con tenant inconsistente falla cerrada;
- el endpoint interno exige bearer token y contexto tenant/call;
- el Media Edge no usa su reloj local como fallback;
- Gemini debe explicar la indisponibilidad y no inventar fecha/hora ni
  materializar una referencia relativa dependiente del momento actual.

## Latencia

La extracción neutral es una refactorización de funciones puras y no cambia el
wire. El snapshot inicial ya forma parte del bootstrap. El refresh es una tool
read-only on-demand, no una operación de audio: no añade trabajo por chunk,
persistencia ni inferencia. Cualquier futura consulta durable o hop adicional
requiere ADR, presupuesto y p50/p95/p99.

## Configuración

La zona se obtiene, por orden de compatibilidad, de
`business.timezone`, `business.time_zone` o `timezone`. Si no está declarada, la
compatibilidad actual usa `Europe/Madrid`. Una migración futura puede exigir zona
explícita, pero no debe cambiarse silenciosamente para tenants existentes.

## Validación

Desde `apps/gemini-control-plane`:

```bash
npx vitest run src/kernel/temporal-authority.test.ts \
  src/fast-temporal-authority.test.ts \
  src/telnyx/fast-canary-route.test.ts \
  src/telnyx/fast-tenant-config.test.ts
npm run typecheck
```

La suite neutral demuestra que configuraciones de clínica, restaurante y retail
usan la misma resolución sin branch de `businessType`, que dos zonas producen
fechas locales correctas para el mismo instante y que una zona inválida falla
cerrada.

## Criterio para añadir un vertical

Un vertical nuevo reutiliza este anclaje y aporta únicamente sus políticas:
horario comercial, días no operativos, horizonte máximo, duración, capacidad e
invariantes transaccionales. No copia el cálculo de zona, no consulta el reloj
del modelo y no renombra la tool.
