import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "apps/web");
const target = join(root, ".groundskeeper/vercel-preview");
await mkdir(target, { recursive: true });
const excluded = new Set(["node_modules", ".next", ".vercel", "e2e", "AGENTS.md"]);
await cp(source, target, {
  recursive: true,
  filter: (path) =>
    !excluded.has(basename(path)) &&
    !basename(path).startsWith(".env") &&
    !/\.(test\.ts|tsbuildinfo|pem)$/.test(path),
});
const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
delete pkg.dependencies["@groundskeeper/database"];
// Resolve the preview to the installed, tested versions without workspace symlinks.
for (const group of ["dependencies", "devDependencies"]) {
  for (const name of Object.keys(pkg[group])) {
    pkg[group][name] = JSON.parse(
      await readFile(join(source, "node_modules", name, "package.json"), "utf8"),
    ).version;
  }
}
pkg.dependencies["@prisma/client"] = "6.19.0";
pkg.devDependencies.prisma = "6.19.0";
pkg.name = "groundskeeper-preview";
pkg.engines = { node: "22.x" };
pkg.scripts = { build: "prisma generate && next build", start: "next start" };
await writeFile(join(target, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
for (const file of ["dashboard-data.ts", "review-data.ts"]) {
  const path = join(target, "lib", file);
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace("@groundskeeper/database/client", "@prisma/client"),
  );
}
await mkdir(join(target, "prisma"), { recursive: true });
await cp(
  join(root, "packages/database/prisma/schema.prisma"),
  join(target, "prisma/schema.prisma"),
);
const tsconfig = JSON.parse(await readFile(join(source, "tsconfig.json"), "utf8"));
const base = JSON.parse(await readFile(join(root, "tsconfig.base.json"), "utf8"));
delete tsconfig.extends;
tsconfig.compilerOptions = { ...base.compilerOptions, ...tsconfig.compilerOptions };
await writeFile(join(target, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
await writeFile(
  join(target, "next.config.ts"),
  `import type { NextConfig } from 'next';\nconst config: NextConfig = { turbopack: { root: __dirname }, outputFileTracingRoot: __dirname, devIndicators: false, poweredByHeader: false };\nexport default config;\n`,
);
await writeFile(
  join(target, "vercel.json"),
  `${JSON.stringify(
    {
      framework: "nextjs",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      env: { DASHBOARD_MODE: "demo" },
      build: { env: { DASHBOARD_MODE: "demo" } },
    },
    null,
    2,
  )}\n`,
);
console.log(target);
