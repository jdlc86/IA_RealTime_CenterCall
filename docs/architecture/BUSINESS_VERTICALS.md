# IA_RealTime_CenterCall — Business Verticals

> **Estado:** decisión arquitectónica vigente  
> **Fecha:** 2026-08-11  
> **Ámbito:** F4 multi-tenant y preparación de F5 persistencia/operaciones empresariales

## 1. Decisión

La plataforma mantiene un **Core común y agnóstico al sector**, pero los negocios no comparten obligatoriamente el mismo modelo operacional.

Se introduce el concepto explícito de **vertical de negocio**:

```text
BusinessType = CLINIC | RESTAURANT
```

`BusinessType` no crea forks del Core. Determina qué módulos de negocio, dominios semánticos, parámetros operacionales y tools pueden ser válidos para un tenant.

## 2. Principio

```text
                    Core común
                        │
        ┌───────────────┴───────────────┐
        │                               │
      CLINIC                         RESTAURANT
        │                               │
 Treatments / Services                 Menu
 Professionals                         Availability
 Appointments                          Reservations
 Patients                              Capacity / party size
```

Se comparte infraestructura cuando la responsabilidad es realmente común; se separa el dominio cuando las reglas empresariales son distintas.

No se permiten condicionales específicos por cliente como `if tenantId === ...`. La variación se expresa por `businessType`, configuración, módulos y allowlists.

## 3. TenantConfiguration

La evolución prevista de `TenantConfiguration` incorpora el vertical de forma explícita:

```ts
type BusinessType = "CLINIC" | "RESTAURANT";

interface TenantConfiguration {
  tenantId: string;
  businessType: BusinessType;
  business: {
    displayName: string;
  };
  assistant: {...};
  realtime: {...};
  tools: {
    allowed: string[];
  };
  verticalConfig: ClinicConfig | RestaurantConfig;
}
```

La migración deberá preservar compatibilidad con la configuración vigente mientras se introduce una siguiente versión de esquema KV. No se hará un cambio destructivo de todos los tenants en un único paso.

## 4. Parámetros comunes

Los siguientes conceptos permanecen comunes a todos los verticales:

- `tenant_id`;
- identidad/nombre del negocio;
- identidad del asistente;
- idioma;
- voz y VAD;
- routing telefónico;
- observabilidad y diagnóstico;
- autorización y allowlist;
- ToolGateway;
- aislamiento multi-tenant;
- políticas de secretos;
- acceso a Supabase mediante adaptadores;
- auditoría;
- reglas comunes de fecha/hora cuando sean reutilizables.

`business_hours` puede ser un concepto compartido, aunque su uso operacional sea diferente según el vertical.

## 5. Vertical CLINIC

Objetivo principal: atención de pacientes y gestión progresiva de servicios clínico-estéticos y agenda.

Dominios previstos:

```text
CLINIC
├── services / treatments
├── professionals
├── business_hours
├── appointment_availability
├── appointments
├── patients
├── treatment_duration
├── prices
└── cancellation/reschedule policies
```

Módulos principales previstos:

```text
BusinessInformationModule
Treatment/ServiceModule
ProfessionalModule
AppointmentModule
PatientModule
```

Tools orientativas:

```text
get_business_information
get_services
get_professionals
get_business_hours
get_appointment_availability
create_appointment
modify_appointment
cancel_appointment
```

Una operación WRITE de cita solo podrá confirmarse después de obtener un resultado válido de la fuente empresarial.

## 6. Vertical RESTAURANT

Objetivo principal: **gestionar reservas de mesa**, además de responder información necesaria para realizarlas correctamente.

Dominios previstos:

```text
RESTAURANT
├── opening_hours
├── menu
├── reservation_availability
├── reservations
├── party_size
├── reservation_date
├── reservation_time
├── capacity
├── area/table preferences
├── dietary_information
└── cancellation_policy
```

Módulos principales previstos:

```text
BusinessInformationModule
MenuModule
ReservationModule
RestaurantAvailabilityModule
```

Tools orientativas:

```text
get_business_information
get_menu
get_business_hours
get_reservation_availability
create_reservation
modify_reservation
cancel_reservation
```

Una reserva de restaurante **no se modelará como una cita clínica renombrada**. `ReservationModule` y `AppointmentModule` son dominios separados porque sus reglas, capacidad, party size, recursos y políticas difieren.

## 7. Router semántico

El router no debe crecer como una lista global de categorías específicas de todos los sectores.

Se adopta conceptualmente una separación entre dominios comunes y dominios habilitados por vertical:

```text
COMMON
├── NONE
├── BUSINESS_INFO
└── HOURS

CLINIC
├── SERVICES
├── PROFESSIONALS
└── APPOINTMENT

RESTAURANT
├── MENU
└── RESERVATION
```

El `businessType` del tenant limita los dominios válidos de la conversación. Un tenant `RESTAURANT` no habilita dominios clínicos y un tenant `CLINIC` no habilita operaciones de reserva de mesa.

La implementación concreta puede evolucionar sin exponer `businessType` al modelo como autoridad de permisos; la autorización final sigue perteneciendo al backend y a ToolGateway.

## 8. ToolGateway y allowlists

ToolGateway continúa siendo la frontera única entre el modelo y las operaciones empresariales.

El vertical define el catálogo potencial de tools, pero la **allowlist del tenant** define cuáles están realmente autorizadas.

Ejemplo conceptual:

```text
CLINIC tenant
  allowed:
    get_services
    get_professionals
    get_business_hours
    get_appointment_availability

RESTAURANT tenant
  allowed:
    get_menu
    get_business_hours
    get_reservation_availability
    create_reservation
```

La existencia de una tool en un vertical no autoriza automáticamente su uso para todos sus tenants.

## 9. Persistencia Supabase

Se compartirán tablas cuando la semántica sea común y se separarán cuando represente operaciones diferentes.

Compartible inicialmente:

```text
tenants
business_hours
audit_events
call_diagnostic_events
```

Vertical CLINIC:

```text
services / treatments
professionals
patients
appointments
```

Vertical RESTAURANT:

```text
menu_items (o catálogo equivalente)
restaurant_reservations
restaurant_capacity / availability cuando el diseño lo requiera
```

No se fuerza una tabla genérica única de `bookings` si ello degrada reglas, constraints o auditoría de cada dominio. La reutilización se realizará en contratos y componentes realmente comunes.

Todas las entidades persistentes multi-tenant deben incluir o derivar de forma confiable `tenant_id`, con aislamiento en aplicación y defensa adicional mediante controles de base de datos/RLS cuando proceda.

## 10. Tenant de prueba F4

Se utiliza el tenant sintético:

```text
restaurante-centro
businessType objetivo: RESTAURANT
```

Su finalidad es validar la separación vertical y el aislamiento multi-tenant sin modificar el comportamiento de producción de `clinica-estetica-madrid`.

Mientras solo exista un número telefónico real, no se reasigna la ruta de la clínica al restaurante. La validación técnica puede realizarse en KV/Supabase y el E2E multi-número queda pendiente hasta disponer de una segunda ruta real.

## 11. Reglas de implementación

1. No introducir forks de aplicación por vertical.
2. No introducir `if tenantId === ...` en Core.
3. `businessType` selecciona capacidades del vertical; ToolGateway/allowlist autoriza operaciones concretas.
4. Separar `AppointmentModule` y `ReservationModule`.
5. Mantener adaptadores externos fuera del dominio.
6. No confirmar reservas/citas sin resultado válido de la fuente de verdad.
7. Toda operación conserva `tenant_id` impuesto por backend.
8. La introducción de `businessType` debe ser compatible con la configuración existente durante la migración.
9. Antes de implementar WRITEs de F5, debe existir un contrato claro para disponibilidad, idempotencia, errores, timeout y auditoría.

## 12. Impacto en roadmap

### F4

F4 no solo valida múltiples tenants; pasa a validar que dos tenants puedan pertenecer a **verticales distintos** sin contaminar configuración, tools ni datos.

### F5

Antes de ampliar persistencia transaccional se implementará la base de verticales. Después:

- CLINIC evolucionará hacia agenda/citas/pacientes;
- RESTAURANT evolucionará prioritariamente hacia disponibilidad y reservas.

### F9

La futura app de gestión reutilizará el mismo `businessType` para presentar módulos y pantallas diferentes por vertical, sin crear backends independientes.

## 13. Criterio de aceptación de esta decisión

La arquitectura queda correctamente aplicada cuando:

```text
Core común permanece agnóstico
+ TenantConfiguration declara el vertical
+ cada vertical tiene dominios propios
+ ToolGateway conserva autorización fail-closed
+ clínica y restaurante no comparten por fuerza operaciones incompatibles
+ datos permanecen aislados por tenant
```
