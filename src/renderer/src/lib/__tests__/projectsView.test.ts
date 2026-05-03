import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  applyProjectsView,
  loadProjectsViewState,
  saveProjectsViewState,
  DEFAULT_VIEW_STATE,
  PROJECTS_VIEW_STORAGE_KEY,
  SORT_MODES,
  type ProjectsViewState,
  type SortMode
} from '../projectsView'

interface TestProject {
  name: string
  createdAt: string
  favorite?: boolean
}

const sampleProjects: TestProject[] = [
  { name: 'apple', createdAt: '2026-01-10T00:00:00Z', favorite: true },
  { name: 'banana', createdAt: '2026-03-15T00:00:00Z', favorite: false },
  { name: 'cherry', createdAt: '2026-02-20T00:00:00Z', favorite: true },
  { name: 'durian', createdAt: '2026-04-01T00:00:00Z' },
  { name: 'elderberry', createdAt: '2026-01-05T00:00:00Z', favorite: false }
]

function names(projects: TestProject[]): string[] {
  return projects.map((p) => p.name)
}

function makeMockLocalStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      store.set(k, v)
    },
    removeItem: (k: string): void => {
      store.delete(k)
    },
    clear: (): void => {
      store.clear()
    },
    key: (i: number): string | null => Array.from(store.keys())[i] ?? null,
    get length(): number {
      return store.size
    }
  } as Storage
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeMockLocalStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('applyProjectsView - filtering', () => {
  it('TC1: filterFavoritesOnly=true returns only favorite=true projects', () => {
    const result = applyProjectsView(sampleProjects, {
      filterFavoritesOnly: true,
      sortMode: 'nameAsc'
    })
    expect(names(result)).toEqual(['apple', 'cherry'])
  })

  it('TC2: filterFavoritesOnly=false returns all projects', () => {
    const result = applyProjectsView(sampleProjects, {
      filterFavoritesOnly: false,
      sortMode: 'nameAsc'
    })
    expect(result).toHaveLength(sampleProjects.length)
  })

  it('TC7: filter ON with zero favorites yields empty array', () => {
    const noFavs: TestProject[] = [
      { name: 'a', createdAt: '2026-01-01T00:00:00Z' },
      { name: 'b', createdAt: '2026-01-02T00:00:00Z', favorite: false }
    ]
    const result = applyProjectsView(noFavs, {
      filterFavoritesOnly: true,
      sortMode: 'dateDesc'
    })
    expect(result).toEqual([])
  })

  it('TC8: filter ON with all favorites returns all', () => {
    const allFavs: TestProject[] = [
      { name: 'a', createdAt: '2026-01-01T00:00:00Z', favorite: true },
      { name: 'b', createdAt: '2026-01-02T00:00:00Z', favorite: true }
    ]
    const result = applyProjectsView(allFavs, {
      filterFavoritesOnly: true,
      sortMode: 'nameAsc'
    })
    expect(result).toHaveLength(2)
  })
})

describe('applyProjectsView - sorting', () => {
  it('TC3a: sortMode=dateDesc orders by createdAt newest first', () => {
    const result = applyProjectsView(sampleProjects, {
      filterFavoritesOnly: false,
      sortMode: 'dateDesc'
    })
    expect(names(result)).toEqual(['durian', 'banana', 'cherry', 'apple', 'elderberry'])
  })

  it('TC3b: sortMode=dateAsc orders by createdAt oldest first', () => {
    const result = applyProjectsView(sampleProjects, {
      filterFavoritesOnly: false,
      sortMode: 'dateAsc'
    })
    expect(names(result)).toEqual(['elderberry', 'apple', 'cherry', 'banana', 'durian'])
  })

  it('TC3c: sortMode=nameAsc orders by name A-Z', () => {
    const result = applyProjectsView(sampleProjects, {
      filterFavoritesOnly: false,
      sortMode: 'nameAsc'
    })
    expect(names(result)).toEqual(['apple', 'banana', 'cherry', 'durian', 'elderberry'])
  })

  it('TC3d: sortMode=nameDesc orders by name Z-A', () => {
    const result = applyProjectsView(sampleProjects, {
      filterFavoritesOnly: false,
      sortMode: 'nameDesc'
    })
    expect(names(result)).toEqual(['elderberry', 'durian', 'cherry', 'banana', 'apple'])
  })

  it('TC3e: sortMode=favoritesFirst puts favorites at top, then dateDesc within', () => {
    const result = applyProjectsView(sampleProjects, {
      filterFavoritesOnly: false,
      sortMode: 'favoritesFirst'
    })
    expect(names(result)).toEqual(['cherry', 'apple', 'durian', 'banana', 'elderberry'])
  })
})

describe('applyProjectsView - edge cases', () => {
  it('TC6: empty projects array yields empty array (no error)', () => {
    expect(applyProjectsView([], { filterFavoritesOnly: false, sortMode: 'dateDesc' })).toEqual([])
    expect(
      applyProjectsView([], { filterFavoritesOnly: true, sortMode: 'favoritesFirst' })
    ).toEqual([])
  })

  it('TC9: same name uses createdAt as tiebreaker (nameAsc -> newer first)', () => {
    const dupName: TestProject[] = [
      { name: 'same', createdAt: '2026-01-01T00:00:00Z' },
      { name: 'same', createdAt: '2026-03-01T00:00:00Z' },
      { name: 'same', createdAt: '2026-02-01T00:00:00Z' }
    ]
    const result = applyProjectsView(dupName, {
      filterFavoritesOnly: false,
      sortMode: 'nameAsc'
    })
    expect(result.map((p) => p.createdAt)).toEqual([
      '2026-03-01T00:00:00Z',
      '2026-02-01T00:00:00Z',
      '2026-01-01T00:00:00Z'
    ])
  })

  it('TC10: same createdAt uses name as tiebreaker (dateDesc -> name asc)', () => {
    const sameDate: TestProject[] = [
      { name: 'charlie', createdAt: '2026-01-01T00:00:00Z' },
      { name: 'alpha', createdAt: '2026-01-01T00:00:00Z' },
      { name: 'bravo', createdAt: '2026-01-01T00:00:00Z' }
    ]
    const result = applyProjectsView(sameDate, {
      filterFavoritesOnly: false,
      sortMode: 'dateDesc'
    })
    expect(names(result)).toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('TC11: Japanese names sort with locale-aware comparison', () => {
    const jp: TestProject[] = [
      { name: 'さくら', createdAt: '2026-01-01T00:00:00Z' },
      { name: 'あさがお', createdAt: '2026-01-02T00:00:00Z' },
      { name: 'ばら', createdAt: '2026-01-03T00:00:00Z' }
    ]
    const result = applyProjectsView(jp, {
      filterFavoritesOnly: false,
      sortMode: 'nameAsc'
    })
    expect(names(result)[0]).toBe('あさがお')
  })

  it('does not mutate the input array', () => {
    const original = [...sampleProjects]
    applyProjectsView(sampleProjects, {
      filterFavoritesOnly: true,
      sortMode: 'nameDesc'
    })
    expect(sampleProjects).toEqual(original)
  })
})

describe('localStorage persistence', () => {
  it('TC4: round-trip through localStorage preserves state', () => {
    const state: ProjectsViewState = {
      filterFavoritesOnly: true,
      sortMode: 'favoritesFirst'
    }
    saveProjectsViewState(state)
    expect(loadProjectsViewState()).toEqual(state)
  })

  it('TC13: missing localStorage key returns DEFAULT_VIEW_STATE', () => {
    expect(loadProjectsViewState()).toEqual(DEFAULT_VIEW_STATE)
  })

  it('TC12: invalid JSON returns DEFAULT_VIEW_STATE', () => {
    localStorage.setItem(PROJECTS_VIEW_STORAGE_KEY, '{not valid json')
    expect(loadProjectsViewState()).toEqual(DEFAULT_VIEW_STATE)
  })

  it('TC12b: unknown sortMode value falls back to default sortMode', () => {
    localStorage.setItem(
      PROJECTS_VIEW_STORAGE_KEY,
      JSON.stringify({ filterFavoritesOnly: true, sortMode: 'bogus' })
    )
    const result = loadProjectsViewState()
    expect(result.filterFavoritesOnly).toBe(true)
    expect(result.sortMode).toBe(DEFAULT_VIEW_STATE.sortMode)
  })

  it('TC12c: non-boolean filter falls back to default filter', () => {
    localStorage.setItem(
      PROJECTS_VIEW_STORAGE_KEY,
      JSON.stringify({ filterFavoritesOnly: 'yes', sortMode: 'nameAsc' })
    )
    const result = loadProjectsViewState()
    expect(result.filterFavoritesOnly).toBe(DEFAULT_VIEW_STATE.filterFavoritesOnly)
    expect(result.sortMode).toBe('nameAsc')
  })

  it('SORT_MODES contains exactly the expected 5 modes', () => {
    const expected: SortMode[] = ['dateDesc', 'dateAsc', 'nameAsc', 'nameDesc', 'favoritesFirst']
    expect([...SORT_MODES]).toEqual(expected)
  })
})
