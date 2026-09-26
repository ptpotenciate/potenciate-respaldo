#!/usr/bin/env node
// Lee el catálogo real (KV), descarga desde R2 el temario que el aula muestra
// hoy y genera en staging/ un sitio estático con TODO cifrado (AES-GCM, clave
// derivada de la contraseña con PBKDF2). El repo es público: sin la contraseña
// solo se ven bytes cifrados. Solo lee de Cloudflare, nunca escribe.
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { subtle } = webcrypto;
export const PBKDF2_ITERATIONS = 600000;

// Misma regla que isReleased() de src/index.js en potenciate-web.
export function isReleased(entity, now) {
  if (entity.state === "published") return true;
  if (entity.state !== "scheduled" || !entity.publishAt) return false;
  const time = Date.parse(entity.publishAt);
  return Number.isFinite(time) && time <= now;
}

// El estado guardado en KV NO es lo que el aula enseña. El Worker recalcula los estados
// cada vez que lee el catálogo (mergePlannedStructure, en src/index.js de potenciate-web):
// manda la quincena, no el estado guardado. Y ese estado solo se reescribe en KV cuando
// alguien guarda algo desde el Admin.
//
// Consecuencia, comprobada contra el catálogo real: una quincena que arranca sola al
// llegar su fecha deja los recursos en KV todavía como "hidden". El aula los enseña —los
// recalcula al leer— y esta página, si creyera el estado guardado, bajaría CERO temas
// justo el día que arranca el curso, que es cuando más falta hace.
//
// Así que aquí se hace lo mismo que el Worker: el estado se deriva de la quincena.
export function normalizarEstados(catalog, now) {
  const copia = structuredClone(catalog);
  const bloqueado = (resource) => resource.type === "solucionario" && resource.unlockAt && Date.parse(resource.unlockAt) > now;
  const porId = new Map(copia.resources.map((resource) => [resource.id, resource]));

  for (const period of copia.periods) {
    const llegada = isReleased(period, now);
    for (const id of period.resourceIds || []) {
      const resource = porId.get(id);
      if (!resource) continue;
      if (llegada && resource.file) resource.state = bloqueado(resource) ? "locked" : "available";
      else resource.state = resource.type === "solucionario" ? "locked" : "hidden";
    }
  }

  // Una sección se abre si le queda algo visible dentro, y se cierra si no. Van las cuatro
  // clases: temas, bloques de sintaxis, prácticas y simulacros. Abrir solo los temas dejaba
  // los simulacros cerrados y no se copiaban las pruebas ni sus soluciones.
  const abiertos = new Set();
  for (const resource of copia.resources) {
    if (resource.state !== "available") continue;
    for (const id of [resource.topicId, resource.practiceId, resource.simulationId, ...(resource.syntaxIds || [])]) {
      if (id) abiertos.add(id);
    }
  }
  for (const lista of [copia.topics, copia.syntaxBlocks, copia.practices, copia.simulations]) {
    for (const item of lista || []) item.state = abiertos.has(item.id) ? "available" : "upcoming";
  }
  return copia;
}

// Qué se copia y qué no.
//
// Todo lo que el aula tenga publicado, MENOS los vídeos. No es una decisión de criterio:
// GitHub rechaza cualquier archivo de más de 100 MiB y sirve como máximo 1 GB por sitio en
// Pages. Los vídeos del curso pesan entre 13 y 296 MiB cada uno —los doce de hoy suman ya
// 1,5 GiB— así que ni el más grande cabría suelto, ni el conjunto entero. La página lo dice
// para que nadie los busque.
const TIPOS_QUE_SE_COPIAN = new Set(["temario", "esquema", "ejercicio", "solucionario", "extra", "prueba", "otro"]);

const ETIQUETA_DE_TIPO = { temario: "Temario", esquema: "Esquema", ejercicio: "Ejercicio", solucionario: "Solucionario", extra: "Ampliación", prueba: "Prueba", otro: "Recurso" };

// Orden en que se presenta dentro de cada sección: el mismo que usa el aula.
const ORDEN_DE_TIPO = { temario: 1, extra: 2, esquema: 3, ejercicio: 4, prueba: 4, solucionario: 5, otro: 6 };

// Igual que resourceIdentity() de src/index.js: dos subidas del mismo material cuentan como
// una sola y gana la última, para no ofrecer el mismo tema dos veces.
function identidad(resource) {
  const contexto = resource.topicId || resource.practiceId || resource.simulationId
    || [...(resource.syntaxIds || [])].sort().join(",") || resource.area || "";
  if (resource.type === "temario" || resource.type === "esquema") return `${contexto}:${resource.type}`;
  const nombre = String(resource.originalName || "").toLocaleLowerCase("es-ES");
  return nombre ? `${contexto}:${resource.type}:${nombre}` : resource.id;
}

// A qué sección pertenece cada recurso y cómo se llama esa sección para la alumna. Solo se
// devuelven las secciones que el aula tiene abiertas.
function seccionesAbiertas(catalog) {
  const secciones = new Map();
  for (const topic of catalog.topics || []) {
    if (topic.state !== "available") continue;
    const titulo = topic.titleVisible && topic.publicTitle ? topic.publicTitle : "";
    secciones.set(topic.id, {
      nombre: `${topic.areaLabel || topic.area} · Tema ${topic.number}${titulo ? ` — ${titulo}` : ""}`,
      orden: [1, topic.order ?? topic.number, 0],
    });
  }
  for (const block of catalog.syntaxBlocks || []) {
    if (block.state !== "available") continue;
    secciones.set(block.id, { nombre: `Sintaxis · ${block.publicTitle || "Bloque"}`, orden: [2, block.order ?? 0, 0] });
  }
  for (const practice of catalog.practices || []) {
    if (practice.state !== "available") continue;
    secciones.set(practice.id, { nombre: `Curso práctico · ${practice.publicTitle || practice.group || ""}`.trim(), orden: [3, practice.order ?? 0, 0] });
  }
  for (const simulation of catalog.simulations || []) {
    if (simulation.state !== "available") continue;
    secciones.set(simulation.id, { nombre: `Simulacro ${simulation.number}`, orden: [4, simulation.number ?? 0, 0] });
  }
  return secciones;
}

// La sección de un recurso. Un recurso de sintaxis puede pertenecer a dos bloques (CD y CI):
// se toma el primero que esté abierto, como hace el aula al listarlo.
function seccionDe(resource, secciones) {
  for (const id of [resource.topicId, resource.practiceId, resource.simulationId, ...(resource.syntaxIds || [])]) {
    if (id && secciones.has(id)) return id;
  }
  return "";
}

// Todo el material que el aula enseña hoy y que se puede copiar aquí. Replica las reglas de
// studentCatalog: quincena ya llegada, sección abierta, con archivo, y una sola copia de
// cada material (la última).
export function selectMaterial(catalogOriginal, now = Date.now()) {
  const catalog = normalizarEstados(catalogOriginal, now);
  const llegadas = new Set(catalog.periods.filter((period) => isReleased(period, now)).map((period) => period.id));
  const quincenaDe = new Map();
  for (const period of catalog.periods) for (const id of period.resourceIds || []) quincenaDe.set(id, period.id);
  const secciones = seccionesAbiertas(catalog);

  const visible = (resource) => {
    if (!TIPOS_QUE_SE_COPIAN.has(resource.type) || !resource.file) return false;
    const quincena = quincenaDe.get(resource.id);
    if (!quincena || !llegadas.has(quincena)) return false;
    if (resource.state !== "available") return false;
    return !resource.unlockAt || Date.parse(resource.unlockAt) <= now;
  };

  // Se deduplica antes de filtrar, igual que el aula: si la última subida de un material no
  // está visible, no se ofrece la anterior en su lugar.
  const ultimas = new Map();
  for (const resource of [...catalog.resources].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    ultimas.set(identidad(resource), resource);
  }

  const seleccion = [];
  for (const resource of ultimas.values()) {
    if (!visible(resource)) continue;
    const seccionId = seccionDe(resource, secciones);
    if (!seccionId) continue;
    seleccion.push({ resource, seccion: secciones.get(seccionId) });
  }

  seleccion.sort((a, b) => {
    for (let i = 0; i < 3; i += 1) {
      const diferencia = (a.seccion.orden[i] || 0) - (b.seccion.orden[i] || 0);
      if (diferencia) return diferencia;
    }
    if (a.seccion.nombre !== b.seccion.nombre) return a.seccion.nombre.localeCompare(b.seccion.nombre, "es");
    return (ORDEN_DE_TIPO[a.resource.type] || 9) - (ORDEN_DE_TIPO[b.resource.type] || 9);
  });
  return seleccion;
}

// El acceso es personal: hace falta el correo con el que está dada de alta, además de la
// contraseña. Y se hace SIN guardar ningún correo en el repositorio, que es público.
//
// Cómo: el material se cifra con una clave maestra aleatoria. Para cada alumna se guarda esa
// clave dentro de un "sobre" cifrado con una clave derivada de SU correo más la contraseña.
// En el repositorio solo hay sobres: bytes indistinguibles entre sí, sin nada que permita
// saber de quién es cada uno ni cuántas alumnas hay de una lista concreta. Al entrar, se
// prueban todos los sobres con la clave que sale de lo que ha escrito; si alguno se abre, es
// que su correo está dado de alta y la contraseña es correcta.
//
// Un hash de los correos habría sido más sencillo, pero un correo se adivina por diccionario
// a partir de su hash, y eso sí serían datos personales en un repositorio público.
export function normalizarCorreo(valor) {
  return String(valor || "").trim().toLocaleLowerCase("es-ES");
}

export async function claveDeAlumna(correo, password, salt, iterations = PBKDF2_ITERATIONS) {
  return deriveKey(`${normalizarCorreo(correo)}
${password}`, salt, iterations);
}

export async function sobresParaAlumnas({ correos, password, claveMaestra, salt, iterations = PBKDF2_ITERATIONS }) {
  const crudo = new Uint8Array(await subtle.exportKey("raw", claveMaestra));
  const sobres = [];
  for (const correo of correos) {
    if (!normalizarCorreo(correo)) continue;
    sobres.push(await encrypt(await claveDeAlumna(correo, password, salt, iterations), crudo));
  }
  // Se desordenan: si fueran en el orden de la base de datos, el orden diría algo.
  for (let i = sobres.length - 1; i > 0; i -= 1) {
    const j = webcrypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [sobres[i], sobres[j]] = [sobres[j], sobres[i]];
  }
  return sobres;
}

export async function deriveKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Clave aleatoria con la que se cifra el material. Va dentro de los sobres, nunca suelta.
export async function nuevaClaveMaestra() {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

// Formato: iv (12 bytes) || texto cifrado AES-GCM.
export async function encrypt(key, bytes) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return out;
}

// Solo ASCII: Chromium ignora el atributo download si el nombre lleva tildes
// y guarda el archivo como "download" sin extensión.
function safeFileName(value) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 ._-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
}

// Extensiones de verdad, con lista cerrada. Coger "lo que venga tras el último punto" no
// vale: muchos archivos subidos desde Drive no tienen extensión, y entonces la clave entera
// de R2 acabab en el nombre de descarga ("Ejercicio.materialesrecurso1790248975958…").
const EXTENSIONES = ["pdf", "doc", "docx", "odt", "ppt", "pptx", "odp", "xls", "xlsx", "txt", "rtf", "zip", "jpg", "jpeg", "png"];

export function extensionDe(resource) {
  for (const candidato of [resource.originalName, resource.file]) {
    const encontrada = String(candidato || "").toLowerCase().match(/.([a-z0-9]{2,5})$/);
    if (encontrada && EXTENSIONES.includes(encontrada[1])) return encontrada[1];
  }
  // Aquí solo se copian documentos, nunca vídeos: si no se sabe, es un PDF.
  return "pdf";
}

export function buildItem(seccion, resource) {
  const extension = extensionDe(resource);
  const tipo = ETIQUETA_DE_TIPO[resource.type] || "Recurso";
  return {
    // El nombre del archivo servido es un hash del id: en un repo público, la lista de
    // nombres ya contaría qué hay publicado y de qué tema.
    file: `${createHash("sha256").update(resource.id).digest("hex").slice(0, 24)}.bin`,
    grupo: seccion.nombre,
    label: tipo,
    name: `${safeFileName(`${seccion.nombre.replace(/ [·—] /g, " - ")} - ${tipo}`)}.${extension}`,
    type: extension === "pdf" ? "application/pdf" : "application/octet-stream",
  };
}

export function buildIndexHtml({ salt, iterations, manifest, sobres, generatedAt }) {
  // Todo va dentro del archivo: ni una fuente, ni una hoja de estilos, ni una imagen de
  // fuera. Esta página se abre justo cuando algo no funciona, así que no puede depender de
  // nada más que de sí misma.
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>Poténciate · Acceso de emergencia</title>
<style>
  :root{--ink:#302326;--muted:#776c6f;--line:#e8e1de;--wash:#f8f5f1;--accent:#9b3d5c;--accent-dark:#6a263e;--soft:#f5e9ed}
  *{box-sizing:border-box}
  body{margin:0;background:var(--wash);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.6}
  .hoja{max-width:680px;margin:0 auto;padding:28px 18px 70px}
  .logo{text-align:center;margin-bottom:22px}
  .logo img{width:min(260px,62%);height:auto;display:inline-block}
  .cabecera{background:linear-gradient(150deg,var(--accent-dark),var(--accent) 70%,#b5567a);color:#fff;border-radius:4px;padding:30px 24px;box-shadow:0 14px 40px rgba(106,38,62,.2)}
  .cabecera h1{font-family:Georgia,"Times New Roman",serif;font-weight:500;font-size:clamp(1.5rem,5vw,2.1rem);line-height:1.2;margin:10px 0 0;text-wrap:balance}
  .cabecera p{margin:12px 0 0;font-size:.97rem;color:rgba(255,255,255,.94)}
  .tarjeta{background:#fff;border:1px solid var(--line);border-radius:4px;padding:22px;margin-top:18px}
  .tarjeta h2{font-family:Georgia,"Times New Roman",serif;font-weight:500;font-size:1.15rem;margin:0 0 6px}
  .tarjeta p{margin:0;color:var(--muted);font-size:.9rem}
  label{display:block;font-size:.74rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:7px}
  input{width:100%;padding:13px 14px;font-size:1.05rem;font-family:inherit;border:1px solid #d9d0cc;border-radius:7px;background:#fff;color:inherit}
  input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
  .principal{margin-top:12px;width:100%;padding:13px 18px;font-size:1rem;font-family:inherit;font-weight:700;border:0;border-radius:7px;background:var(--accent);color:#fff;cursor:pointer}
  .principal:hover{background:var(--accent-dark)}
  .principal:disabled{opacity:.6;cursor:wait}
  .estado{margin:12px 0 0;font-size:.9rem;min-height:1.2em}
  .estado.mal{color:#9b2f3f;font-weight:600}
  .nota{margin-top:16px;padding:12px 14px;border-radius:7px;background:var(--soft);color:var(--accent-dark);font-size:.86rem;line-height:1.55}
  .grupo{margin:26px 0 0}
  .grupo h3{font-family:Georgia,"Times New Roman",serif;font-weight:500;font-size:1.05rem;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid var(--line)}
  .fila{display:flex;flex-wrap:wrap;gap:8px}
  .archivo{flex:1 1 auto;min-width:130px;padding:11px 14px;font-size:.92rem;font-family:inherit;text-align:left;border:1px solid var(--line);border-radius:7px;background:#fff;color:inherit;cursor:pointer}
  .archivo:hover{border-color:var(--accent);color:var(--accent-dark)}
  .archivo:disabled{opacity:.65;cursor:wait}
  .pie{margin-top:34px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:.84rem}
  .pie a{color:var(--accent-dark)}
  .vacio{margin:22px 0 0;padding:18px;border:1px dashed var(--line);border-radius:7px;color:var(--muted);text-align:center;font-size:.92rem}
</style>
</head>
<body>
<div class="hoja">

  <div class="logo"><img src="logo.png" alt="Poténciate" width="260" height="130"></div>

  <header class="cabecera">
    <h1>Sentimos mucho las molestias 🩷</h1>
    <p>El aula está teniendo problemas y estamos trabajando para arreglarlo cuanto antes. Mientras tanto, aquí tienes tu material para seguir estudiando sin perder el ritmo. 💪</p>
  </header>

  <section class="tarjeta">
    <h2>Entra con tus datos 🔑</h2>
    <p>Usa el mismo correo con el que estás dada de alta en el aula, y la contraseña de emergencia que te hemos enviado. Si no la encuentras, escríbenos y te la damos al momento.</p>
    <form id="gate" style="margin-top:16px">
      <label for="correo">Tu correo</label>
      <input id="correo" type="email" autocomplete="email" inputmode="email" required placeholder="el de tu aula">
      <label for="clave" style="margin-top:14px">Contraseña de emergencia</label>
      <input id="clave" type="password" autocomplete="current-password" required>
      <button type="submit" class="principal">Ver mi material</button>
      <p class="estado" id="estado" role="status"></p>
    </form>
    <p class="nota">🔒 Este acceso es personal: solo funciona con tu correo, así que la contraseña no le sirve a nadie más.<br>📄 Está todo el material publicado: temarios, esquemas, ejercicios, soluciones y simulacros.<br>🎬 Los vídeos no están aquí porque no caben, pero los tendrás de vuelta en cuanto el aula funcione.</p>
  </section>

  <div id="lista" hidden></div>

  <p class="pie">
    Material actualizado el ${generatedAt}.<br>
    ¿Algo no te funciona o no tienes la contraseña? Escríbenos a
    <a href="mailto:pt.potenciate@gmail.com">pt.potenciate@gmail.com</a> y te ayudamos enseguida. 🙌
  </p>

</div>
<script>
const SALT = "${salt}";
const ITERATIONS = ${iterations};
const MANIFEST = "${manifest}";
// Un sobre por alumna. Cada uno guarda la clave del material, cifrada con el correo de esa
// alumna más la contraseña. No hay ningún correo aquí: solo bytes, todos iguales por fuera.
const SOBRES = ${JSON.stringify(sobres)};

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const decrypt = (key, data) => crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, key, data.slice(12));

// La clave sale del correo y la contraseña juntos, así que es distinta para cada alumna.
async function claveDeAlumna(correo, password) {
  const frase = correo.trim().toLowerCase() + "\\n" + password;
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(frase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: bytes(SALT), iterations: ITERATIONS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

// Se prueban todos los sobres con esa clave: el que se abra es el suyo, y dentro está la
// clave del material. Abrir un sobre es instantáneo, así que probar diez no se nota.
async function abrirSobre(clavePersonal) {
  for (const sobre of SOBRES) {
    try {
      const crudo = await decrypt(clavePersonal, bytes(sobre));
      return crypto.subtle.importKey("raw", crudo, { name: "AES-GCM" }, false, ["decrypt"]);
    } catch (error) {
      // Ese sobre es de otra alumna: se prueba el siguiente.
    }
  }
  return null;
}

async function download(key, item, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Descargando…";
  try {
    const response = await fetch(item.file, { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const plain = await decrypt(key, new Uint8Array(await response.arrayBuffer()));
    const url = URL.createObjectURL(new Blob([plain], { type: item.type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = item.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    button.textContent = "Descargado ✓";
    setTimeout(() => { button.textContent = original; }, 4000);
  } catch (error) {
    // Cada sincronización cifra con una sal nueva. Si esta página lleva abierta desde antes
    // de la última, su clave ya no vale para los archivos de ahora y hay que recargar.
    const caducada = error instanceof DOMException || /OperationError/i.test(String(error));
    button.textContent = caducada ? "Recarga la página 🔄" : "No se pudo, inténtalo otra vez";
    setTimeout(() => { button.textContent = original; }, 8000);
  } finally {
    button.disabled = false;
  }
}

function render(key, items) {
  const list = document.querySelector("#lista");
  list.hidden = false;
  if (!items.length) {
    list.innerHTML = '<p class="vacio">Todavía no hay material publicado. En cuanto lo haya, aparecerá aquí. 🌱</p>';
    return;
  }

  const titulo = document.createElement("h2");
  titulo.style.cssText = "font-family:Georgia,serif;font-weight:500;font-size:1.4rem;margin:32px 0 0";
  titulo.textContent = "Tu material 📚";
  list.append(titulo);

  // Agrupado por tema, bloque de sintaxis o simulacro: con todo publicado son muchos
  // archivos y una lista seguida no se podría recorrer.
  let grupoActual = "";
  let contenedor = null;
  for (const item of items) {
    if (item.grupo !== grupoActual) {
      grupoActual = item.grupo;
      const bloque = document.createElement("section");
      bloque.className = "grupo";
      const cabecera = document.createElement("h3");
      cabecera.textContent = grupoActual;
      contenedor = document.createElement("div");
      contenedor.className = "fila";
      bloque.append(cabecera, contenedor);
      list.append(bloque);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "archivo";
    button.textContent = "⬇ " + item.label;
    button.addEventListener("click", () => download(key, item, button));
    contenedor.append(button);
  }
}

document.querySelector("#gate").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("#estado");
  const submit = event.target.querySelector("button");
  submit.disabled = true;
  status.className = "estado";
  status.textContent = "Comprobando… 🔓";
  try {
    const clavePersonal = await claveDeAlumna(document.querySelector("#correo").value, document.querySelector("#clave").value.trim());
    const key = await abrirSobre(clavePersonal);
    if (!key) throw new Error("sin acceso");
    const items = JSON.parse(new TextDecoder().decode(await decrypt(key, bytes(MANIFEST))));
    event.target.hidden = true;
    render(key, items);
  } catch (error) {
    status.className = "estado mal";
    // No se puede saber cuál de las dos cosas falla, y tampoco conviene decirlo: así nadie
    // averigua qué correos están dados de alta probándolos uno a uno.
    status.textContent = "No hemos podido entrar. Comprueba que el correo es el mismo de tu aula y que la contraseña está bien escrita. Si sigue sin funcionar, escríbenos. 💬";
    submit.disabled = false;
  }
});
</script>
</body>
</html>
`;
}

// Red de seguridad: si el respaldo anterior tenía material y este no trae ninguno, algo ha
// ido mal (KV a medias, un despiste en el Admin, un token sin permiso de R2). Mejor abortar
// que cambiar una copia buena por una vacía, que es justo la que se necesitaría el día de
// la caída. Devuelve el motivo, o null si se puede publicar.
export function motivoParaNoPublicar({ anteriores, ahora }) {
  if (Number(anteriores) > 0 && Number(ahora) === 0) {
    return `El respaldo anterior tenía ${anteriores} archivo(s) y ahora no sale ninguno. Se aborta sin tocarlo: revisa el catálogo y los permisos del token antes de volver a sincronizar.`;
  }
  return null;
}

// El permiso de R2 del token solo se ejercita cuando hay temario que bajar. Mientras el
// curso no ha arrancado no hay ninguno, así que un token al que le falte ese permiso —o que
// haya caducado— pasaría desapercibido hasta el día que haga falta de verdad.
//
// Para que eso no ocurra se baja un archivo cualquiera del catálogo, solo para ver que R2
// responde, y se descarta. No se publica ni se guarda: es una comprobación, no una copia.
export function primerArchivoDeR2(catalog) {
  return catalog.resources.find((resource) => resource.file && resource.originalName)?.file || "";
}

export async function buildSite({ catalog, password, correos = [], readObject, outDir, now = Date.now() }) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  // El material se cifra con una clave aleatoria, y esa clave viaja dentro de un sobre por
  // alumna. Así el acceso es personal sin guardar ningún correo en el repositorio.
  const claveMaestra = await nuevaClaveMaestra();
  const sobres = await sobresParaAlumnas({ correos, password, claveMaestra, salt });
  if (!sobres.length) {
    throw new Error("No hay ninguna alumna activa a la que dar acceso: se aborta sin publicar, porque nadie podría entrar.");
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const items = [];
  for (const { seccion, resource } of selectMaterial(catalog, now)) {
    const item = buildItem(seccion, resource);
    const bytes = await readObject(resource.file);
    // Si el objeto ya no está en R2, decirlo con nombre y apellidos. Sin esta comprobación
    // el fallo salía como un error de cifrado y no había forma de saber qué archivo era.
    if (!bytes || !bytes.length) throw new Error(`R2 no devolvió contenido para "${seccion.nombre} · ${item.label}". Se aborta sin publicar un respaldo incompleto.`);
    await writeFile(join(outDir, item.file), await encrypt(claveMaestra, bytes));
    items.push(item);
  }
  const manifest = await encrypt(claveMaestra, new TextEncoder().encode(JSON.stringify(items)));
  const generatedAt = new Date(now).toLocaleString("es-ES", { timeZone: "Europe/Madrid", dateStyle: "long", timeStyle: "short" });
  await writeFile(join(outDir, "index.html"), buildIndexHtml({
    salt: Buffer.from(salt).toString("base64"),
    iterations: PBKDF2_ITERATIONS,
    manifest: Buffer.from(manifest).toString("base64"),
    sobres: sobres.map((sobre) => Buffer.from(sobre).toString("base64")),
    generatedAt,
  }));
  await writeFile(join(outDir, ".nojekyll"), "");
  // El logo va junto al sitio, no dentro del HTML: incrustado ocuparía 160 KB de base64 en
  // cada carga, y como archivo aparte el navegador lo guarda una sola vez.
  await copyFile(new URL("../assets/logo.png", import.meta.url), join(outDir, "logo.png"));
  return items;
}

// Los correos de las alumnas activas, de la base de datos. Solo se usan para generar los
// sobres: no se escriben en ningún archivo del sitio.
export async function leerCorreosDeAlumnas({ accountId, databaseId, token }) {
  const respuesta = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql: "SELECT email FROM users WHERE status = 'active' AND email <> ''" }),
  });
  if (!respuesta.ok) {
    throw new Error(`No se pudo leer la lista de alumnas de D1 (${respuesta.status}). Revisa que CF_API_TOKEN tenga el permiso "D1 → Read" y que CF_D1_DATABASE_ID sea correcto.`);
  }
  const datos = await respuesta.json();
  const filas = datos?.result?.[0]?.results || [];
  return filas.map((fila) => fila.email).filter(Boolean);
}

// Quien administra el aula no es una fila de "users": el Worker lo reconoce por ADMIN_EMAIL.
// Sin esto se quedaba sin sobre, y entonces no había forma de comprobar esta página desde
// dentro: ni hoy ni el día de la caída, que es justo cuando hace falta mirarla antes de dar
// la dirección a nadie. Va en su propio sobre, con la misma contraseña.
//
// De paso se quitan los repetidos: dos sobres con la misma clave no dan acceso a nada nuevo
// y harían creer que hay una alumna más de las que hay.
export function conAdministradora({ correos, administradora }) {
  const vistos = new Set();
  const lista = [];
  for (const correo of [...correos, administradora]) {
    const limpio = normalizarCorreo(correo);
    if (!limpio || vistos.has(limpio)) continue;
    vistos.add(limpio);
    lista.push(limpio);
  }
  return lista;
}

async function main() {
  const required = ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_KV_NAMESPACE_ID", "CF_R2_BUCKET", "CF_D1_DATABASE_ID", "FALLBACK_PASSWORD"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Faltan secretos del repo: ${missing.join(", ")}`);
  const { CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_R2_BUCKET, CF_D1_DATABASE_ID, FALLBACK_PASSWORD } = process.env;

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/catalog`, {
    headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
  });
  if (!response.ok) throw new Error(`No se pudo leer el catálogo de KV (${response.status}): ${await response.text()}`);
  const catalog = await response.json();
  // Sin esto, un catálogo vacío o a medias reventaba más abajo con un "cannot read
  // properties of undefined" que no dice nada a quien lea el log.
  for (const campo of ["periods", "topics", "resources"]) {
    if (!Array.isArray(catalog?.[campo])) throw new Error(`El catálogo de KV no trae "${campo}": se aborta sin tocar el respaldo anterior.`);
  }

  const tempFile = join(tmpdir(), "r2-object");
  const readObject = async (key) => {
    execFileSync("wrangler", ["r2", "object", "get", `${CF_R2_BUCKET}/${key}`, "--file", tempFile, "--remote"], {
      // Los logs de Actions son públicos: wrangler imprime la clave de R2 y el bucket.
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, CLOUDFLARE_API_TOKEN: CF_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID },
    });
    const data = await readFile(tempFile);
    await rm(tempFile, { force: true });
    return data;
  };

  // Quién puede entrar. Los correos no se guardan en ningún archivo del sitio: solo sirven
  // para generar los sobres, y de ahí no se pueden recuperar.
  const alumnas = await leerCorreosDeAlumnas({ accountId: CF_ACCOUNT_ID, databaseId: CF_D1_DATABASE_ID, token: CF_API_TOKEN });
  const correos = conAdministradora({ correos: alumnas, administradora: process.env.ADMIN_EMAIL });
  console.log(`Alumnas activas con acceso: ${alumnas.length}.`);
  if (normalizarCorreo(process.env.ADMIN_EMAIL)) {
    console.log("Y un sobre para quien administra: la página se puede comprobar desde dentro.");
  } else {
    console.log("AVISO: falta el secreto ADMIN_EMAIL, así que no podrás abrir esta página para comprobarla.");
  }

  const items = await buildSite({ catalog, password: FALLBACK_PASSWORD, correos, readObject, outDir: "staging" });

  const anteriores = Number(process.env.TEMAS_ANTERIORES || 0);
  const motivo = motivoParaNoPublicar({ anteriores, ahora: items.length });
  if (motivo) throw new Error(motivo);

  // Sin temario que bajar, el permiso de R2 no se ha probado. Se prueba aquí para que un
  // token incompleto se vea hoy en Actions y no el día de la caída.
  if (items.length === 0) {
    const prueba = primerArchivoDeR2(catalog);
    if (!prueba) {
      console.log("Todavía no hay ningún material subido: no se ha podido comprobar el acceso a R2.");
    } else {
      try {
        await readObject(prueba);
        console.log("Acceso a R2 comprobado: el token puede descargar material.");
      } catch (error) {
        throw new Error(`El catálogo se lee bien, pero NO se puede descargar de R2: ${error.message}
Revisa que CF_API_TOKEN tenga el permiso "Workers R2 Storage → Read" y que CF_R2_BUCKET sea el bucket correcto. Sin eso, el día que haya temario esta página quedaría vacía.`);
      }
    }
  }

  console.log(`Material sincronizado: ${items.length} archivo(s)${anteriores ? ` (antes había ${anteriores})` : ""}.`);
}

// Solo se ejecuta si se ha llamado a este archivo directamente. La comprobación de
// process.argv[1] no es de adorno: sin ella, importar el módulo desde un sitio que no pase
// argumentos lo hacía fallar al cargarse, antes de llegar a ninguna función.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
