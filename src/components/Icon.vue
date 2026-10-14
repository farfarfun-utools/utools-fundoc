<script setup lang="ts">
import { ICON_PATHS, type IconName } from './icons';

const props = defineProps<{ name: IconName }>();
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, index) in ICON_PATHS[props.name]" :key="index" :d="d" />
  </svg>
</template>
