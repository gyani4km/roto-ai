import fs from "node:fs/promises";
import validator from "gltf-validator";
const base = process.env.ROTO_URL || "http://127.0.0.1:8000";
const inventory = await (await fetch(`${base}/api/avatar/inventory`)).json();
const bytes = await fs.readFile(inventory.source_path);
const report = await validator.validateBytes(new Uint8Array(bytes), {
  uri: inventory.file,
  maxIssues: 1000,
});
await fs.mkdir("../runtime/evidence/s1-v001", { recursive: true });
await fs.writeFile(
  "../runtime/evidence/s1-v001/asset-inventory.json",
  JSON.stringify(inventory, null, 2),
);
await fs.writeFile(
  "../runtime/evidence/s1-v001/khronos-validation.json",
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    {
      errors: report.issues.numErrors,
      warnings: report.issues.numWarnings,
      info: report.info,
    },
    null,
    2,
  ),
);
if (report.issues.numErrors) process.exitCode = 1;
