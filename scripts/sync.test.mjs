import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import { buildSite, deriveKey, selectTemario } from "./sync-cloudflare.mjs";

const NOW = Date.parse("2026-11-01T12:00:00Z");

function catalog(overrides = {}) {
  return {
    periods: [
      { id: "q1", state: "published", resourceIds: ["t1", "t2-old", "t2-new", "e1"] },
      { id: "q2", state: "scheduled", publishAt: "2026-10-15T07:00:00Z", resourceIds: ["t3"] },
      { id: "q3", state: "scheduled", publishAt: "2027-01-15T07:00:00Z", resourceIds: ["t4"] },
      { id: "q4", state: "draft", resourceIds: ["t5"] },
    ],
    topics: [
      { id: "tema-lengua-1", area: "lengua", areaLabel: "Lengua", number: 1, publicTitle: "La comunicación", titleVisible: true, state: "available", order: 1 },
      { id: "tema-lengua-2", area: "lengua", areaLabel: "Lengua", number: 2, publicTitle: "Los enunciados", titleVisible: true, state: "available", order: 2 },
      { id: "tema-lengua-3", area: "lengua", areaLabel: "Lengua", number: 3, publicTitle: "El texto", titleVisible: false, state: "available", order: 3 },
      { id: "tema-lengua-4", area: "lengua", areaLabel: "Lengua", number: 4, publicTitle: "Futuro", titleVisible: true, state: "available", order: 4 },
      { id: "tema-lengua-5", area: "lengua", areaLabel: "Lengua", number: 5, publicTitle: "Borrador", titleVisible: true, state: "available", order: 5 },
      { id: "tema-mates-1", area: "matematicas", areaLabel: "Matemáticas", number: 1, publicTitle: "Oculto", titleVisible: true, state: "hidden", order: 6 },
    ],
    resources: [
      { id: "t1", type: "temario", topicId: "tema-lengua-1", state: "available", file: "materiales/t1/a.pdf", order: 10 },
      { id: "t2-old", type: "temario", topicId: "tema-lengua-2", state: "available", file: "materiales/t2/viejo.pdf", order: 20 },
      { id: "t2-new", type: "temario", topicId: "tema-lengua-2", state: "available", file: "materiales/t2/nuevo.pdf", order: 21 },
      { id: "e1", type: "ejercicio", topicId: "tema-lengua-1", state: "available", file: "materiales/e1/e.pdf", order: 13 },
      { id: "t3", type: "temario", topicId: "tema-lengua-3", state: "available", file: "materiales/t3/c.pdf", order: 30 },
      { id: "t4", type: "temario", topicId: "tema-lengua-4", state: "available", file: "materiales/t4/d.pdf", order: 40 },
      { id: "t5", type: "temario", topicId: "tema-lengua-5", state: "available", file: "materiales/t5/e.pdf", order: 50 },
      ...(overrides.extraResources || []),
    ],
  };
}

test("solo temario visible hoy en el aula: quincena publicada o ya llegada, tema publicado, último por tema", () => {
  const ids = selectTemario(catalog(), NOW).map(({ resource }) => resource.id);
  assert.deepEqual(ids, ["t1", "t2-new", "t3"]);
});

test("si el temario más reciente de un tema aún no es visible, no se filtra el anterior (igual que el aula)", () => {
  const data = catalog();
  data.resources.find((resource) => resource.id === "t2-new").state = "hidden";
  const ids = selectTemario(data, NOW).map(({ resource }) => resource.id);
  assert.ok(!ids.includes("t2-old") && !ids.includes("t2-new"));
});

test("excluye recursos sin archivo, ocultos o con unlockAt futuro", () => {
  const data = catalog();
  data.resources.find((resource) => resource.id === "t1").file = "";
  data.resources.find((resource) => resource.id === "t3").unlockAt = "2027-01-01T00:00:00Z";
  assert.deepEqual(selectTemario(data, NOW).map(({ resource }) => resource.id), ["t2-new"]);
});

async function extract(html) {
  const salt = Uint8Array.from(Buffer.from(html.match(/const SALT = "([^"]+)"/)[1], "base64"));
  const iterations = Number(html.match(/const ITERATIONS = (\d+)/)[1]);
  const manifest = Uint8Array.from(Buffer.from(html.match(/const MANIFEST = "([^"]+)"/)[1], "base64"));
  return { salt, iterations, manifest };
}

const decrypt = (key, data) => webcrypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, key, data.slice(12));

test("el sitio generado solo se lee con la contraseña correcta y no contiene nada en claro", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "respaldo-"));
  const objects = new Map([
    ["materiales/t1/a.pdf", Buffer.from("%PDF-1.4 MARCADOR-SECRETO-T1")],
    ["materiales/t2/nuevo.pdf", Buffer.from("%PDF-1.4 MARCADOR-SECRETO-T2")],
    ["materiales/t3/c.pdf", Buffer.from("%PDF-1.4 MARCADOR-SECRETO-T3")],
  ]);
  const items = await buildSite({ catalog: catalog(), password: "clave-de-prueba", readObject: async (key) => objects.get(key), outDir, now: NOW });
  assert.equal(items.length, 3);

  for (const name of await readdir(outDir)) {
    const content = (await readFile(join(outDir, name))).toString("latin1");
    assert.ok(!content.includes("MARCADOR-SECRETO"), `${name} contiene el PDF en claro`);
    assert.ok(!content.includes("La comunicación") && !content.includes("materiales/"), `${name} filtra títulos o claves de R2`);
  }

  const html = await readFile(join(outDir, "index.html"), "utf8");
  const { salt, iterations, manifest } = await extract(html);

  const wrongKey = await deriveKey("otra-clave", salt, iterations);
  await assert.rejects(decrypt(wrongKey, manifest));

  const key = await deriveKey("clave-de-prueba", salt, iterations);
  const decoded = JSON.parse(new TextDecoder().decode(await decrypt(key, manifest)));
  assert.deepEqual(decoded.map((item) => item.label), [
    "Lengua · Tema 1 — La comunicación",
    "Lengua · Tema 2 — Los enunciados",
    "Lengua · Tema 3",
  ]);
  const file = new Uint8Array(await readFile(join(outDir, decoded[1].file)));
  assert.equal(Buffer.from(await decrypt(key, file)).toString(), "%PDF-1.4 MARCADOR-SECRETO-T2");
  assert.equal(decoded[1].name, "Lengua - Tema 2 - Los enunciados.pdf");
  assert.equal(decoded[0].name, "Lengua - Tema 1 - La comunicacion.pdf");
});
