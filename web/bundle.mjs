/**
 * A very small ES-module bundler, for the hosted build only.
 *
 * The browser app is written as ordinary modules that the server hands out one
 * file at a time. The hosted copy is a single HTML file with no server, so the
 * modules have to be flattened into one script.
 *
 * The approach is Rollup's, not Webpack's: concatenate the module bodies into a
 * single scope rather than wrapping each one in a function. That matters here —
 * views, player and add.js import each other in a cycle, and only a shared
 * scope lets hoisted function declarations resolve across it the way real ESM
 * does. The cost is that two modules may not declare the same top-level name;
 * where they do, the later one is renamed and the rename is reported so a
 * build is never quietly wrong.
 */

const IMPORT_RE = /^import\s+([\s\S]*?)\s+from\s+'([^']+)';?[ \t]*$/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\};?[ \t]*$/gm;
const DECL_RE = /^(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** `{ a, b as c }` / `* as ns` / `x` → [{ imported, local }] */
function parseClause(clause) {
  const text = clause.trim();
  if (text.startsWith('*')) {
    const m = /\*\s+as\s+([\w$]+)/.exec(text);
    throw new Error(`namespace import is not supported: ${m ? m[1] : text}`);
  }
  if (!text.startsWith('{')) return [{ imported: 'default', local: text }];
  return text
    .slice(1, -1)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [imported, local] = part.split(/\s+as\s+/).map((s) => s.trim());
      return { imported, local: local || imported };
    });
}

function resolve(specifier, from) {
  if (!specifier.startsWith('./')) throw new Error(`${from}: only './x.js' imports are supported, got '${specifier}'`);
  return specifier.slice(2);
}

/** Strip the module syntax out, and note what the module brings in and puts out. */
function readModule(name, source) {
  const imports = [];
  let body = source.replace(IMPORT_RE, (_full, clause, specifier) => {
    for (const binding of parseClause(clause)) {
      imports.push({ ...binding, from: resolve(specifier, name) });
    }
    return '';
  });

  const exported = new Set();
  body = body.replace(EXPORT_LIST_RE, (_full, list) => {
    for (const part of list.split(',')) {
      const named = part.trim().split(/\s+as\s+/).map((s) => s.trim());
      if (named[0]) exported.add(named[0]);
    }
    return '';
  });
  // `export function x` → `function x`; the name stays visible to every module.
  body = body.replace(/^export\s+((?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*))/gm, (_full, rest, exportedName) => {
    exported.add(exportedName);
    return rest;
  });

  const declared = [];
  for (const line of body.split('\n')) {
    const m = DECL_RE.exec(line);
    if (m) declared.push(m[1]);
  }

  return { name, body, imports, declared, exported };
}

/** Depth-first, so a module is emitted after the ones it imports where possible. */
function order(modules, entry) {
  const out = [];
  const seen = new Set();
  (function visit(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const mod = modules.get(name);
    if (!mod) throw new Error(`no such module: ${name}`);
    for (const dep of mod.imports) visit(dep.from);
    out.push(name);
  }(entry));
  for (const name of modules.keys()) if (!seen.has(name)) out.push(name);
  return out;
}

export function bundle(sources, entry) {
  const modules = new Map();
  for (const [name, source] of Object.entries(sources)) modules.set(name, readModule(name, source));

  const sequence = order(modules, entry);

  // Pass one: give every declaration a name that is unique across the bundle.
  // First one in wins; the rest are suffixed with the module they came from.
  const taken = new Set();
  const declaredAs = new Map();   // module -> Map(declared -> global)
  const report = [];
  for (const name of sequence) {
    const mod = modules.get(name);
    const map = new Map();
    const base = name.replace(/\.js$/, '').replace(/\W/g, '_');
    for (const local of mod.declared) {
      if (map.has(local)) continue;
      if (!taken.has(local)) {
        taken.add(local);
        map.set(local, local);
      } else {
        const unique = `${local}$${base}`;
        if (taken.has(unique)) throw new Error(`cannot make '${local}' unique in ${name}`);
        taken.add(unique);
        map.set(local, unique);
      }
    }
    declaredAs.set(name, map);
  }

  // Pass two: an imported name is simply the exporter's name. No aliasing —
  // rewriting the reference is what makes a cycle behave like real ESM, since
  // there is then nothing to initialise in the wrong order.
  const chunks = [];
  const dynamic = new Set();
  for (const name of sequence) {
    const mod = modules.get(name);
    const map = new Map(declaredAs.get(name));

    for (const binding of mod.imports) {
      const from = declaredAs.get(binding.from)?.get(binding.imported);
      if (!from) throw new Error(`${name} imports '${binding.imported}' from ${binding.from}, which does not declare it`);
      if (map.has(binding.local) && map.get(binding.local) !== from) {
        throw new Error(`${name}: '${binding.local}' is both imported and declared`);
      }
      map.set(binding.local, from);
    }

    let body = mod.body;

    // `await import('./x.js')` is how views.js reaches the heavier modules and
    // how it breaks its own cycles. Everything is already in this scope, so the
    // namespace can simply be handed back.
    body = body.replace(/\bimport\(\s*'\.\/([\w.-]+)'\s*\)/g, (_full, dep) => {
      if (!modules.has(dep)) throw new Error(`${name} imports '${dep}' at runtime, which is not in the bundle`);
      dynamic.add(dep);
      return `__module(${JSON.stringify(dep)})`;
    });

    for (const [from, to] of map) {
      if (from === to) continue;
      // Not after a dot (property access) and not before a colon (object key),
      // so only real references to the binding are touched.
      const pattern = new RegExp(`(?<![.\\w$])${from}\\b(?!\\s*:)`, 'g');
      const hits = (body.match(pattern) || []).length;
      body = body.replace(pattern, to);
      report.push(`${name}: ${from} → ${to} (${hits} reference${hits === 1 ? '' : 's'})`);
    }

    chunks.push(`// ── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}\n${body.trim()}\n`);
  }

  // The namespaces the runtime imports resolve to. Assembled inside a function
  // rather than in an object at the end of the file, so the bindings are read
  // when the import happens — which is both what ESM does and what stops a
  // module that imports during its own evaluation from tripping over the
  // temporal dead zone.
  let table = '';
  if (dynamic.size) {
    const cases = [...dynamic].sort().map((name) => {
      const map = declaredAs.get(name);
      const fields = [...modules.get(name).exported].sort()
        .map((exportName) => `      ${JSON.stringify(exportName)}: ${map.get(exportName)},`);
      return `    case ${JSON.stringify(name)}: return {\n${fields.join('\n')}\n    };`;
    });
    table = `
// ── runtime imports ${'─'.repeat(44)}
function __namespace(name) {
  switch (name) {
${cases.join('\n')}
    default: throw new Error('no such module: ' + name);
  }
}
function __module(name) {
  // A failed import rejects; it does not throw at the call site.
  try {
    return Promise.resolve(__namespace(name));
  } catch (err) {
    return Promise.reject(err);
  }
}
`;
  }

  return {
    code: `(function () {\n'use strict';\n\n${chunks.join('\n')}${table}\n}());\n`,
    renames: report,
  };
}
