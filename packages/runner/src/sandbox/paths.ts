import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * Path safety for anything read back from a sandbox (§5.3). Reject absolute and `..`
 * paths, resolve symlinks on both the workspace and the target's parent, and require
 * containment — a container that can write a symlink can otherwise name any host file.
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
