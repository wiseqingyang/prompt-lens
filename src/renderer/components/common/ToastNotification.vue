<template>
  <transition
    enter-active-class="transform ease-out duration-300 transition"
    enter-from-class="translate-y-2 opacity-0"
    enter-to-class="translate-y-0 opacity-100"
    leave-active-class="transition ease-in duration-200"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="message"
      class="fixed top-5 right-5 z-50 flex items-center space-x-2 bg-indigo-600 text-white px-4 py-2.5 rounded-xl shadow-2xl border border-indigo-400/40 text-xs font-semibold backdrop-blur-md"
    >
      <i class="fa-solid fa-circle-check text-emerald-300 text-sm"></i>
      <span>{{ message }}</span>
    </div>
  </transition>
</template>

<script setup lang="ts">
defineProps<{
  message: string;
}>();
</script>
