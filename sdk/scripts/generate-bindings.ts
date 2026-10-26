import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { contract } from "@stellar/stellar-sdk";
const sdkRoot = fileURLToPath(new URL("..", import.meta.url));
const wasm = resolve(
  process.argv[2] ??
    resolve(
      sdkRoot,
      "../../contracts/target/wasm32v1-none/release/mierkhat_guard.wasm",
    ),
);
const out = resolve(sdkRoot, "src/generated");
mkdirSync(out, { recursive: true });
const spec = contract.Spec.fromWasm(readFileSync(wasm));
writeFileSync(
  resolve(out, "spec.json"),
  JSON.stringify(
    spec.entries.map((e) => e.toXDR("base64")),
    null,
    2,
  ) + "\n",
);
const temp = mkdtempSync(resolve(tmpdir(), "mierkhat-bindings-"));
try {
  execFileSync(
    "stellar",
    [
      "contract",
      "bindings",
      "typescript",
      "--wasm",
      wasm,
      "--output-dir",
      temp,
      "--overwrite",
    ],
    { stdio: "inherit" },
  );
  const source = readFileSync(resolve(temp, "src/index.ts"), "utf8");
  writeFileSync(
    resolve(out, "types.ts"),
    '// Generated from compiled guard ABI. Do not edit.\nimport type {u32,u64,i128,Option} from "@stellar/stellar-sdk/contract";\n' +
      source
        .slice(
          source.indexOf("export interface CodePin"),
          source.indexOf("export interface Client"),
        )
        .replaceAll("Buffer", "Uint8Array"),
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
