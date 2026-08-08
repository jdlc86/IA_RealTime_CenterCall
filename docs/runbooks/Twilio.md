# Runbook — Twilio

## Objetivo F0

```text
PSTN → número Twilio → Elastic SIP Trunk → OpenAI Realtime
```

## Configuración

1. Cuenta Twilio activa.
2. Número con capacidad de voz.
3. Elastic SIP Trunk.
4. Origination SIP URI apuntando al endpoint SIP de OpenAI Realtime.
5. Número asociado al trunk.
6. Baseline de codec compatible con F0: PCMU/G.711 μ-law.

## Diagnóstico

Si la llamada no llega a OpenAI:

1. comprobar que el número recibe la llamada;
2. comprobar asociación número ↔ trunk;
3. revisar Origination URI;
4. revisar logs SIP de Twilio;
5. verificar que el endpoint OpenAI se copió sin modificaciones.

La configuración Twilio-specific debe permanecer fuera del dominio de aplicación.
