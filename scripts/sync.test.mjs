import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import { buildSite, claveDeAlumna, deriveKey, extensionDe, motivoParaNoPublicar, normalizarCorreo, primerArchivoDeR2, selectMaterial } from "./sync-cloudflare.mjs";

const CORREOS = ["Maria.Lopez@example.com", "paula@example.com", "ana@example.com"];

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

test("todo el material visible hoy en el aula: quincena llegada, sección abierta, último por material", () => {
  const ids = selectMaterial(catalog(), NOW).map(({ resource }) => resource.id);
  // Agrupado por tema y, dentro, temario antes que ejercicio. t2-old no sale porque t2-new
  // es la subida más reciente del mismo material.
  assert.deepEqual(ids, ["t1", "e1", "t2-new", "t3"]);
});

test("los vídeos no se copian: no caben en GitHub", () => {
  // No es criterio: GitHub rechaza archivos de más de 100 MiB y sirve 1 GB por sitio. Un
  // solo vídeo del curso pasa de 100 MiB y los de hoy suman 1,5 GiB.
  const data = catalog();
  data.resources.push({ id: "v1", type: "video", topicId: "tema-lengua-1", state: "available", file: "materiales/v1/clase.mp4", order: 11 });
  data.periods[0].resourceIds.push("v1");

  const ids = selectMaterial(data, NOW).map(({ resource }) => resource.id);

  assert.equal(ids.includes("v1"), false);
});

test("si el temario más reciente de un tema aún no es visible, no se filtra el anterior (igual que el aula)", () => {
  // "No visible" tiene que venir de algo que el Worker no revierta: aquí, quedarse sin
  // archivo. Marcarlo "hidden" no vale, porque en el aula la quincena manda sobre el
  // estado guardado (ver normalizarEstados) y volvería a salir.
  const data = catalog();
  data.resources.find((resource) => resource.id === "t2-new").file = "";
  const ids = selectMaterial(data, NOW).map(({ resource }) => resource.id);
  assert.ok(!ids.includes("t2-old") && !ids.includes("t2-new"));
});

test("una quincena que arranca sola por fecha se sincroniza aunque KV tenga los estados viejos", () => {
  // El caso que de verdad importa y que falló contra el catálogo real: el Worker recalcula
  // los estados al leer, pero en KV solo se reescriben cuando alguien guarda desde el
  // Admin. El día que arranca el curso, KV tiene los recursos todavía en "hidden" y el
  // aula los enseña igual. Si esta página creyera ese estado, bajaría cero temas justo
  // cuando hace falta.
  const data = catalog();
  for (const resource of data.resources) resource.state = "hidden";
  for (const topic of data.topics) topic.state = "upcoming";

  const ids = selectMaterial(data, NOW).map(({ resource }) => resource.id);

  assert.deepEqual(ids, ["t1", "e1", "t2-new", "t3"], "lo mismo que con los estados al día");
});

test("lo de una quincena que todavía no ha llegado no se sincroniza nunca", () => {
  // Al contrario: aunque KV diga "available" por un estado obsoleto, si la quincena no ha
  // llegado no puede salir. Esta página no debe adelantar material.
  const data = catalog();
  for (const resource of data.resources) resource.state = "available";
  for (const topic of data.topics) topic.state = "available";

  const ids = selectMaterial(data, NOW).map(({ resource }) => resource.id);

  assert.equal(ids.includes("t4"), false, "t4 está en una quincena de enero de 2027");
  assert.equal(ids.includes("t5"), false, "t5 está en una quincena en borrador");
});

test("excluye recursos sin archivo y con unlockAt futuro", () => {
  const data = catalog();
  data.resources.find((resource) => resource.id === "t1").file = "";
  data.resources.find((resource) => resource.id === "e1").file = "";
  // unlockAt solo frena a los solucionarios, igual que en el aula.
  const t3 = data.resources.find((resource) => resource.id === "t3");
  t3.type = "solucionario";
  t3.unlockAt = "2027-01-01T00:00:00Z";
  assert.deepEqual(selectMaterial(data, NOW).map(({ resource }) => resource.id), ["t2-new"]);
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
    ["materiales/e1/e.pdf", Buffer.from("%PDF-1.4 MARCADOR-SECRETO-E1")],
    ["materiales/t2/nuevo.pdf", Buffer.from("%PDF-1.4 MARCADOR-SECRETO-T2")],
    ["materiales/t3/c.pdf", Buffer.from("%PDF-1.4 MARCADOR-SECRETO-T3")],
  ]);
  const items = await buildSite({ catalog: catalog(), password: "clave-de-prueba", correos: CORREOS, readObject: async (key) => objects.get(key), outDir, now: NOW });
  assert.equal(items.length, 4);

  for (const name of await readdir(outDir)) {
    const content = (await readFile(join(outDir, name))).toString("latin1");
    assert.ok(!content.includes("MARCADOR-SECRETO"), `${name} contiene el PDF en claro`);
    assert.ok(!content.includes("La comunicación") && !content.includes("materiales/"), `${name} filtra títulos o claves de R2`);
  }

  const html = await readFile(join(outDir, "index.html"), "utf8");
  const { salt, iterations, manifest } = await extract(html);

  // La contraseña sola ya no abre nada: hace falta un correo dado de alta.
  const soloClave = await deriveKey("clave-de-prueba", salt, iterations);
  await assert.rejects(decrypt(soloClave, manifest));

  const key = await abrirConCorreo(html, "maria.lopez@example.com", "clave-de-prueba");
  const decoded = JSON.parse(new TextDecoder().decode(await decrypt(key, manifest)));
  assert.deepEqual(decoded.map((item) => `${item.grupo} · ${item.label}`), [
    "Lengua · Tema 1 — La comunicación · Temario",
    "Lengua · Tema 1 — La comunicación · Ejercicio",
    "Lengua · Tema 2 — Los enunciados · Temario",
    "Lengua · Tema 3 · Temario",
  ]);
  const file = new Uint8Array(await readFile(join(outDir, decoded[1].file)));
  assert.equal(Buffer.from(await decrypt(key, file)).toString(), "%PDF-1.4 MARCADOR-SECRETO-E1");
  // El nombre con el que se guarda va sin tildes: Chromium ignora el atributo download si
  // las lleva y el archivo acaba como "download", sin extensión.
  assert.equal(decoded[0].name, "Lengua - Tema 1 - La comunicacion - Temario.pdf");
  assert.equal(decoded[1].name, "Lengua - Tema 1 - La comunicacion - Ejercicio.pdf");
});

test("no se sustituye un respaldo con temario por uno vacío", () => {
  // El peor fallo posible de esta página: que una sincronización mala se lleve por delante
  // la última copia buena, y que nadie se entere hasta el día de la caída.
  assert.match(motivoParaNoPublicar({ anteriores: 8, ahora: 0 }), /se aborta sin tocarlo/i);

  // Lo normal sí pasa: crecer, mantenerse, o empezar de cero.
  assert.equal(motivoParaNoPublicar({ anteriores: 8, ahora: 9 }), null);
  assert.equal(motivoParaNoPublicar({ anteriores: 8, ahora: 8 }), null);
  assert.equal(motivoParaNoPublicar({ anteriores: 0, ahora: 0 }), null, "al principio del curso todavía no hay temario");
  assert.equal(motivoParaNoPublicar({ anteriores: 0, ahora: 3 }), null);
});

test("hay con qué comprobar el acceso a R2 aunque no haya temario visible", () => {
  // Si no se comprobara, un token sin permiso de R2 pasaría desapercibido mientras el curso
  // no ha arrancado, y la página quedaría vacía justo el día que hiciera falta.
  const data = catalog();
  for (const resource of data.resources) resource.originalName = "algo.pdf";
  assert.match(primerArchivoDeR2(data), new RegExp("^materiales/"));

  // Y si de verdad no hay nada subido todavía, no se inventa una clave.
  const vacio = catalog();
  for (const resource of vacio.resources) resource.file = "";
  assert.equal(primerArchivoDeR2(vacio), "");
});

test("si R2 no devuelve un archivo, se aborta diciendo cuál", async () => {
  // Antes salía como un error de cifrado, sin decir qué archivo faltaba, y era imposible
  // saber qué arreglar.
  const outDir = await mkdtemp(join(tmpdir(), "respaldo-falta-"));
  await assert.rejects(
    () => buildSite({ catalog: catalog(), password: "x", correos: CORREOS, readObject: async () => undefined, outDir, now: NOW }),
    /R2 no devolvió contenido para "Lengua · Tema 1/,
  );
});

test("también se copian simulacros y sintaxis, no solo temas", () => {
  // Al principio solo se abrían los temas, así que las pruebas de los simulacros y los
  // ejercicios de sintaxis se quedaban fuera aunque el aula los enseñara. Con el catálogo
  // real eran 12 archivos de menos de 49.
  const data = catalog();
  data.simulations = [{ id: "sim-1", number: 1, state: "upcoming", order: 1 }];
  data.syntaxBlocks = [{ id: "sx-cd", publicTitle: "Complemento directo", state: "upcoming", order: 1 }];
  data.practices = [{ id: "pr-1", publicTitle: "Morfología", group: "Curso", state: "upcoming", order: 1 }];
  data.resources.push(
    { id: "p1", type: "prueba", simulationId: "sim-1", syntaxIds: [], state: "hidden", file: "materiales/p1/prueba.pdf", order: 60 },
    { id: "x1", type: "ejercicio", syntaxIds: ["sx-cd"], state: "hidden", file: "materiales/x1/cd.pdf", order: 61 },
    { id: "c1", type: "ejercicio", practiceId: "pr-1", syntaxIds: [], state: "hidden", file: "materiales/c1/morfo.pdf", order: 62 },
  );
  data.periods[0].resourceIds.push("p1", "x1", "c1");

  const seleccion = selectMaterial(data, NOW);
  const ids = seleccion.map(({ resource }) => resource.id);

  assert.ok(ids.includes("p1"), "la prueba del simulacro");
  assert.ok(ids.includes("x1"), "el ejercicio de sintaxis");
  assert.ok(ids.includes("c1"), "el ejercicio del curso práctico");

  // Y cada uno con su sección bien puesta, que es lo que ve la alumna.
  const seccionDe = (id) => seccion(seleccion, id);
  assert.equal(seccionDe("p1"), "Simulacro 1");
  assert.equal(seccionDe("x1"), "Sintaxis · Complemento directo");
  assert.equal(seccionDe("c1"), "Curso práctico · Morfología");
});

function seccion(seleccion, id) {
  return seleccion.find(({ resource }) => resource.id === id)?.seccion.nombre;
}

test("el nombre de descarga acaba en una extensión de verdad", () => {
  // En Drive muchos archivos se subieron sin extensión, así que "lo que venga tras el
  // último punto" metía la clave entera de R2 en el nombre:
  // "Ejercicio.materialesrecurso1790248975958…ejerciciosteman1mate".
  assert.equal(extensionDe({ file: "materiales/x/2026/uuid-EJERCICIOS TEMA Nº1 MATE", originalName: "EJERCICIOS TEMA Nº1 MATE" }), "pdf");
  assert.equal(extensionDe({ file: "materiales/x/a.pdf", originalName: "a.pdf" }), "pdf");
  assert.equal(extensionDe({ file: "materiales/x/uuid-sin-punto", originalName: "hoja.docx" }), "docx");
  // Un punto dentro del nombre no es una extensión.
  assert.equal(extensionDe({ file: "materiales/x/EJERCICIO SINTAXIS - C.PRED", originalName: "EJERCICIO SINTAXIS - C.PRED" }), "pdf");
});

test("del catálogo solo sale el material: nada de lo interno se publica", async () => {
  // El catálogo lleva cosas que no son de las alumnas: las pautas de corrección, los
  // solucionarios en texto plano, el calendario interno, descripciones de trabajo y los
  // identificadores de Drive. Este repo es público, así que conviene comprobarlo cada vez:
  // es lo que se rompe el día que alguien añada un campo nuevo al catálogo.
  const data = catalog();
  data.correccion = { pautas: "MARCA-PAUTAS", solucionarios: { 1: "MARCA-SOLUCIONARIO" } };
  data.internalCalendar = { title: "MARCA-CALENDARIO-INTERNO", file: "materiales/interno/MARCA-CLAVE.pdf" };
  data.calendar = { title: "MARCA-CALENDARIO-ALUMNAS", file: "materiales/cal/c.pdf", state: "available" };
  for (const resource of data.resources) {
    resource.description = "MARCA-DESCRIPCION";
    resource.driveFileId = "MARCA-DRIVE";
  }

  const outDir = await mkdtemp(join(tmpdir(), "respaldo-fuga-"));
  await buildSite({ catalog: data, password: "clave", correos: CORREOS, outDir, now: NOW, readObject: async () => Buffer.from("%PDF-1.4 x") });

  const prohibido = ["MARCA-PAUTAS", "MARCA-SOLUCIONARIO", "MARCA-CALENDARIO-INTERNO", "MARCA-CLAVE", "MARCA-CALENDARIO-ALUMNAS", "MARCA-DESCRIPCION", "MARCA-DRIVE", "materiales/"];
  for (const nombre of await readdir(outDir)) {
    const contenido = (await readFile(join(outDir, nombre))).toString("latin1");
    for (const marca of prohibido) {
      assert.equal(contenido.includes(marca), false, `${nombre} filtra "${marca}"`);
    }
  }
});

// Abre el sitio como lo haría el navegador de la alumna: deriva su clave del correo y la
// contraseña, prueba los sobres y devuelve la clave del material.
async function abrirConCorreo(html, correo, password) {
  const salt = Uint8Array.from(Buffer.from(html.match(/const SALT = "([^"]+)"/)[1], "base64"));
  const iterations = Number(html.match(/const ITERATIONS = (\d+)/)[1]);
  const sobres = JSON.parse(html.match(/const SOBRES = (\[[^\]]*\])/)[1]);
  const clave = await claveDeAlumna(correo, password, salt, iterations);
  for (const sobre of sobres) {
    try {
      const crudo = await decrypt(clave, Uint8Array.from(Buffer.from(sobre, "base64")));
      return webcrypto.subtle.importKey("raw", crudo, { name: "AES-GCM" }, false, ["decrypt"]);
    } catch (error) {
      // De otra alumna.
    }
  }
  return null;
}

test("solo entra quien está dada de alta, y hacen falta las dos cosas", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "respaldo-acceso-"));
  await buildSite({ catalog: catalog(), password: "clave-buena", correos: CORREOS, outDir, now: NOW, readObject: async () => Buffer.from("%PDF x") });
  const html = await readFile(join(outDir, "index.html"), "utf8");

  assert.ok(await abrirConCorreo(html, "paula@example.com", "clave-buena"), "una alumna de alta con la contraseña buena entra");
  // Las mayúsculas y los espacios de más no deberían dejarla fuera.
  assert.ok(await abrirConCorreo(html, "  MARIA.LOPEZ@Example.com ", "clave-buena"), "el correo no distingue mayúsculas");

  assert.equal(await abrirConCorreo(html, "amiga@example.com", "clave-buena"), null, "un correo que no está de alta no entra ni con la contraseña");
  assert.equal(await abrirConCorreo(html, "paula@example.com", "otra-clave"), null, "una alumna de alta no entra con la contraseña mal");
});

test("los correos no se escriben en ningún archivo del sitio", async () => {
  // Es un repositorio público: aquí no puede quedar ni un correo, ni en claro ni con hash,
  // porque un correo se adivina por diccionario a partir de su hash.
  const outDir = await mkdtemp(join(tmpdir(), "respaldo-correos-"));
  await buildSite({ catalog: catalog(), password: "clave", correos: CORREOS, outDir, now: NOW, readObject: async () => Buffer.from("%PDF x") });

  for (const nombre of await readdir(outDir)) {
    const contenido = (await readFile(join(outDir, nombre))).toString("latin1");
    for (const correo of CORREOS) {
      assert.equal(contenido.toLowerCase().includes(normalizarCorreo(correo)), false, `${nombre} contiene un correo`);
      assert.equal(contenido.includes(correo.split("@")[0]), false, `${nombre} contiene parte de un correo`);
    }
  }
});

test("sin ninguna alumna activa no se publica nada", async () => {
  // Publicar un sitio al que nadie puede entrar es peor que no publicarlo: parecería que el
  // respaldo funciona y no serviría a nadie.
  const outDir = await mkdtemp(join(tmpdir(), "respaldo-sin-alumnas-"));
  await assert.rejects(
    () => buildSite({ catalog: catalog(), password: "clave", correos: [], outDir, now: NOW, readObject: async () => Buffer.from("x") }),
    /nadie podría entrar/,
  );
});
