export const SORT_MODES = ['dateDesc', 'dateAsc', 'nameAsc', 'nameDesc', 'favoritesFirst'] as const

export type SortMode = (typeof SORT_MODES)[number]

export interface ProjectsViewState {
  filterFavoritesOnly: boolean
  sortMode: SortMode
}

export const DEFAULT_VIEW_STATE: ProjectsViewState = {
  filterFavoritesOnly: false,
  sortMode: 'dateDesc'
}

export const PROJECTS_VIEW_STORAGE_KEY = 'ccpit-projects-view'

function isSortMode(value: unknown): value is SortMode {
  return typeof value === 'string' && (SORT_MODES as readonly string[]).includes(value)
}

export function loadProjectsViewState(): ProjectsViewState {
  try {
    const raw = localStorage.getItem(PROJECTS_VIEW_STORAGE_KEY)
    if (!raw) return DEFAULT_VIEW_STATE
    const parsed = JSON.parse(raw) as Partial<ProjectsViewState>
    return {
      filterFavoritesOnly:
        typeof parsed.filterFavoritesOnly === 'boolean'
          ? parsed.filterFavoritesOnly
          : DEFAULT_VIEW_STATE.filterFavoritesOnly,
      sortMode: isSortMode(parsed.sortMode) ? parsed.sortMode : DEFAULT_VIEW_STATE.sortMode
    }
  } catch {
    return DEFAULT_VIEW_STATE
  }
}

export function saveProjectsViewState(state: ProjectsViewState): void {
  try {
    localStorage.setItem(PROJECTS_VIEW_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // localStorage 不可環境（プライベートモード等）では永続化を諦める
  }
}

interface ProjectViewSubject {
  name: string
  createdAt: string
  favorite?: boolean
}

function compareName(a: ProjectViewSubject, b: ProjectViewSubject): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

function compareDate(a: ProjectViewSubject, b: ProjectViewSubject): number {
  if (a.createdAt < b.createdAt) return -1
  if (a.createdAt > b.createdAt) return 1
  return 0
}

function compareBy(a: ProjectViewSubject, b: ProjectViewSubject, mode: SortMode): number {
  switch (mode) {
    case 'dateDesc': {
      const d = -compareDate(a, b)
      return d !== 0 ? d : compareName(a, b)
    }
    case 'dateAsc': {
      const d = compareDate(a, b)
      return d !== 0 ? d : compareName(a, b)
    }
    case 'nameAsc': {
      const n = compareName(a, b)
      return n !== 0 ? n : -compareDate(a, b)
    }
    case 'nameDesc': {
      const n = -compareName(a, b)
      return n !== 0 ? n : -compareDate(a, b)
    }
    case 'favoritesFirst': {
      const af = a.favorite === true ? 1 : 0
      const bf = b.favorite === true ? 1 : 0
      if (af !== bf) return bf - af
      return -compareDate(a, b)
    }
  }
}

export function applyProjectsView<T extends ProjectViewSubject>(
  projects: readonly T[],
  state: ProjectsViewState
): T[] {
  const filtered = state.filterFavoritesOnly
    ? projects.filter((p) => p.favorite === true)
    : projects
  return [...filtered].sort((a, b) => compareBy(a, b, state.sortMode))
}
