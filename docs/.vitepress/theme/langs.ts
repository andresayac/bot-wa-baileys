/**
 * Drop-in replacement for the default theme's `composables/langs` module
 * (swapped in by the `bot-wa:locale-links` plugin in ../config.ts).
 *
 * The stock language switcher assumes every page has the same path in every
 * locale (`/guide/flows` <-> `/es/guide/flows`), but the Spanish pages use
 * Spanish slugs (`/es/guide/flujos`). `themeConfig.localeAlternates`, built
 * at config time, holds the real counterpart (or the locale home page) for
 * each page where the naive path does not exist.
 */
import { computed } from 'vue'
import { useData } from 'vitepress'

export type LocaleAlternates = Record<string, Record<string, string>>

function ensureStartingSlash(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

function normalizeLink(link: string, addPath: boolean, path: string, addExt: boolean): string {
  return addPath
    ? link.replace(/\/$/, '') +
        ensureStartingSlash(path.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, addExt ? '.html' : ''))
    : link
}

export function useLangs({ correspondingLink = false } = {}) {
  const { site, localeIndex, page, theme, hash } = useData()
  const currentLang = computed(() => ({
    label: site.value.locales[localeIndex.value]?.label,
    link: site.value.locales[localeIndex.value]?.link || (localeIndex.value === 'root' ? '/' : `/${localeIndex.value}/`),
  }))

  const localeLinks = computed(() =>
    Object.entries(site.value.locales).flatMap(([key, value]) => {
      if (currentLang.value.label === value.label) return []
      const corresponding = theme.value.i18nRouting !== false && correspondingLink
      const alternates = theme.value.localeAlternates as LocaleAlternates | undefined
      const alternate = corresponding ? alternates?.[page.value.relativePath]?.[key] : undefined
      // Anchors differ between translations, so the hash is only kept for same-path pages.
      if (alternate) return { text: value.label, link: alternate }
      return {
        text: value.label,
        link:
          normalizeLink(
            value.link || (key === 'root' ? '/' : `/${key}/`),
            corresponding,
            page.value.relativePath.slice(currentLang.value.link.length - 1),
            !site.value.cleanUrls,
          ) + hash.value,
      }
    }),
  )

  return { localeLinks, currentLang }
}
