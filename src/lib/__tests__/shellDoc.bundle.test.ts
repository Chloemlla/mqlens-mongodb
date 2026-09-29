import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The query parser has to survive being bundled and minified.
 *
 * Every other test in this suite runs the source directly, which is why a
 * production-only break reached a release: the parser's ESM wrapper re-exports
 * each function off a default import, and the CommonJS entry behind it sets
 * `__esModule` with its own `default`, so a bundler hands the wrapper one
 * function where it expects the namespace. `parseFilter` was `undefined` from
 * module init and EVERY query in the packaged app failed with "is not a
 * function", whatever the user had typed.
 *
 * So this builds the parser the way the app is built — through the app's own
 * `vite.config.ts`, so deleting the resolution fix fails here rather than
 * quietly passing against a private copy of the settings — and asks the result
 * to parse. Slower than a unit test, and the only kind that can see this.
 *
 * The build runs as a child process on purpose: esbuild refuses to start under
 * jsdom's `TextEncoder`, and this suite's setup needs jsdom.
 */
describe('shellDoc, bundled and minified', () => {
  it('parses queries after a production build', async () => {
    const root = path.resolve(__dirname, '../../..');
    const dir = await mkdtemp(path.join(tmpdir(), 'mqlens-bundle-'));

    await writeFile(
      path.join(dir, 'entry.mjs'),
      `export { parseQueryObject } from ${JSON.stringify(path.join(root, 'src/lib/shellDoc.ts'))};\n`
    );
    await writeFile(
      path.join(dir, 'vite.config.mjs'),
      [
        `import { defineConfig, loadConfigFromFile } from ${JSON.stringify(path.join(root, 'node_modules/vite/dist/node/index.js'))};`,
        `const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, ${JSON.stringify(path.join(root, 'vite.config.ts'))});`,
        `export default defineConfig({`,
        `  configFile: false,`,
        `  resolve: { alias: loaded.config.resolve.alias },`,
        `  build: {`,
        `    outDir: ${JSON.stringify(dir)},`,
        `    emptyOutDir: false,`,
        `    lib: { entry: ${JSON.stringify(path.join(dir, 'entry.mjs'))}, formats: ['es'], fileName: 'bundle' },`,
        `    minify: 'esbuild',`,
        `    target: 'es2021',`,
        `  },`,
        `});`,
      ].join('\n')
    );

    await run('npx', ['vite', 'build', '--config', path.join(dir, 'vite.config.mjs'), '--logLevel', 'error'], {
      cwd: root,
      timeout: 180_000,
    });

    const bundle = await readFile(path.join(dir, 'bundle.js'), 'utf8');
    // Imported through a data URL so vitest's own pipeline cannot re-resolve
    // the dependency and hide the very thing under test.
    const loaded = (await import(
      `data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`
    )) as { parseQueryObject: (text: string) => unknown };

    // Shapes the app actually produces: the visual query builder emits
    // pretty-printed JSON, the single-line editor flattens it, and people type
    // mongosh-style by hand.
    expect(loaded.parseQueryObject('{ "_id": 1}')).toEqual({ _id: 1 });
    expect(loaded.parseQueryObject('{  "domain": "acc"}')).toEqual({ domain: 'acc' });
    expect(loaded.parseQueryObject('domain: "acc"')).toEqual({ domain: 'acc' });
  }, 240_000);
});
