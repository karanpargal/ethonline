// Loads the repo-root .env into process.env (Node 21+ native, no dotenv dep).
// Import this FIRST in every entrypoint and script.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
