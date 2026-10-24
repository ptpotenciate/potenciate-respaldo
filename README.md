# Poténciate · Página de emergencia

Solo sirve para que las alumnas puedan **descargar el material ya publicado**
si la web principal (Cloudflare) no funciona o su operadora la bloquea (ver «El portero»). No es bonita a propósito: es un
respaldo, no la web real.

## Qué se copia y qué no

Se copia **todo lo que el aula tenga publicado**: temarios, esquemas,
ejercicios, solucionarios ya desbloqueados, ampliaciones, y las pruebas de los
simulacros con sus soluciones. Agrupado por tema, por bloque de sintaxis, por
curso práctico y por simulacro, igual que en el aula.

**Los vídeos no.** No es una decisión de criterio: GitHub rechaza cualquier
archivo de más de 100 MiB y sirve como máximo 1 GB por sitio en Pages. Los
vídeos del curso pesan entre 13 y 296 MiB cada uno —solo los doce de hoy suman
1,5 GiB—, así que ni el más grande cabría suelto ni el conjunto entero. La página
lo dice para que nadie los busque.

## Cómo funciona

- **`Sincronizar temario desde Cloudflare`** corre cada noche (y se puede
  lanzar a mano). Lee el catálogo real y descarga el mismo material que el
  aula enseña ese día, sin vídeos. Lo guarda **cifrado** en la rama `data`.
- **`Activar página de emergencia`** copia lo último sincronizado a
  `gh-pages` (en `/respaldo/`), que es lo que sirve GitHub Pages. Un clic.
- **`Desactivar página de emergencia`** deja `/respaldo/` con un aviso de
  "No disponible" y sin archivos. Otro clic.
- **`Publicar el portero`** publica o actualiza el portero sin cambiar si el
  respaldo está activado o no.

Se lanzan desde la pestaña **Actions** de este repo (o la app de GitHub en
el móvil) → eliges el workflow → **Run workflow**.

## Quién puede entrar

Hace falta **el correo con el que la alumna está dada de alta en el aula, más la
contraseña de emergencia**. La contraseña sola no sirve: si se la pasa a una
amiga, la amiga no entra.

Y se consigue **sin guardar ningún correo en este repositorio**, que es público.
El material se cifra con una clave aleatoria, y esa clave se guarda dentro de un
"sobre" por alumna, cifrado con su correo más la contraseña. En el repositorio
solo hay sobres: bytes iguales por fuera, sin nada que diga de quién es cada uno.
Al entrar se prueban todos con lo que la alumna ha escrito; si alguno se abre, es
que su correo está de alta y la contraseña es buena.

Guardar los correos con hash habría sido más simple, pero un correo se adivina
por diccionario a partir de su hash, y eso sí serían datos personales en un repo
público. Hay un test que comprueba que no queda ni un correo en ningún archivo.

La lista sale de la base de datos en cada sincronización, así que **al dar de alta
o de baja a una alumna no hay que tocar nada aquí**: al día siguiente ya está.
Si quieres que valga desde ya, lanza la sincronización a mano.

### Por qué va cifrado

Este repo es público: cualquiera puede ver todas sus ramas en github.com,
incluidas `data` y `gh-pages`. Por eso los PDF y la lista de material se
guardan cifrados (AES-256-GCM, con una clave derivada de la contraseña con
PBKDF2-SHA256, 600.000 iteraciones). Sin la contraseña solo hay bytes sin
sentido. La página descifra en el navegador de la alumna cuando la escribe.

Consecuencia: **desactivar quita la página, pero no borra la copia cifrada**
de la rama `data` (tiene que existir para poder reactivar cuando Cloudflare
esté caído). Quien tenga la contraseña podría descifrarla aunque la página
esté desactivada, así que si la contraseña circula de más, cámbiala (abajo).

## El portero (aula.potenciateoposiciones.com)

Durante los partidos de fútbol, las operadoras españolas bloquean direcciones de Cloudflare, y
con ellas el aula, **solo en las conexiones afectadas** (puede que en casa vaya y en el móvil no).
El portero es una página que vive aquí, en GitHub Pages (fuera de Cloudflare, así que ese bloqueo
no le afecta), y es la dirección que se da a las alumnas para entrar:

- Al abrirla, **desde el propio dispositivo de la alumna**, comprueba si el aula responde
  (`/cdn-cgi/trace`, que contesta Cloudflare sin tocar el Worker). Si responde, la lleva al aula.
- Si no responde (bloqueo, conexión cortada o sin internet), enseña qué hacer: **descargar el
  material** (`/respaldo/`, esta misma página de emergencia), **entregar el simulacro por correo**
  a simulacros@, volver a comprobar (lo hace sola cada 30 s) o usar otra red / la app 1.1.1.1.
- Ya dentro del respaldo (`/respaldo/`), la página **vuelve a comprobar cada 45 segundos** si el
  aula responde y, en cuanto responde, enseña arriba un aviso verde con el botón «Volver al aula».
  No cambia de página sola: la alumna puede estar a medias de una descarga.
- No pide ninguna contraseña. `?demo=bloqueada` enseña la pantalla del bloqueo sin esperar a un
  partido.

La dirección de siempre, `potenciateoposiciones.com/aula`, sigue funcionando, pero está en
Cloudflare y es justo la que bloquean: nada que se ponga allí puede redirigir durante un bloqueo.
Por eso el portero tiene su propia dirección, lo más parecida posible
(`aula.potenciateoposiciones.com`), y hay que pedir a las alumnas que la guarden.

Estructura publicada en `gh-pages`: `/` el portero, `/respaldo/` la página de emergencia (activa o
el aviso «No disponible»), `/CNAME`. La monta `scripts/montar-pages.mjs`; **Activar**,
**Desactivar** y **Publicar el portero** la usan, así que el portero está siempre y lo único que
cambia es lo que hay en `/respaldo/`.

### Puesta en marcha (una sola vez)

1. **DNS** (Cloudflare → potenciateoposiciones.com → DNS → Records → Add record):
   tipo `CNAME`, nombre `aula`, destino `ptpotenciate.github.io`, y **proxy desactivado
   («Solo DNS», nube gris)**. Con la nube naranja pasaría por Cloudflare y se bloquearía igual.
2. Actions → **Publicar el portero** → Run workflow.
3. Settings → Pages: debe poner el dominio `aula.potenciateoposiciones.com`; espera a que el
   comprobador de DNS salga en verde y marca **Enforce HTTPS** (el certificado tarda de unos
   minutos a una hora).
4. Para que «Descargar mi material» funcione durante un bloqueo, el respaldo tiene que estar
   **activo**: Actions → **Activar página de emergencia**. Con el portero ya no hace falta
   apagarlo (sigue pidiendo correo + contraseña de emergencia, y los datos cifrados ya eran
   públicos en la rama `data`). Si lo dejas apagado, el botón llevará al aviso «No disponible».
5. Abre `https://aula.potenciateoposiciones.com/` en el móvil y prueba también
   `https://aula.potenciateoposiciones.com/?demo=bloqueada`.

Al poner el dominio propio, la dirección antigua `ptpotenciate.github.io/potenciate-respaldo/`
pasa a redirigir al portero.

## Qué se comprueba sola cada noche

La sincronización no solo copia: también avisa si algo está mal antes de que
haga falta el respaldo.

- **No sustituye una copia buena por una vacía.** Si ayer había temario y hoy no
  sale ninguno, el workflow falla y deja intacto el respaldo anterior. Así un
  fallo de una noche no te deja sin nada el día de la caída.
- **Comprueba el acceso a R2 aunque no haya nada que bajar.** El permiso de R2
  del token solo se usa cuando hay temario; mientras el curso no arranca, un
  token mal configurado no se notaría. Se prueba a propósito para que salte hoy
  en Actions y no el día que importa.
- **Valida el catálogo.** Si KV devuelve algo incompleto, aborta con un mensaje
  claro en vez de generar un respaldo a medias.
- **No se fía del estado guardado en KV.** El Worker recalcula qué está visible
  cada vez que lee el catálogo, pero en KV ese estado solo se reescribe cuando
  guardas algo en el Admin. Una quincena que arranca sola por fecha deja KV con
  los recursos aún en "oculto": esta página deriva la visibilidad de la
  quincena, igual que el aula, para no quedarse vacía justo cuando arranca el
  curso.

## Configuración de una sola vez

### 1. Secretos (Settings → Secrets and variables → Actions → New repository secret)

Ninguno de estos valores se escribe en este repo.

| Nombre | Qué es |
|---|---|
| `CF_API_TOKEN` | Token de Cloudflare **nuevo y de solo lectura**, con tres permisos: `Account → Workers KV Storage → Read`, `Account → Workers R2 Storage → Read` y `Account → D1 → Read`, limitado a la cuenta del proyecto. Se crea en https://dash.cloudflare.com/profile/api-tokens → *Create Token* → *Create Custom Token*. No reutilizar las credenciales de subida del Admin. |
| `CF_ACCOUNT_ID` | Account ID de Cloudflare (en `wrangler.jsonc` del repo principal, `R2_ACCOUNT_ID`). |
| `CF_KV_NAMESPACE_ID` | Id del namespace KV del catálogo (en `wrangler.jsonc`, `kv_namespaces` → `id`). |
| `CF_R2_BUCKET` | Nombre del bucket R2 (en `wrangler.jsonc`, `R2_BUCKET_NAME`). |
| `CF_D1_DATABASE_ID` | Id de la base de datos D1 (en `wrangler.jsonc`, `d1_databases` → `database_id`). De ahí sale la lista de alumnas con acceso. |
| `FALLBACK_PASSWORD` | La contraseña de emergencia que se da a las alumnas. |

### 2. Primer uso, en este orden

1. Actions → `Sincronizar temario desde Cloudflare` → Run workflow. Si
   falla, el log dice qué secreto falta o qué permiso no tiene el token.
2. Actions → `Activar página de emergencia` → Run workflow (crea la rama
   `gh-pages`).
3. Settings → Pages → *Build and deployment* → Source: **Deploy from a
   branch** → Branch: `gh-pages` / `(root)` → Save. A los ~2 minutos aparece
   ahí la URL (`https://ptpotenciate.github.io/potenciate-respaldo/`).
4. Abre la URL, prueba la contraseña y descarga un tema.
5. Actions → `Desactivar página de emergencia` → Run workflow. Queda apagada
   hasta que haga falta.

## Cambiar la contraseña

1. Settings → Secrets → `FALLBACK_PASSWORD` → Update.
2. Lanza `Sincronizar…` (vuelve a cifrar todo con la nueva).
3. Si la página estaba activa, lanza `Activar…` otra vez.

## Aviso de GitHub

GitHub desactiva las tareas programadas de un repo público si pasan 60 días
sin actividad. La sincronización nocturna hace un commit en `data` cada día,
así que no debería pasar, pero si ves un aviso amarillo en Actions diciendo
que el workflow está desactivado, pulsa *Enable workflow*.
