import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Loaded explicitly from this project's own .env.local - dotenv's default would look for a
// plain ".env", which this project doesn't use. Import this module first everywhere.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "..", ".env.local") });
