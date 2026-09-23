#!/usr/bin/env node
// Lee el catálogo real (KV), descarga desde R2 el temario que el aula muestra
// hoy y genera en staging/ un sitio estático con TODO cifrado (AES-GCM, clave
// derivada de la contraseña con PBKDF2). El repo es público: sin la contraseña
// solo se ven bytes cifrados. Solo lee de Cloudflare, nunca escribe.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

// Replica lo que el aula enseña de temario por tema (studentCatalog): solo el
// temario más reciente de cada tema, y solo si está disponible, con archivo,
// en una quincena ya publicada y con el tema publicado.
export function selectTemario(catalog, now = Date.now()) {
  const releasedPeriodIds = new Set(catalog.periods.filter((period) => isReleased(period, now)).map((period) => period.id));
  const periodByResource = new Map();
  for (const period of catalog.periods) for (const id of period.resourceIds || []) periodByResource.set(id, period);
  const visible = (resource) => {
    const period = periodByResource.get(resource.id);
    if (!period || !releasedPeriodIds.has(period.id) || !resource.file) return false;
    if (resource.state !== "available") return false;
    return !resource.unlockAt || Date.parse(resource.unlockAt) <= now;
  };
  const selected = [];
  for (const topic of [...catalog.topics].sort((a, b) => a.order - b.order)) {
    if (topic.state !== "available") continue;
    const temarios = catalog.resources.filter((resource) => resource.topicId === topic.id && resource.type === "temario").sort((a, b) => a.order - b.order);
    const latest = temarios.at(-1);
    if (latest && visible(latest)) selected.push({ topic, resource: latest });
  }
  return selected;
}

export async function deriveKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
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

export function buildItem(topic, resource) {
  const extension = (resource.file.split(".").pop() || "pdf").toLowerCase().replace(/[^a-z0-9]/g, "") || "pdf";
  const areaLabel = topic.areaLabel || topic.area;
  const title = topic.titleVisible && topic.publicTitle ? topic.publicTitle : "";
  return {
    file: `${createHash("sha256").update(resource.id).digest("hex").slice(0, 24)}.bin`,
    label: `${areaLabel} · Tema ${topic.number}${title ? ` — ${title}` : ""}`,
    name: `${safeFileName(`${areaLabel} - Tema ${topic.number}${title ? ` - ${title}` : ""}`)}.${extension}`,
    type: extension === "pdf" ? "application/pdf" : "application/octet-stream",
  };
}

export function buildIndexHtml({ salt, iterations, manifest, generatedAt }) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Poténciate · Acceso de emergencia</title>
</head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5;">
<h1>Poténciate — Temario (acceso de emergencia)</h1>
<p>Usa esta página <strong>solo si la web principal no funciona</strong>. No tiene el diseño normal a propósito: es un respaldo de solo descarga.</p>
<form id="gate">
  <label for="clave">Contraseña de emergencia</label><br>
  <input id="clave" type="password" autocomplete="current-password" required style="padding:8px;font-size:1rem;margin:8px 0;">
  <button type="submit" style="padding:8px 16px;font-size:1rem;">Entrar</button>
  <p id="estado" role="status"></p>
</form>
<div id="lista" hidden></div>
<p style="color:#666;font-size:.85rem;margin-top:40px;">Temario actualizado el ${generatedAt}.</p>
<script>
const SALT = "${salt}";
const ITERATIONS = ${iterations};
const MANIFEST = "${manifest}";

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const decrypt = (key, data) => crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, key, data.slice(12));

async function deriveKey(password) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: bytes(SALT), iterations: ITERATIONS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
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
    setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 60000);
    button.textContent = original;
  } catch (error) {
    button.textContent = "No se pudo descargar, inténtalo de nuevo";
  } finally {
    button.disabled = false;
  }
}

function render(key, items) {
  const list = document.querySelector("#lista");
  list.hidden = false;
  if (!items.length) {
    list.textContent = "No hay temario disponible ahora mismo.";
    return;
  }
  for (const item of items) {
    const row = document.createElement("p");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.style.cssText = "padding:8px 12px;font-size:1rem;text-align:left;";
    button.addEventListener("click", () => download(key, item, button));
    row.append(button);
    list.append(row);
  }
}

document.querySelector("#gate").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("#estado");
  const submit = event.target.querySelector("button");
  submit.disabled = true;
  status.textContent = "Comprobando…";
  try {
    const key = await deriveKey(document.querySelector("#clave").value.trim());
    const items = JSON.parse(new TextDecoder().decode(await decrypt(key, bytes(MANIFEST))));
    event.target.hidden = true;
    render(key, items);
  } catch (error) {
    status.textContent = "Contraseña incorrecta.";
    submit.disabled = false;
  }
});
</script>
</body>
</html>
`;
}

export async function buildSite({ catalog, password, readObject, outDir, now = Date.now() }) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const items = [];
  for (const { topic, resource } of selectTemario(catalog, now)) {
    const item = buildItem(topic, resource);
    await writeFile(join(outDir, item.file), await encrypt(key, await readObject(resource.file)));
    items.push(item);
  }
  const manifest = await encrypt(key, new TextEncoder().encode(JSON.stringify(items)));
  const generatedAt = new Date(now).toLocaleString("es-ES", { timeZone: "Europe/Madrid", dateStyle: "long", timeStyle: "short" });
  await writeFile(join(outDir, "index.html"), buildIndexHtml({
    salt: Buffer.from(salt).toString("base64"),
    iterations: PBKDF2_ITERATIONS,
    manifest: Buffer.from(manifest).toString("base64"),
    generatedAt,
  }));
  await writeFile(join(outDir, ".nojekyll"), "");
  return items;
}

async function main() {
  const required = ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_KV_NAMESPACE_ID", "CF_R2_BUCKET", "FALLBACK_PASSWORD"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Faltan secretos del repo: ${missing.join(", ")}`);
  const { CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_R2_BUCKET, FALLBACK_PASSWORD } = process.env;

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/catalog`, {
    headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
  });
  if (!response.ok) throw new Error(`No se pudo leer el catálogo de KV (${response.status}): ${await response.text()}`);
  const catalog = await response.json();

  const tempFile = join(tmpdir(), "r2-object");
  const readObject = async (key) => {
    execFileSync("wrangler", ["r2", "object", "get", `${CF_R2_BUCKET}/${key}`, "--file", tempFile, "--remote"], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, CLOUDFLARE_API_TOKEN: CF_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID },
    });
    const data = await readFile(tempFile);
    await rm(tempFile, { force: true });
    return data;
  };

  const items = await buildSite({ catalog, password: FALLBACK_PASSWORD, readObject, outDir: "staging" });
  console.log(`Temario sincronizado: ${items.length} tema(s).`);
  for (const item of items) console.log(` - ${item.label}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
