import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSourceCommit } from "../packages/coding-agent/src/utils/build-commit.ts";

const packageDir = fileURLToPath(new URL("../packages/coding-agent", import.meta.url));
mkdirSync(join(packageDir, "dist"), { recursive: true });
writeFileSync(join(packageDir, "dist", "commit"), `${getSourceCommit(packageDir) ?? ""}\n`);
