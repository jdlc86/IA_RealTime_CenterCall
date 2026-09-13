# Límite horizontal de funciones PostgreSQL

> Estado: `SEC-P1-05` desplegado y verificado en producción
> Última revisión: 2026-09-13

## Propósito

Este control aplica a cualquier capacidad que añada funciones PostgreSQL al
esquema expuesto. No contiene reglas de reservas, clínica, WhatsApp ni otro
negocio. Las verticales declaran sus funciones y consumen la política común.

## Componentes

`Security/database-function-boundaries.json` es la fuente única de perfiles y
funciones administradas. Las migraciones de activación retiran el permiso de
ejecución predeterminado de funciones futuras creadas por `postgres`. El cierre
tiene dos capas necesarias: una revocación global para eliminar el grant implícito
de PostgreSQL a `PUBLIC`, y otra limitada al esquema `public` para eliminar los
grants directos que Supabase configura para `anon`, `authenticated` y
`service_role`. El manifiesto y el gate exigen ambas capas, de modo que cada
función nueva debe optar explícitamente por uno de los perfiles permitidos.

El validador `scripts/check-database-function-boundaries.mjs` conserva una lista
cerrada de nombres heredados y administra toda función pública que no pertenezca
a esa base, incluso si una migración nueva usa una fecha anterior por error. Cada
función administrada debe:

- indicar el esquema `public` de forma explícita;
- declarar `search_path=''` en su cabecera;
- registrar una firma, un perfil y la capacidad propietaria;
- usar `SECURITY INVOKER`, salvo perfil privilegiado justificado;
- conceder `EXECUTE` exactamente a los roles de su perfil;
- revocar antes todos los roles administrados para que `CREATE OR REPLACE` no
  conserve permisos heredados;
- documentar el modelo de autorización si acepta un rol cliente.

## Perfiles

| Perfil | Ejecución directa | Modo permitido | Uso |
|---|---|---|---|
| `internal_server` | `service_role` | invoker | backend y adaptadores server-side |
| `privileged_server` | `service_role` | definer | operación privilegiada justificada |
| `public_rpc` | `authenticated` | invoker | API cliente con autorización explícita |
| `trigger` | ninguna | invoker | ejecución exclusiva por trigger |
| `admin` | ninguna | definer | mantenimiento por propietario de base |

## Adopción del legado

Las funciones creadas antes de la migración de activación figuran sólo como una
lista cerrada de nombres y no se vuelven a analizar en cada PR. Se adoptan
mediante cambios independientes por capacidad,
después de recuperar sus definiciones reproducibles y verificar consumidores.
Esta separación evita que el control transversal dependa de una vertical y evita
fallos al reconstruir una base nueva.

## Pruebas sin repetición

El workflow transversal ejecuta una sola prueba sin instalar dependencias. Los
workflows de Media Edge y Control Plane conservan la propiedad de sus suites
completas. El runner de seguridad focalizado queda disponible para diagnóstico
local, pero CI no repite esas suites.

## Verificación posterior al despliegue

Despliegue completado el 2026-09-13 mediante las migraciones registradas
`20260913193440` y `20260913193454`. `pg_default_acl` confirma que las capas
global y `public` conservan únicamente a `postgres`; las funciones existentes
no fueron alteradas.

1. consultar `pg_default_acl` y confirmar las revocaciones global y del esquema
   `public` para las funciones nuevas;
2. ejecutar los advisors de seguridad;
3. comprobar que no cambió el ACL efectivo de funciones ya existentes;
4. no realizar una llamada real, porque la migración no toca el runtime de voz.

## Recuperación

La reversión debe usar una migración posterior que restaure los privilegios por
defecto. No se modifica una migración aplicada. Las entradas del manifiesto se
mantienen mientras existan sus funciones para que CI detecte cualquier deriva.
