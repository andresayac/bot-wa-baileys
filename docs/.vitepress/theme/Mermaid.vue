<script lang="ts">
// Shared by every diagram on the site: mermaid is fetched once, on first use.
let counter = 0
let mermaidPromise: Promise<typeof import('mermaid').default> | undefined

function loadMermaid() {
  mermaidPromise ??= import('mermaid').then((m) => m.default)
  return mermaidPromise
}
</script>

<script setup lang="ts">
/**
 * Renders a ```mermaid fence (see `markdown.config` in ../config.ts). The
 * source is passed URI-encoded so Vue never parses it as a template. Until
 * mermaid (loaded lazily, client only) has drawn the diagram, and when it
 * fails, the page shows the diagram source instead.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useData } from 'vitepress'

const props = defineProps<{ code: string }>()

const source = computed(() => decodeURIComponent(props.code))
const svg = ref('')
const failed = ref(false)
const { isDark } = useData()

async function render() {
  try {
    const mermaid = await loadMermaid()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: isDark.value ? 'dark' : 'default',
    })
    const id = `mermaid-${Date.now().toString(36)}-${counter++}`
    const result = await mermaid.render(id, source.value)
    svg.value = result.svg
    failed.value = false
  } catch {
    svg.value = ''
    failed.value = true
  }
}

onMounted(render)
watch([isDark, source], render)
</script>

<template>
  <div class="mermaid-diagram" :class="{ 'mermaid-diagram--failed': failed }">
    <div v-if="svg" class="mermaid-diagram__svg" v-html="svg" />
    <pre v-else class="mermaid-diagram__source"><code>{{ source }}</code></pre>
  </div>
</template>

<style scoped>
.mermaid-diagram {
  margin: 16px 0;
  overflow-x: auto;
}

.mermaid-diagram__svg {
  display: flex;
  justify-content: center;
}

.mermaid-diagram__svg :deep(svg) {
  max-width: 100%;
  height: auto;
}

.mermaid-diagram__source {
  margin: 0;
  padding: 16px;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  font-family: var(--vp-font-family-mono);
  font-size: var(--vp-code-font-size);
  line-height: 1.6;
  white-space: pre;
}
</style>
