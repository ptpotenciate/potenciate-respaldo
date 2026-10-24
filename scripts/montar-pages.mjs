// Monta lo que se publica en GitHub Pages (rama gh-pages):
//
//   /                 el portero (portero/): comprueba si el aula responde y, si una operadora
//                     la tiene bloqueada, enseña las alternativas
//   /respaldo/        la página de emergencia con el material cifrado, o el aviso «No disponible»
//                     si está desactivada
//   /CNAME            entrar.potenciateoposiciones.com
//
// Lo usan los tres workflows que publican (activar, desactivar y publicar-portero), para que el
// portero esté siempre y lo único que cambie entre ellos sea lo que hay en /respaldo/.
//
// Uso:
//   node scripts/montar-pages.mjs --respaldo <carpeta> --salida <carpeta>
//   node scripts/montar-pages.mjs --actual <gh-pages-actual> --placeholder <carpeta> --salida <carpeta>
//     (con --actual se conserva el respaldo que ya estuviera publicado)
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DOMINIO = "entrar.potenciateoposiciones.com";

// El respaldo que ya está publicado: el de /respaldo/ (distribución actual) o, si es la primera
// vez, el de la raíz (distribución anterior, cuando la raíz era la página de emergencia).
export function resolverRespaldo({ actual = "", placeholder }) {
  if (actual) {
    if (existsSync(join(actual, "respaldo", "index.html"))) return join(actual, "respaldo");
    if (existsSync(join(actual, "index.html"))) return actual;
  }
  return placeholder;
}

const sinGit = (origen) => !/(^|[\\/])\.git$/.test(origen);

export function montar({ respaldo, salida, portero = "portero", dominio = DOMINIO }) {
  if (!existsSync(join(portero, "index.html"))) throw new Error(`Falta ${join(portero, "index.html")}: no hay portero que publicar.`);
  if (!existsSync(join(respaldo, "index.html"))) throw new Error(`Falta ${join(respaldo, "index.html")}: el respaldo no tiene página.`);
  rmSync(salida, { recursive: true, force: true });
  mkdirSync(salida, { recursive: true });
  cpSync(portero, salida, { recursive: true, filter: sinGit });
  // En la distribución anterior el respaldo era la raíz: sin su CNAME ni lo que ya sea el portero.
  cpSync(respaldo, join(salida, "respaldo"), {
    recursive: true,
    filter: (origen) => sinGit(origen) && !/(^|[\\/])CNAME$/.test(origen) && resolve(origen) !== resolve(salida),
  });
  writeFileSync(join(salida, "CNAME"), `${dominio}\n`);
  writeFileSync(join(salida, ".nojekyll"), "");
  return salida;
}

function argumentos(lista) {
  const a = {};
  for (let i = 0; i < lista.length; i += 2) a[lista[i].replace(/^--/, "")] = lista[i + 1];
  return a;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = argumentos(process.argv.slice(2));
  if (!a.salida || !(a.respaldo || a.placeholder)) {
    console.error("Uso: node scripts/montar-pages.mjs --respaldo <carpeta> --salida <carpeta>\n     o: --actual <gh-pages> --placeholder <carpeta> --salida <carpeta>");
    process.exit(2);
  }
  const respaldo = a.respaldo || resolverRespaldo({ actual: a.actual, placeholder: a.placeholder });
  montar({ respaldo, salida: a.salida });
  console.log(`Sitio montado en ${a.salida} (respaldo: ${respaldo}).`);
}
