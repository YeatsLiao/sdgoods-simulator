import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const directory = new URL("../tests/", import.meta.url);
const files = readdirSync(directory).filter((name) => name.endsWith(".test.js")).map((name) => fileURLToPath(new URL(name, directory)));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
