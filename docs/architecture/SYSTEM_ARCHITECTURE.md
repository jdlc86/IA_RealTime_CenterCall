# IA_RealTime_CenterCall — arquitectura del sistema

> Arquitectura oficial v4.0
> Estado: vigente
> Decisión aplicable: [ADR-004](./ADR-004-GEMINI-ULTRA-LOW-LATENCY-FAST-PATH.md)

## 1. Topología

```text
                         ┌─────────────────────────────┐
Telnyx webhook ─────────►│ Gemini Fast Worker          │
                         │ Cloudflare                  │
                         │ admission / tenant / tools  │
                         │ security / transfer / audit │
                         └─────────────┬───────────────┘
                                       │ bootstrap/control
                                       │ nunca audio continuo
                                       ▼
Caller ─ PSTN ─ Telnyx media WSS ◄──► Fast Media Edge ◄──► Gemini Live
```

## 2. Responsabilidades

### Gemini Fast Worker

- validar firma y evento Telnyx;
- resolver número llamado, tenant y configuración;
- evaluar caller-security antes de admission;
- emitir identidad y credencial efímera;
- registrar bootstrap/capabilities;
- autorizar tools y transferencia;
- ejecutar reloj/contexto autoritativo;
- persistir diagnóstico seguro y señales sideband.

### Fast Media Edge

- autenticar credencial y bootstrap;
- mantener los WebSockets Telnyx y Gemini;
- transportar audio con buffers acotados;
- gobernar tool calls mediante policy y recibos;
- coordinar reproducción, barge-in y cierre local;
- enviar diagnóstico mínimo fuera del forwarding continuo.

### Supabase

- fuente de verdad durable para reputación, auditoría, handoff y dominio;
- RPCs y constraints atómicos;
- RLS/ACL y retención según política.

## 3. Contrato de tools

Toda tool declara:

```text
name + closed schema + authority + effect + capability + evidence
+ tenant/call context + allowed handler
```

Las mutaciones añaden idempotencia, confirmación e invariantes de negocio.
Una propuesta del modelo no constituye autorización. El kernel emite un recibo
opaco, de un solo contexto, que el sink debe verificar antes del efecto.

## 4. Estado y escalado

Credential, bootstrap y sesión activa son call-scoped e in-memory. Hasta migrar
esa autoridad a almacenamiento compartido atómico:

- `max-instances=1`;
- no se promete balanceo multiinstancia;
- no se elimina el guard de single instance;
- el audio permanece local, sin RTT de base de datos por chunk.

## 5. Despliegue

`Gemini Fast Canary Deploy` es la única autoridad. Orden obligatorio:

1. test y build de imagen inmutable;
2. revisión etiquetada sin tráfico;
3. readiness y preflights autenticados;
4. sincronización del Worker con esa revisión;
5. retirada de tags obsoletos;
6. promoción de la revisión verificada;
7. E2E sintético sobre la URL general.

No existe workflow o script alternativo de producción.

## 6. Retiradas

El producto anterior, el prototipo DO/control WSS, el Media Edge genérico,
sidecars STT/TTS y el benchmark de selección de hosting están fuera del árbol.
Git es el archivo histórico; no se mantienen copias ejecutables obsoletas.
