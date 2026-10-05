/**
 * What a deployment bundle must not contain, checked from esbuild's metafile:
 * shared by the Cloudflare Worker guard (check-bundle.mjs) and the Lambda
 * guard (check-lambda-bundle.mjs).
 *
 * A rule names either a bundled input (a path pattern, e.g. a package under
 * node_modules) or an import left external (a specifier pattern). For each
 * hit the report prints the chain of imports from the entry, marking lazy
 * ones, once per offending package.
 */

/** Each input's importer and how it was imported, breadth-first from the entry. */
function parents(metafile, entry) {
  const parent = new Map([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    for (const imp of metafile.inputs[file]?.imports ?? []) {
      if (!parent.has(imp.path)) {
        parent.set(imp.path, { from: file, kind: imp.kind });
        if (!imp.external) queue.push(imp.path);
      }
    }
  }
  return parent;
}

/** Whether the path to `target` takes a lazy import made inside node_modules. */
function viaThirdPartyLazy(parent, target) {
  for (let at = target; at; ) {
    const p = parent.get(at);
    if (p?.kind === "dynamic-import" && p.from.includes("node_modules/")) return true;
    at = p?.from;
  }
  return false;
}

function chain(parent, target) {
  const steps = [];
  for (let at = target; at; ) {
    const p = parent.get(at);
    steps.unshift(p ? `${at}${p.kind === "dynamic-import" ? "  (lazy)" : ""}` : at);
    at = p?.from;
  }
  return steps.map((s, i) => `${"  ".repeat(i)}${i ? "└ " : ""}${s}`).join("\n");
}

/**
 * Report what the bundle reaches that it mustn't; true when it is clean.
 *
 * - `forbiddenInputs`: `[pattern, why]` for bundled files;
 * - `forbiddenExternals`: `[pattern, why, { thirdPartyLazy }?]` for imports
 *   left external. `thirdPartyLazy` also allows one whose path runs through a
 *   lazy import a dependency makes itself; our own code reaching it, static
 *   or lazy, still fails;
 * - `bundleName` ("the Worker bundle") and `fix` (printed after any hit).
 */
export function checkForbidden(metafile, { entry, forbiddenInputs, forbiddenExternals, bundleName, fix }) {
  const parent = parents(metafile, entry);
  const hits = [];
  const notes = new Set();
  for (const file of Object.keys(metafile.inputs)) {
    const rule = forbiddenInputs.find(([pattern]) => pattern.test(file));
    if (rule && parent.has(file)) hits.push({ target: file, why: rule[1] });
    for (const imp of metafile.inputs[file].imports) {
      const ext = imp.external && forbiddenExternals.find(([pattern]) => pattern.test(imp.path));
      if (!ext || !parent.has(file)) continue;
      if (ext[2]?.thirdPartyLazy && viaThirdPartyLazy(parent, file)) {
        notes.add(`${imp.path}, behind a dependency's own lazy import in ${file.replace(/.*node_modules\//, "")}`);
      } else hits.push({ target: imp.path, via: file, why: ext[1] });
    }
  }
  for (const note of notes) console.log(`note: allowed: ${note}`);
  const bytes = Object.values(metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  console.log(`bundle: ${Object.keys(metafile.inputs).length} modules, ${(bytes / 1e6).toFixed(1)} MB unminified`);
  // One report per offending package, not per file.
  const seen = new Set();
  const reported = hits.filter(({ target }) => {
    const key = target.replace(/(node_modules\/(@[^/]+\/)?[^/]+|packages\/[^/]+).*/, "$1");
    return seen.has(key) ? false : (seen.add(key), true);
  });
  for (const { target, why } of reported) {
    console.error(`\n✖ ${why} is in ${bundleName}:\n${chain(parent, target)}`);
  }
  if (reported.length) console.error(`\n${fix}`);
  return reported.length === 0;
}
