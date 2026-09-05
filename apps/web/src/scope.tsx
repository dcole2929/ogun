import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api.ts'

/**
 * Which project the app is looking at.
 *
 * Every project-scoped page used to answer this question for itself, and answered it
 * three different ways: Skills and Findings showed every project at once, Runs mixed them
 * with a project column, and Coverage took `projects[0]` — so with two projects
 * registered, one project's coverage was unreachable and every built-in skill appeared
 * twice. Those are the same missing concept failing loudly and quietly.
 *
 * So the scope lives here, once, and the pages read it.
 */

export const ALL = 'all'

/** `undefined` for "every project", which is what the API's absent `?project=` means. */
export type ProjectFilter = string | undefined

type Scope = {
  /** The selected slug, or `ALL`. */
  slug: string
  setSlug: (slug: string) => void
  /** The same selection shaped for the API: a slug, or `undefined` for all. */
  filter: ProjectFilter
  isAll: boolean
  projects: Array<{ id: string; slug: string }>
}

/**
 * The context carries the *selection* and nothing else.
 *
 * The list of projects is query data, so it is read from react-query at the point of use
 * rather than threaded through here. That is not a tidiness point: it means a page
 * rendered outside the shell — which the render test does for every page — still sees the
 * real project list instead of an empty one, so a scoped page can be tested without
 * mounting the provider. Putting the list in the context made `CoveragePage` render "no
 * projects registered" in a test that had seeded three.
 *
 * A default rather than a throw, for the same reason: "all projects" is the honest answer
 * when nobody has set one.
 */
const ScopeContext = createContext<{ slug: string; setSlug: (slug: string) => void }>({
  slug: ALL,
  setSlug: () => {},
})

const STORAGE_KEY = 'ogun.project-scope'

/**
 * Persisted, because this is a hard scope rather than a per-page filter: picking a project
 * means "I am working on this one", and having that reset on every reload would make it a
 * setting nobody trusts. `localStorage` is per-browser, which is the right lifetime — it
 * is a view preference, not something to sync or send anywhere.
 */
const stored = (): string => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? ALL
  } catch {
    // Private windows and blocked site data both throw here rather than returning null.
    return ALL
  }
}

export function ProjectScopeProvider({
  children,
  initial,
}: {
  children: ReactNode
  /**
   * Seeds the selection instead of reading the stored one. There is no `localStorage`
   * outside a browser, so this is how a scoped page is rendered anywhere else — the
   * render tests use it, and a server render would need the same door.
   */
  initial?: string
}) {
  // Not read during render: on the server there is no localStorage, and reading it in the
  // initialiser would make the first client paint disagree with the markup.
  const [slug, setSlugState] = useState(initial ?? ALL)

  useEffect(() => {
    if (initial === undefined) setSlugState(stored())
  }, [initial])

  const setSlug = useCallback((next: string) => {
    setSlugState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Losing the preference is not worth losing the selection over.
    }
  }, [])

  const value = useMemo(() => ({ slug, setSlug }), [slug, setSlug])

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

export function useProjectScope(): Scope {
  const { slug, setSlug } = useContext(ScopeContext)
  const { data } = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const projects = data?.projects ?? []

  /**
   * A stored slug for a project that no longer exists reads as "all" rather than as an
   * empty page. Projects get renamed and removed, and a scope pinned to a slug nothing
   * matches would otherwise show nothing everywhere with no clue why — the worst failure
   * available to a control whose whole job is to narrow.
   *
   * Only once the list has actually arrived, or the first paint would reset a valid
   * selection while the query is still in flight.
   */
  const known = projects.length === 0 || projects.some((p) => p.slug === slug)
  const effective = slug === ALL || known ? slug : ALL

  return {
    slug: effective,
    setSlug,
    filter: effective === ALL ? undefined : effective,
    isAll: effective === ALL,
    projects,
  }
}

/**
 * The projects a scoped page should render, in order.
 *
 * One entry when a project is selected, every project when it is not — so a page that
 * repeats a section per project (Workers, Coverage) reads the scope the same way a page
 * that passes a filter to the API does.
 */
export function useScopedProjects(): string[] {
  const { slug, isAll, projects } = useProjectScope()
  return isAll ? projects.map((p) => p.slug) : [slug]
}

/** The selector itself. Lives in the shell, above the nav. */
export function ProjectScopePicker() {
  const { slug, setSlug, projects } = useProjectScope()

  // Nothing to scope to. Rendering a one-option select would suggest a control that does
  // something, and `ogun project sync` is the actual next step.
  if (projects.length === 0) return null

  return (
    <label className="scope">
      <span>Project</span>
      <select value={slug} onChange={(e) => setSlug(e.target.value)}>
        <option value={ALL}>All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.slug}>
            {p.slug}
          </option>
        ))}
      </select>
    </label>
  )
}
