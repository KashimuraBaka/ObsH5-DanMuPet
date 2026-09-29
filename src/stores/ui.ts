import { defineStore } from 'pinia'
import { ref } from 'vue'

/** The two top-level pages of the app. */
export type PageId = 'animator' | 'extractor'

/**
 * App-level UI state: which page is showing, whether debug UI is enabled, and
 * the name of the sprite frame currently on screen.
 *
 * `isDebug` is read once from the query string - the whole debug surface
 * (right rail, floating panels, overlay) is gated on it.
 */
export const useUiStore = defineStore('ui', () => {
  const currentPage = ref<PageId>('animator')

  const isDebug = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('debug') === 'true'
    : false

  const currentSpriteName = ref('Kirby_51')

  function setPage(page: PageId): void {
    currentPage.value = page
  }

  function setSpriteName(name: string): void {
    currentSpriteName.value = name
  }

  return {
    currentPage,
    isDebug,
    currentSpriteName,
    setPage,
    setSpriteName
  }
})
