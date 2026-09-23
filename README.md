# Poténciate · Página de emergencia

Solo sirve para que las alumnas puedan **descargar el temario ya publicado**
si la web principal (Cloudflare) no funciona. No es bonita a propósito: es un
respaldo, no la web real.

## Cómo funciona

- **`Sincronizar temario desde Cloudflare`** corre cada noche (y se puede
  lanzar a mano): lee el catálogo real (KV) y descarga los PDFs de "temario"
  que estén publicados desde R2, y deja un sitio listo en la rama `data`
  (rama interna, no publicada, nadie puede verla desde fuera).
- **`Activar página de emergencia`**: publica lo último sincronizado en
  `gh-pages` (la que de verdad se sirve al público). Un clic.
- **`Desactivar página de emergencia`**: sustituye `gh-pages` por un aviso
  vacío sin archivos. Otro clic. Así el enlace no queda abierto todo el
  tiempo.

Todo esto se lanza desde la pestaña **Actions** de este repo (o desde la app
de GitHub en el móvil) → eliges el workflow → **Run workflow**. No hace
falta terminal ni ordenador.

## Configuración de una sola vez (pendiente)

### 1. Secretos (Settings → Secrets and variables → Actions → New repository secret)

Ninguno de estos valores va escrito en este repo (es público) — los reales
están solo en el chat de la sesión que montó esto, o hay que generarlos de
nuevo con las instrucciones de abajo.

| Nombre | Qué es |
|---|---|
| `CF_API_TOKEN` | Token de Cloudflare de **solo lectura**: permisos `Workers KV Storage: Read` y `Workers R2 Storage: Read`, limitado a la cuenta del proyecto. Se crea en https://dash.cloudflare.com/profile/api-tokens → *Create Token* → *Custom token*. **No reutilizar** el token/credenciales de subida del Admin: este debe ser nuevo y solo de lectura. |
| `CF_ACCOUNT_ID` | El Account ID de Cloudflare del proyecto (el mismo que usa `wrangler.jsonc` en el repo principal, campo `R2_ACCOUNT_ID`). |
| `CF_KV_NAMESPACE_ID` | El id del namespace KV `CONTENT` (en `wrangler.jsonc` del repo principal, sección `kv_namespaces`). |
| `CF_R2_BUCKET` | El nombre del bucket R2 (en `wrangler.jsonc` del repo principal, campo `R2_BUCKET_NAME`). |
| `LINK_SALT` | Un valor aleatorio cualquiera (solo hace que los nombres de archivo no se puedan adivinar). Se puede generar con `openssl rand -hex 16`. |
| `FALLBACK_PASSWORD_HASH` | El hash SHA-256 de la contraseña de emergencia. Si hace falta cambiarla más adelante: `printf '%s' 'la-nueva-contraseña' | sha256sum`, y ese resultado es el nuevo valor del secreto. |

La contraseña de emergencia (la que se les da a las alumnas) **no se guarda
en este repo**, solo su hash SHA-256 como secreto — así puede seguir siendo
público sin que nadie la pueda leer del código. Compártela por
WhatsApp/correo junto con el enlace de la página, dejando claro que
**no es la contraseña de su cuenta del aula**, es una aparte, solo para
este respaldo.

### 2. Activar GitHub Pages (una vez)

Settings → Pages → *Build and deployment* → Source: **Deploy from a branch**
→ Branch: `gh-pages` / `(root)` → Save.

(La rama `gh-pages` no existe todavía — aparecerá sola la primera vez que se
lance `Activar página de emergencia` o `Sincronizar…`. Si el desplegable no
la ofrece todavía, lanza primero `Sincronizar temario desde Cloudflare` y
luego `Activar página de emergencia` una vez, y vuelve a Settings → Pages.)

### 3. Primer uso

1. Lanza manualmente `Sincronizar temario desde Cloudflare` (Actions → ese
   workflow → Run workflow) para comprobar que los secretos están bien.
2. Lanza `Activar página de emergencia` para publicarla y comprobar que
   carga, pide la contraseña y lista el temario.
3. Lanza `Desactivar página de emergencia` para dejarla apagada — así queda
   normalmente, hasta que haga falta de verdad.
