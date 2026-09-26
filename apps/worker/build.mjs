// Bundles the worker and its workspace packages (TypeScript sources) into dist/main.js.
// Third-party packages stay external and are installed from package.json in the image.
import { build } from 'esbuild';

const externalThirdParty = {
  name: 'external-third-party',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@w360/') || args.path.startsWith('node:')) return undefined;
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: { main: 'src/main.ts', migrate: '../../packages/db/src/cli/migrate.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  legalComments: 'none',
  plugins: [externalThirdParty],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
