// A secret the server mode's deployer keeps in a file (06-cli §4.1 «服务器模式的配置»: the handle key
// file, and the other key files configured the same way): read, never written, so it may be a
// read-only mount. Not a control file: a mount's owner and links are the platform's (a Kubernetes
// secret volume is a link owned by root), so it is followed through links and its owner is not
// checked; it must be a regular file with no permission for others. It is checked on the open file
// it is then read from, so what is checked is what is read.

import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** A secret file that cannot be used; the message names no path or content. */
export class SecretFileError extends Error {
  override readonly name = "SecretFileError";
  readonly code: "missing" | "not_a_file" | "open_to_others" | "unreadable";
  constructor(code: SecretFileError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** The text of the secret file at `path`, after checking it. */
export async function readSecretFile(path: string): Promise<string> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    // Not blocking: a named pipe at the path would otherwise hold the open until a writer comes,
    // where it is to be refused as not a file. A regular file reads the same either way.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SecretFileError("missing", "the file is not there");
    if (code === "EISDIR") throw new SecretFileError("not_a_file", "the file is not a file");
    // Its permissions, or its path: a loop of links, a name too long, a part that is not a
    // directory. Each is the file not read, said without the path.
    if (
      code === "EACCES" ||
      code === "EPERM" ||
      code === "ELOOP" ||
      code === "ENAMETOOLONG" ||
      code === "ENOTDIR"
    ) {
      throw new SecretFileError("unreadable", "the file cannot be read");
    }
    throw e;
  }
  try {
    const s = await file.stat();
    if (!s.isFile()) throw new SecretFileError("not_a_file", "the file is not a file");
    if ((s.mode & 0o007) !== 0) {
      throw new SecretFileError("open_to_others", "the file is open to others");
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
