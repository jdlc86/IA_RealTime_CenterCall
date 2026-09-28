# WhatsApp transaccional mediante Meta

> Estado: canary horizontal desplegado en producción; validaciones técnicas PASS, sin envío real

Despliegue vigente verificado el 2026-09-28 mediante `Gemini Fast Canary Deploy`,
run `36375878767`, sobre el merge SHA
`98b62a4dbf0456b13219cb945b544b67f41a88e6`. La revisión Cloud Run
`gemini-media-edge-00237-neb` fue promovida al 100 % después de pasar health,
paridad de token, bootstrap/HMAC y E2E de la URL general. Esta versión elimina
los fallbacks KV globales y usa exclusivamente la configuración WhatsApp del
tenant.

## Alcance

El Fast Worker puede solicitar a WhatsApp Cloud API de Meta el envío de una
plantilla aprobada. Esta primera fase demuestra el adaptador y su frontera de
seguridad; no conecta todavía una reserva o cita real ni participa en el flujo
de audio.

```text
cliente interno autenticado
  → POST /internal/communications/whatsapp/template-canary
  → capability y configuración tenant
  → allowlist de plantillas
  → adaptador Meta
  → WhatsApp Cloud API
```

El endpoint devuelve `ACCEPTED_BY_META` únicamente cuando Meta responde con un
`message_id`. Sin webhooks, esto no demuestra entrega, lectura ni experiencia
del destinatario.

## Configuración

El secreto `META_WHATSAPP_ACCESS_TOKEN` vive sólo como Worker Secret. Nunca se
guarda en Git, KV, documentación, logs o payloads. Un token publicado debe
revocarse antes de cualquier prueba.

La configuración preferida vive dentro de `tenant_config:<tenant_id>`:

```json
{
  "tenant_id": "<tenant_id>",
  "status": "active",
  "communications": {
    "whatsapp": {
      "phone_number_id": "<meta_phone_number_id>",
      "waba_id": "<meta_waba_id>",
      "default_language": "en_US",
      "allowed_templates": [
        "jaspers_market_plain_text_v1",
        "jaspers_market_order_confirmation_v1"
      ]
    }
  }
}
```

La configuración WhatsApp sólo se acepta desde el documento del tenant. No
existen fallbacks globales `whatsapp.*`. La autorización también es
tenant-bound: `tenant_capabilities:<tenant_id>` debe habilitar explícitamente
`message.whatsapp.transactional`.

`phone_number_id` es el identificador numérico del recurso de Meta, no el
número visible en formato E.164. El destinatario sí se suministra en E.164.

## Contrato de canary

La llamada interna usa el token de control ya empleado por las rutas internas y
un cuerpo limitado:

```json
{
  "tenantId": "<tenant_id>",
  "recipientPhoneE164": "+34000000000",
  "templateName": "jaspers_market_order_confirmation_v1",
  "parameters": ["Nombre", "Referencia", "Fecha"],
  "idempotencyKey": "appointment:<id>:confirmation:v1"
}
```

El Worker no registra el teléfono ni los parámetros. La key de deduplicación se
transforma mediante SHA-256 y el recibo KV conserva sólo `message_id`, timestamp
y nombre de plantilla durante siete días.

Esta deduplicación de canary no es una outbox transaccional: KV no adjudica de
forma atómica carreras concurrentes ni resuelve un timeout incierto después de
que Meta haya aceptado el mensaje. Por tanto el endpoint no debe conectarse a
una operación productiva de citas hasta disponer de outbox durable, claim
atómico y reconciliación por webhook.

## Plantillas iniciales

- `jaspers_market_plain_text_v1`: cuerpo fijo; no lleva `components`.
- `jaspers_market_order_confirmation_v1`: tres parámetros `text` en el body.

Los nombres son configuración del tenant, no conocimiento del kernel. El
adaptador acepta cualquier plantilla incluida en la allowlist y mantiene el
contenido vertical fuera del Core.

## Siguiente fase

1. Rotar cualquier token previamente expuesto y verificar sólo su presencia.
2. Desplegar el adaptador mediante el workflow integral existente.
3. Ejecutar una única prueba autorizada con un destinatario de prueba.
4. Añadir verificación de firma y estados de entrega mediante webhooks de Meta.
5. Crear una outbox durable y enlazarla al commit real de la futura tool de
   citas. El envío ocurrirá después del commit y fuera del hot path de voz.
