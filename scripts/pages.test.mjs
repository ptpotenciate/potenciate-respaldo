import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMINIO, montar, resolverRespaldo } from "./montar-pages.mjs";

const temporal = () => mkdtempSync(join(tmpdir(), "pages-"));
function carpeta(base, archivos) {
  mkdirSync(base, { recursive: true });
  for (const [nombre, contenido] of Object.entries(archivos)) {
    mkdirSync(join(base, nombre, ".."), { recursive: true });
    writeFileSync(join(base, nombre), contenido);
  }
  return base;
}
const portero = (t) => carpeta(join(t, "portero"), { "index.html": "<p>portero</p>", "logo.png": "png" });

test("El portero va en la raíz, el respaldo en /respaldo/ y el dominio en CNAME", () => {
  const t = temporal();
  const respaldo = carpeta(join(t, "datos"), { "index.html": '<form id="gate">', "tema1.bin": "cifrado", "sub/otro.bin": "x" });
  const salida = join(t, "publicar");
  montar({ respaldo, salida, portero: portero(t) });
  assert.equal(readFileSync(join(salida, "index.html"), "utf8"), "<p>portero</p>");
  assert.equal(readFileSync(join(salida, "respaldo", "index.html"), "utf8"), '<form id="gate">');
  assert.equal(readFileSync(join(salida, "respaldo", "sub", "otro.bin"), "utf8"), "x");
  assert.equal(readFileSync(join(salida, "CNAME"), "utf8"), `${DOMINIO}\n`);
  assert.ok(existsSync(join(salida, ".nojekyll")));
  assert.ok(!existsSync(join(salida, "respaldo", "CNAME")), "el CNAME es solo el de la raíz");
});

test("No publica la carpeta .git del respaldo ni monta nada sin portero o sin página de respaldo", () => {
  const t = temporal();
  const respaldo = carpeta(join(t, "datos"), { "index.html": "x", ".git/HEAD": "ref" });
  const salida = join(t, "publicar");
  montar({ respaldo, salida, portero: portero(t) });
  assert.ok(!existsSync(join(salida, "respaldo", ".git")));
  assert.throws(() => montar({ respaldo, salida, portero: join(t, "no-existe") }), /no hay portero/);
  assert.throws(() => montar({ respaldo: carpeta(join(t, "vacio"), { "otro.txt": "x" }), salida, portero: portero(t) }), /no tiene página/);
});

test("Conserva el respaldo ya publicado: el de /respaldo/, el de la raíz (distribución anterior) o, si no hay, el aviso", () => {
  const t = temporal();
  const aviso = carpeta(join(t, "placeholder"), { "index.html": "aviso" });
  // Nada publicado todavía.
  assert.equal(resolverRespaldo({ actual: join(t, "no-existe"), placeholder: aviso }), aviso);
  assert.equal(resolverRespaldo({ actual: "", placeholder: aviso }), aviso);
  // Distribución anterior: la raíz era la página (activa o el aviso).
  const antigua = carpeta(join(t, "antigua"), { "index.html": '<form id="gate">', "a.bin": "x", "CNAME": "viejo.example" });
  assert.equal(resolverRespaldo({ actual: antigua, placeholder: aviso }), antigua);
  const salida = join(t, "publicar");
  montar({ respaldo: antigua, salida, portero: portero(t) });
  assert.deepEqual(readdirSync(join(salida, "respaldo")).sort(), ["a.bin", "index.html"], "sin el CNAME antiguo");
  assert.equal(readFileSync(join(salida, "CNAME"), "utf8"), `${DOMINIO}\n`);
  // Distribución actual: manda /respaldo/.
  const nueva = carpeta(join(t, "nueva"), { "index.html": "portero", "respaldo/index.html": '<form id="gate">', "respaldo/b.bin": "y" });
  assert.equal(resolverRespaldo({ actual: nueva, placeholder: aviso }), join(nueva, "respaldo"));
  // Volver a montar encima de lo ya montado no anida carpetas.
  const otra = join(t, "otra");
  montar({ respaldo: join(nueva, "respaldo"), salida: otra, portero: portero(t) });
  assert.deepEqual(readdirSync(join(otra, "respaldo")).sort(), ["b.bin", "index.html"]);
});

test("El aviso «No disponible» no se confunde a sí mismo con la página activa (se recargaba sin parar)", () => {
  const aviso = readFileSync(new URL("../placeholder/index.html", import.meta.url), "utf8");
  const generador = readFileSync(new URL("./sync-cloudflare.mjs", import.meta.url), "utf8");
  const [, patron, banderas] = aviso.match(/\.test\(await respuesta\.text\(\)\)/) ? aviso.match(/if \(\/(.+?)\/([a-z]*)\.test\(await respuesta/) : [];
  assert.ok(patron, "el aviso busca la etiqueta con id=\"gate\"");
  const re = new RegExp(patron, banderas);
  assert.equal(re.test(aviso), false, "el propio aviso no cuenta como página activa");
  assert.equal(re.test('<form id="gate" style="margin-top:16px">'), true);
  assert.ok(generador.includes('<form id="gate"'), "la página activa sigue teniendo ese formulario");
});
