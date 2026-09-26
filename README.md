# Poténciate · Página de emergencia

Solo sirve para que las alumnas puedan **descargar el temario ya publicado**
si la web principal (Cloudflare) no funciona. No es bonita a propósito: es un
respaldo, no la web real.

## Cómo funciona

- **`Sincronizar temario desde Cloudflare`** corre cada noche (y se puede
  lanzar a mano). Lee el catálogo real y descarga el mismo temario que el
  aula enseña ese día (tema publicado, quincena ya abierta, último temario de
  cada tema). Lo guarda **cifrado** en la rama `data`.
- **`Activar página de emergencia`** copia lo último sincronizado a
  `gh-pages`, que es lo que sirve GitHub Pages. Un clic.
- **`Desactivar página de emergencia`** deja `gh-pages` con un aviso de
  "No disponible" y sin archivos. Otro clic.

Se lanzan desde la pestaña **Actions** de este repo (o la app de GitHub en
el móvil) → eliges el workflow → **Run workflow**.

### Por qué va cifrado

Este repo es público: cualquiera puede ver todas sus ramas en github.com,
incluidas `data` y `gh-pages`. Por eso los PDFs y la lista de temas se
guardan cifrados (AES-256-GCM, con una clave derivada de la contraseña con
PBKDF2-SHA256, 600.000 iteraciones). Sin la contraseña solo hay bytes sin
sentido. La página descifra en el navegador de la alumna cuando la escribe.

Consecuencia: **desactivar quita la página, pero no borra la copia cifrada**
de la rama `data` (tiene que existir para poder reactivar cuando Cloudflare
esté caído). Quien tenga la contraseña podría descifrarla aunque la página
esté desactivada, así que si la contraseña circula de más, cámbiala (abajo).

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
| `CF_API_TOKEN` | Token de Cloudflare **nuevo y de solo lectura**, con dos permisos: `Account → Workers KV Storage → Read` y `Account → Workers R2 Storage → Read`, limitado a la cuenta del proyecto. Se crea en https://dash.cloudflare.com/profile/api-tokens → *Create Token* → *Create Custom Token*. No reutilizar las credenciales de subida del Admin. |
| `CF_ACCOUNT_ID` | Account ID de Cloudflare (en `wrangler.jsonc` del repo principal, `R2_ACCOUNT_ID`). |
| `CF_KV_NAMESPACE_ID` | Id del namespace KV del catálogo (en `wrangler.jsonc`, `kv_namespaces` → `id`). |
| `CF_R2_BUCKET` | Nombre del bucket R2 (en `wrangler.jsonc`, `R2_BUCKET_NAME`). |
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
