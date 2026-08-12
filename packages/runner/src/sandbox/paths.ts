import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * Path safety for anything read back from a sandbox (§5.3).
 *
 * The threat is specific and easy to underestimate: a symlink inside the workspace is
 * just a string, and the *runner* resolves it on the *host*. A container that writes
 * `ln -s ~/.ssh/id_rsa .ogun-out/findings.json` has not escaped anything itself — it
 * has arranged for the host to read that file and hand the contents back through the
 * API. Containment on the parent directory does not stop this, because the parent is a
 * real directory the runner created.
 *
 * So: reject absolute and `..` paths, resolve symlinks on the workspace and the
 * target's parent and require containment, and open the leaf with `O_NOFOLLOW`.
 */
export async function safeJoin(workspace: string, relPath: string): Promise<string> {
  if (isAbsolute(relPath)) throw new Error(`absolute path rejected: ${relPath}`)
  if (relPath.split(/[\\/]/).includes('..')) throw new Error(`parent traversal rejected: ${relPath}`)

  const root = await realpath(workspace)
  const target = resolve(root, relPath)

  // The parent must resolve inside the workspace; the leaf may not exist yet.
  let parent: string
  try {
    parent = await realpath(dirname(target))
  } catch {
    throw new Error(`no such directory for ${relPath}`)
  }
  if (parent !== root && !parent.startsWith(root + sep)) {
    throw new Error(`escapes the workspace: ${relPath}`)
  }
  return join(parent, target.slice(dirname(target).length + 1))
}

/**
 * A runaway or hostile agent can write an arbitrarily large file. The runner holds this
 * in memory to parse it, so an unbounded read is a denial of service against the host.
 */
export const MAX_READBACK_BYTES = 16 * 1024 * 1024

export class UnsafeReadback extends Error {}

/**
 * The only way anything reads a file a sandbox produced. Every caller must use this
 * rather than `readFile`, which follows symlinks by default and would defeat the whole
 * containment check.
 *
 * Returns null when the file simply is not there — that is an ordinary outcome (a
 * reviewer that wrote nothing). It throws when the path is hostile, because that is not.
 */
export async function readContained(
  workspace: string,
  relPath: string,
): Promise<string | null> {
  const abs = await safeJoin(workspace, relPath)

  let handle
  try {
    // O_NOFOLLOW fails with ELOOP if the leaf is a symlink, which is exactly the case
    // the parent-containment check cannot see.
    handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP') {
      throw new UnsafeReadback(
        `${relPath} is a symlink — the sandbox may not redirect a readback onto a host file`,
      )
    }
    throw err
  }

  try {
    const stat = await handle.stat()
    // A fifo would block the runner forever; a device or directory is not a readback.
    if (!stat.isFile()) {
      throw new UnsafeReadback(`${relPath} is not a regular file`)
    }
    if (stat.size > MAX_READBACK_BYTES) {
      throw new UnsafeReadback(
        `${relPath} is ${stat.size} bytes, over the ${MAX_READBACK_BYTES} limit`,
      )
    }
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}
