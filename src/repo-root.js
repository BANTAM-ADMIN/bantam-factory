import path from "node:path";
import { fileURLToPath } from "node:url";

export function repoRootFromCli(moduleUrl) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}
