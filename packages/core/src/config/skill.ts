import { z } from 'zod'

/**
 * A skill carries its own worker config beside SKILL.md, at agents/*.yaml (§4.8).
 * `allow_implicit_invocation: false` is the important line — a factory skill must
 * never be auto-triggered by an agent mid-task. It runs when Ogun says so.
 *
 * snake_case here because this file is shared with other tools' skill conventions,
 * not ours to rename.
 */
export const skillAgentConfigSchema = z.object({
  interface: z
    .object({
      display_name: z.string().optional(),
      short_description: z.string().optional(),
      default_prompt: z.string().optional(),
    })
    .prefault({}),
  policy: z
    .object({
      allow_implicit_invocation: z.boolean().default(false),
    })
    .prefault({}),
})
export type SkillAgentConfig = z.infer<typeof skillAgentConfigSchema>

/** SKILL.md frontmatter — the convention, not our invention. */
export const skillFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
})
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>
