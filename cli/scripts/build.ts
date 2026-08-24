import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const version = "0.3.2";
const outDir = `dist/${version}`;
mkdirSync(outDir, { recursive: true });

const targets = [
  { bun: "bun-darwin-arm64", name: "no-swipe-darwin-arm64" },
  { bun: "bun-darwin-x64", name: "no-swipe-darwin-x64" },
  { bun: "bun-windows-x64", name: "no-swipe-windows-x64.exe" },
];

const manifest: Record<string, string> = {};
for (const target of targets) {
  const outfile = `${outDir}/${target.name}`;
  const proc = Bun.spawnSync([
    "bun", "build", "--compile", "--target", target.bun, "src/main.ts", "--outfile", outfile,
  ], { cwd: import.meta.dir + "/.." });
  if (proc.exitCode !== 0) {
    console.error(new TextDecoder().decode(proc.stderr));
    throw new Error(`compile failed for ${target.name}`);
  }
  const gzipped = `${outfile}.gz`;
  const gzip = Bun.spawnSync(["gzip", "-kf", outfile], { cwd: import.meta.dir + "/.." });
  if (gzip.exitCode !== 0) {
    console.error(new TextDecoder().decode(gzip.stderr));
    throw new Error(`gzip failed for ${target.name}`);
  }
  const bytes = await Bun.file(gzipped).arrayBuffer();
  manifest[`${target.name}.gz`] = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}
writeFileSync(`${outDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, version, outDir, manifest }, null, 2));
