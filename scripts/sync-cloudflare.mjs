#!/usr/bin/env node
// Lee el catálogo publicado en Cloudflare KV, descarga los PDFs de "temario"
// visibles desde R2 y genera un sitio estático listo para publicar en
// staging/. No toca nada de Cloudflare: solo lee.
import { mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";

const required = ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_KV_NAMESPACE_ID", "CF_R2_BUCKET", "LINK_SALT", "PASSWORD_HASH"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Falta la variable de entorno ${name} (secreto del repo sin configurar)`);
}
const { CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_R2_BUCKET, LINK_SALT, PASSWORD_HASH } = process.env;

const API = "https://api.cloudflare.com/client/v4";

async function cf(path) {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } });
  if (!response.ok) throw new Error(`Cloudflare API ${path} → ${response.status}: ${await response.text()}`);
  return response;
}

function hashFileName(resourceId, extension) {
  const hash = createHash("sha256").update(`${LINK_SALT}:${resourceId}`).digest("hex").slice(0, 24);
  return `${hash}.${extension}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function buildIndexHtml(items) {
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
<div id="gate">
  <form id="form-clave">
    <label for="clave">Contraseña de emergencia</label><br>
    <input id="clave" type="password" required style="padding:8px;font-size:1rem;margin:8px 0;">
    <button type="submit" style="padding:8px 16px;font-size:1rem;">Entrar</button>
  </form>
  <p id="error" hidden style="color:#b42318;">Contraseña incorrecta.</p>
</div>
<div id="lista" hidden></div>
<p style="color:#666;font-size:.85rem;margin-top:40px;">Generado automáticamente el ${new Date().toISOString()}.</p>
<script>
const PASSWORD_HASH = ${JSON.stringify(PASSWORD_HASH)};
const ITEMS = ${JSON.stringify(items)};

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function renderList() {
  const list = document.querySelector("#lista");
  if (!ITEMS.length) {
    list.innerHTML = "<p>No hay temario disponible ahora mismo.</p>";
    return;
  }
  list.innerHTML = ITEMS.map((item) =>
    '<p><a href="' + item.file + '" download>' + item.label + '</a></p>'
  ).join("");
}

document.querySelector("#form-clave").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#clave");
  const hash = await sha256Hex(input.value.trim());
  if (hash === PASSWORD_HASH) {
    document.querySelector("#gate").hidden = true;
    document.querySelector("#lista").hidden = false;
    renderList();
  } else {
    document.querySelector("#error").hidden = false;
  }
});
</script>
</body>
</html>
`;
}

async function main() {
  const catalogResponse = await cf(`/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/catalog`);
  const catalog = await catalogResponse.json();
  const topicsById = new Map(catalog.topics.map((topic) => [topic.id, topic]));

  const temarios = catalog.resources.filter((resource) => {
    if (resource.type !== "temario" || resource.state !== "available" || !resource.file) return false;
    const topic = topicsById.get(resource.topicId);
    return Boolean(topic && topic.state === "available");
  });

  await rm("staging", { recursive: true, force: true });
  await mkdir("staging", { recursive: true });

  const items = [];
  for (const resource of temarios) {
    const topic = topicsById.get(resource.topicId);
    const extension = (resource.file.split(".").pop() || "pdf").toLowerCase().replace(/[^a-z0-9]/g, "") || "pdf";
    const fileName = hashFileName(resource.id, extension);
    const objectResponse = await cf(`/accounts/${CF_ACCOUNT_ID}/r2/buckets/${CF_R2_BUCKET}/objects/${encodeURIComponent(resource.file)}`);
    const buffer = Buffer.from(await objectResponse.arrayBuffer());
    await writeFile(`staging/${fileName}`, buffer);
    const title = topic.titleVisible && topic.publicTitle ? topic.publicTitle : `Tema ${topic.number}`;
    const areaLabel = topic.areaLabel || topic.area;
    items.push({ file: fileName, label: escapeHtml(`${areaLabel} · Tema ${topic.number} — ${title}`), area: topic.area, number: topic.number });
  }
  items.sort((a, b) => a.area.localeCompare(b.area, "es") || a.number - b.number);

  await writeFile("staging/index.html", buildIndexHtml(items));
  await writeFile("staging/.nojekyll", "");
  console.log(`Sincronizados ${items.length} temas de temario.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
