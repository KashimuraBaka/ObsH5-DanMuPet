<template>
  <div class="app-root" :style="rootStyle">
    <!-- Fullscreen stage: canvas / sprite sheet fills the whole page -->
    <div class="stage">
      <KirbyAnimator v-if="ui.currentPage === 'animator'" />
      <SpriteExtractor v-else />
    </div>

    <!-- ===== Right rail + every floating debug panel ===== -->
    <DebugPanels />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import KirbyAnimator from './components/KirbyAnimator.vue'
import SpriteExtractor from './components/SpriteExtractor.vue'
import DebugPanels from './components/DebugPanels.vue'
import { useUiStore } from './stores'

const ui = useUiStore()

// Publish the right rail width as a CSS variable so the page layout adapts.
// The rail itself is debug-only, so production reserves no gutter at all.
const rootStyle = computed(() => ({
  '--panel-w': ui.isDebug ? '48px' : '0px'
}))
</script>

<style scoped>
/* Root: fullscreen stage with floating HUD overlays */
.app-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

/* Stage holds the fullscreen canvas / sprite sheet */
.stage {
  position: absolute;
  inset: 0;
  z-index: 0;
}
</style>
