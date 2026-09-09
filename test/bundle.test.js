import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '../web/bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Run a bundle and hand back whatever it wrote to the shared object. */
function run(sources, entry = 'main.js') {
  const { code } = bundle(sources, entry);
  const out = {};
  // eslint-disable-next-line no-new-func
  new Function('out', code)(out);
  return out;
}

test('a plain import is rewritten to a reference, not a copy', () => {
  const out = run({
    'main.js': "import { greet } from './lib.js';\nout.said = greet('Olti');\n",
    'lib.js': "export function greet(name) { return `hello ${name}`; }\n",
  });
  assert.equal(out.said, 'hello Olti');
});

test('an aliased import keeps working under its local name', () => {
  const out = run({
    'main.js': "import { search as find } from './lib.js';\nout.hit = find([1, 2, 3]);\n",
    'lib.js': 'export function search(list) { return list.length; }\n',
  });
  assert.equal(out.hit, 3);
});

test('two modules may declare the same name', () => {
  const { code, renames } = bundle({
    'main.js': "import { one } from './a.js';\nimport { two } from './b.js';\nout.sum = one() + two();\n",
    'a.js': 'const size = 1;\nexport function one() { return size; }\n',
    'b.js': 'const size = 10;\nexport function two() { return size; }\n',
  }, 'main.js');
  const out = {};
  new Function('out', code)(out);
  assert.equal(out.sum, 11);
  assert.equal(renames.some((line) => /size/.test(line)), true);
});

test('a module that both imports and declares a name is refused', () => {
  assert.throws(() => bundle({
    'main.js': "import { size } from './a.js';\nconst size = 2;\n",
    'a.js': 'export const size = 1;\n',
  }, 'main.js'), /both imported and declared/);
});

test('modules that import each other still resolve, as they do in real ESM', () => {
  const out = run({
    'main.js': "import { start } from './a.js';\nout.chain = start();\n",
    'a.js': "import { second } from './b.js';\nexport function start() { return `a→${second()}`; }\nexport function back() { return 'a'; }\n",
    'b.js': "import { back } from './a.js';\nexport function second() { return `b→${back()}`; }\n",
  });
  assert.equal(out.chain, 'a→b→a');
});

test('export lists are picked up as exports', () => {
  const out = run({
    'main.js': "import { value } from './a.js';\nout.value = value();\n",
    'a.js': 'function value() { return 7; }\nexport { value };\n',
  });
  assert.equal(out.value, 7);
});

test('a runtime import resolves to the module namespace', async () => {
  const out = run({
    'main.js': "out.later = import('./a.js').then((m) => m.hello());\n",
    'a.js': "export function hello() { return 'from a'; }\n",
  });
  assert.equal(await out.later, 'from a');
});

test('a runtime import of something outside the bundle is refused', () => {
  assert.throws(() => bundle({
    'main.js': "import('./missing.js');\n",
  }, 'main.js'), /not in the bundle/);
});

test('importing a name the other module does not export is refused', () => {
  assert.throws(() => bundle({
    'main.js': "import { nope } from './a.js';\n",
    'a.js': 'export const yes = 1;\n',
  }, 'main.js'), /does not declare it/);
});

test('a namespace import is refused rather than silently dropped', () => {
  assert.throws(() => bundle({
    'main.js': "import * as lib from './a.js';\n",
    'a.js': 'export const yes = 1;\n',
  }, 'main.js'), /namespace import/);
});

test('the real app bundles, and every module ends up in it', () => {
  const sources = {};
  for (const file of fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((f) => f.endsWith('.js'))) {
    sources[file] = fs.readFileSync(path.join(ROOT, 'public', 'js', file), 'utf8');
  }
  sources['api.js'] = fs.readFileSync(path.join(ROOT, 'web', 'api.web.js'), 'utf8');
  sources['samplelib.js'] = fs.readFileSync(path.join(ROOT, 'web', 'samplelib.js'), 'utf8');
  sources['media.js'] = 'export const MEDIA = {};\n';

  const { code } = bundle(sources, 'app.js');
  for (const name of Object.keys(sources)) {
    assert.ok(code.includes(`// ── ${name} `), `${name} is missing from the bundle`);
  }
  // No module syntax may survive: this runs as a classic script.
  assert.equal(/^import\s/m.test(code), false, 'a static import survived');
  assert.equal(/^export\s/m.test(code), false, 'an export survived');
  // And it has to parse.
  assert.doesNotThrow(() => new Function(code));
});
