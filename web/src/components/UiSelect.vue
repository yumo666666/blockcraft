<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useAttrs, useSlots, useId, watch, type CSSProperties, type VNode } from 'vue';

type OptionItem = { value: unknown; label: string; disabled: boolean; key: string | number };

const props = withDefaults(defineProps<{ modelValue?: unknown; disabled?: boolean; required?: boolean }>(), {
  disabled: false,
  required: false,
});
defineOptions({ inheritAttrs: false });
const emit = defineEmits<{
  'update:modelValue': [value: unknown];
  change: [value: unknown];
}>();
const slots = useSlots();
const attrs = useAttrs();
const root = ref<HTMLElement | null>(null);
const control = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const open = ref(false);
const activeIndex = ref(-1);
const menuStyle = ref<CSSProperties>({});
const listId = `select-list-${useId().replace(/:/g, '')}`;

function flatten(nodes: VNode[]): VNode[] {
  const result: VNode[] = [];
  for (const node of nodes) {
    if (node.type === 'option') result.push(node);
    else if (Array.isArray(node.children)) result.push(...flatten(node.children.filter((child): child is VNode => typeof child === 'object' && child !== null)));
  }
  return result;
}

function textOf(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (value && typeof value === 'object' && 'children' in value) return textOf((value as VNode).children);
  return '';
}

const options = computed<OptionItem[]>(() => flatten(slots.default?.() ?? []).map((node, index) => {
  const label = textOf(node.children).trim();
  const value = node.props?.value ?? label;
  return {
    value,
    label,
    disabled: node.props?.disabled === true || node.props?.disabled === '' || node.props?.disabled === 'true',
    key: typeof node.key === 'string' || typeof node.key === 'number' ? node.key : `${index}-${String(value)}`,
  };
}));

function isSameValue(a: unknown, b: unknown) {
  return Object.is(a, b) || (a != null && b != null && String(a) === String(b));
}

const selected = computed(() => options.value.find((option) => isSameValue(option.value, props.modelValue)));
const selectedIndex = computed(() => options.value.findIndex((option) => isSameValue(option.value, props.modelValue)));
const displayValue = computed(() => selected.value?.label ?? (typeof attrs.placeholder === 'string' ? attrs.placeholder : '请选择'));
const activeOptionId = computed(() => activeIndex.value >= 0 ? `${listId}-option-${activeIndex.value}` : undefined);

function scrollActiveIntoView() {
  void nextTick(() => menu.value?.querySelector<HTMLElement>(`#${activeOptionId.value}`)?.scrollIntoView({ block: 'nearest' }));
}

function setActive(index: number) {
  if (activeIndex.value === index) return;
  activeIndex.value = index;
  scrollActiveIntoView();
}

function positionMenu() {
  const rect = control.value?.getBoundingClientRect();
  if (!rect) return;
  const gap = 6;
  const below = Math.max(0, window.innerHeight - rect.bottom - gap - 8);
  const above = Math.max(0, rect.top - gap - 8);
  const desired = Math.min(280, Math.max(100, options.value.length * 40 + 8));
  const openAbove = below < desired && above > below;
  const available = openAbove ? above : below;
  menuStyle.value = {
    left: `${Math.round(rect.left)}px`,
    width: `${Math.round(rect.width)}px`,
    maxHeight: `${Math.max(88, Math.min(280, available))}px`,
    ...(openAbove
      ? { top: 'auto', bottom: `${Math.max(8, Math.round(window.innerHeight - rect.top + gap))}px` }
      : { top: `${Math.round(rect.bottom + gap)}px`, bottom: 'auto' }),
  };
}

function firstEnabledIndex(fromEnd = false) {
  const indexes = options.value.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
  return indexes.length ? indexes[fromEnd ? indexes.length - 1 : 0] : -1;
}

function showMenu(edge?: 'first' | 'last') {
  if (props.disabled || !options.value.length) return;
  open.value = true;
  activeIndex.value = edge === 'first'
    ? firstEnabledIndex()
    : edge === 'last'
      ? firstEnabledIndex(true)
      : options.value[selectedIndex.value]?.disabled === false
        ? selectedIndex.value
        : firstEnabledIndex();
  positionMenu();
  scrollActiveIntoView();
}

function hideMenu() {
  open.value = false;
  activeIndex.value = -1;
}

function choose(option: OptionItem) {
  if (option.disabled) return;
  emit('update:modelValue', option.value);
  emit('change', option.value);
  hideMenu();
  void nextTick(() => control.value?.focus({ preventScroll: true }));
}

function moveActive(step: number) {
  if (!open.value) {
    showMenu(step < 0 ? 'last' : 'first');
    return;
  }
  const count = options.value.length;
  if (!count) return;
  let index = activeIndex.value;
  for (let attempt = 0; attempt < count; attempt += 1) {
    index = (index + step + count) % count;
    if (!options.value[index]?.disabled) {
      setActive(index);
      return;
    }
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveActive(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    if (!open.value) showMenu('first');
    else setActive(firstEnabledIndex());
  } else if (event.key === 'End') {
    event.preventDefault();
    if (!open.value) showMenu('last');
    else setActive(firstEnabledIndex(true));
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (!open.value) showMenu();
    else if (options.value[activeIndex.value]) choose(options.value[activeIndex.value]);
  } else if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    hideMenu();
  } else if (event.key === 'Tab' && open.value) {
    hideMenu();
  }
}

function onOutsidePointer(event: PointerEvent) {
  const target = event.target;
  if (target instanceof Node && (root.value?.contains(target) || menu.value?.contains(target))) return;
  hideMenu();
}

function onViewportChange() {
  if (open.value) positionMenu();
}

watch(() => props.disabled, (disabled) => { if (disabled) hideMenu(); });
onMounted(() => {
  document.addEventListener('pointerdown', onOutsidePointer, true);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
});
</script>

<template>
  <div ref="root" class="ui-select" :class="{ 'is-open': open }">
    <button
      ref="control"
      v-bind="$attrs"
      type="button"
      class="ui-select-control input select"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open ? activeOptionId : undefined"
      :aria-required="required ? 'true' : undefined"
      :disabled="disabled"
      @click="open ? hideMenu() : showMenu()"
      @keydown="onKeydown"
    >
      <span class="ui-select-value">{{ displayValue }}</span>
      <svg class="ui-select-chevron" :class="{ rotated: open }" aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    <Teleport to="body">
      <div v-if="open" :id="listId" ref="menu" class="ui-select-menu" role="listbox" :style="menuStyle">
        <button
          v-for="(option, index) in options"
          :id="`${listId}-option-${index}`"
          :key="option.key"
          type="button"
          tabindex="-1"
          class="ui-select-option"
          :class="{ active: index === activeIndex, selected: isSameValue(option.value, modelValue) }"
          role="option"
          :aria-selected="isSameValue(option.value, modelValue)"
          :disabled="option.disabled"
          @pointermove="setActive(index)"
          @mousedown.prevent
          @click="choose(option)"
        >
          <span>{{ option.label }}</span>
          <svg v-if="isSameValue(option.value, modelValue)" class="ui-select-check" aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="m3.5 8.3 3 3 6-6.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.ui-select { position: relative; display: block; width: 100%; min-width: 0; }
.ui-select-control { display: flex; align-items: center; justify-content: space-between; gap: 10px; text-align: left; cursor: pointer; }
.ui-select-control.select { padding-right: 11px; background-image: none; }
:global(:root[data-theme='dark']) .ui-select-control.select { background-image: none; }
.ui-select-control:disabled { cursor: not-allowed; }
.ui-select-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-select-chevron { flex: 0 0 auto; color: var(--text-3); transition: transform .16s ease; }
.ui-select-chevron.rotated { transform: rotate(180deg); }
.ui-select-menu { position: fixed; z-index: 200; display: grid; gap: 2px; overflow: auto; overscroll-behavior: contain; scrollbar-width: none; -ms-overflow-style: none; padding: 5px; border: 1px solid var(--border-strong); border-radius: var(--r); background: var(--surface-solid); color: var(--text); box-shadow: var(--sh-3); backdrop-filter: blur(18px) saturate(145%); -webkit-backdrop-filter: blur(18px) saturate(145%); }
.ui-select-menu::-webkit-scrollbar { display: none; }
.ui-select-option { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 34px; padding: 7px 10px; border: 0; border-radius: var(--r-xs); background: transparent; color: var(--text-2); font: inherit; font-size: 13px; text-align: left; cursor: pointer; transition: background-color .12s ease, color .12s ease; }
.ui-select-option > span { min-width: 0; overflow-wrap: anywhere; }
.ui-select-option:hover, .ui-select-option.active { background: var(--surface-hover); color: var(--text); }
.ui-select-option.selected { background: var(--accent-soft); color: var(--accent-strong, var(--accent)); font-weight: 600; }
.ui-select-option:disabled { opacity: .48; cursor: not-allowed; }
.ui-select-check { flex: 0 0 auto; }
@media (prefers-reduced-motion: reduce) { .ui-select-chevron, .ui-select-option { transition: none; } }
</style>
