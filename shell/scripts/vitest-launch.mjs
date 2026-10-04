// vitest launcher: drive-letter normalization + webstorage fix (see dx_features_backlog.md)
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
process.chdir(realpathSync.native(process.cwd()));
const env = { ...process.env };
env.NODE_OPTIONS = [env.NODE_OPTIONS, '--no-experimental-webstorage'].filter(Boolean).join(' ');
const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)], { stdio: "inherit", env });
process.exit(r.status ?? 1);
