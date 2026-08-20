// Whether the module at `moduleUrl` is the file this process was started with —
// the ES-module stand-in for `require.main === module`, shared by every script
// that runs a main() when invoked directly and stays quiet when imported.
//
// Real paths, not URLs: Node resolves the entry's symlinks before it sets
// `import.meta.url`, while argv[1] stays as invoked, so a script reached
// through any symlinked path component — macOS's /var -> /private/var tmpdir,
// a symlinked ~/.claude in front of a real install — sees the two disagree as
// strings. A guard comparing them textually then skips main() silently with
// exit code 0, and a no-op that exits 0 reads as success to whatever spawned it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    // A side that cannot be resolved is not this process's entry — a non-file
    // URL, a path that no longer exists. Both mean "imported", not "invoked".
    return false;
  }
}
