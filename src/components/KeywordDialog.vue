<script setup lang="ts">
// 关键词设置：一个开关 + 一个多词输入框。
//
// 规则（docs/design.md §5.1）：
// - 开关关 → 不注册。
// - 开关开 + 填了词 → 用这些词。
// - 开关开 + 没填词 → **用标题当关键词**。
//
// 第三条是最容易让用户困惑的，所以界面上实时把「最终生效的关键词」显示出来，
// 而不是让用户自己推断。
import { computed, nextTick, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { useDocs } from '../composables/useDocs';
import { keywordsOf } from '../lib/keyword';

const props = defineProps<{ nodeId: string }>();
const emit = defineEmits<{ close: [] }>();

const { state, setKeywords } = useDocs();

const meta = computed(() => state.metas.find((m) => m.nodeId === props.nodeId) ?? null);

const enabled = ref(meta.value?.keywordEnabled ?? false);
const words = ref<string[]>([...(meta.value?.keywords ?? [])]);
const draft = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

onMounted(async () => {
  await nextTick();
  if (enabled.value) inputEl.value?.focus();
});

/** 当前设置下实际会注册的关键词，直接复用线上那套规则，避免界面和行为说两套话。 */
const effective = computed(() =>
  meta.value
    ? keywordsOf({ ...meta.value, keywordEnabled: enabled.value, keywords: words.value })
    : [],
);

function addWord(): void {
  const word = draft.value.trim();
  draft.value = '';
  if (!word || words.value.includes(word)) return;
  words.value.push(word);
}

/** 输入框空着时按退格，删掉最后一个词 —— 标签输入的通用手感。 */
function backspace(): void {
  if (draft.value) return;
  words.value.pop();
}

function save(): void {
  if (!meta.value) return;
  // 没来得及按回车的半截输入也算数，否则用户填完直接点保存会丢词。
  const pending = draft.value.trim();
  const all = pending && !words.value.includes(pending) ? [...words.value, pending] : words.value;
  setKeywords(meta.value.nodeId, enabled.value, all);
  emit('close');
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="dialog-head">关键词设置</div>

      <div class="dialog-body">
        <div class="field">
          <label class="field-label">
            <span>注册为 uTools 全局关键词</span>
            <button class="switch" :class="{ on: enabled }" @click="enabled = !enabled" />
          </label>
          <p class="field-hint">
            打开后，在 uTools 主搜索框输入关键词就能直接跳到这篇文档。
          </p>
        </div>

        <div class="field">
          <div class="field-label"><span>关键词</span></div>
          <div class="tags" :class="{ disabled: !enabled }" @click="inputEl?.focus()">
            <span v-for="word in words" :key="word" class="tag">
              {{ word }}
              <button title="移除" @click.stop="words = words.filter((w) => w !== word)">
                <Icon name="close" />
              </button>
            </span>
            <input
              ref="inputEl"
              v-model="draft"
              :placeholder="words.length ? '继续添加' : '留空则用标题'"
              @keydown.enter.prevent="addWord"
              @keydown.,.prevent="addWord"
              @keydown.delete="backspace"
              @blur="addWord"
            />
          </div>
          <p class="field-hint">回车或逗号分隔；可以填多个。</p>
        </div>

        <!-- 实时回显最终效果，省得用户去猜「留空到底会怎样」。 -->
        <div class="field">
          <p v-if="!enabled" class="field-hint">当前不注册，这篇文档不会出现在 uTools 搜索里。</p>
          <p v-else-if="!effective.length" class="field-hint" style="color: var(--danger)">
            标题和关键词都是空的，没法注册。先填个标题，或者在上面填至少一个关键词。
          </p>
          <p v-else-if="!words.length" class="field-hint">
            未填关键词，将用标题
            <strong style="color: var(--primary-strong)">{{ effective[0] }}</strong>
            作为关键词。
          </p>
          <p v-else class="field-hint">
            将注册：
            <strong style="color: var(--primary-strong)">{{ effective.join('、') }}</strong>
          </p>
        </div>
      </div>

      <div class="dialog-foot">
        <button class="btn btn-text" @click="emit('close')">取消</button>
        <button class="btn btn-primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>
