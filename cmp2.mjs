import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const dir = join(homedir(), ".originrouter");
console.log(readdirSync(dir).filter(f => f.includes("directory")).join("\n"));
