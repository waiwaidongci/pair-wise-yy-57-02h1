<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTestStore } from '../store'
import { findCycle, topologicalLayers } from '../graph'
import type { ConflictDraft, TestStep } from '../types'

const store = useTestStore()
const editMode = ref(false)
const selectedCase = computed(() => store.selectedCase)

// 编辑草稿与并发基线
const draftSteps = ref<TestStep[]>([])
const baseRev = ref(1)
const saveError = ref('')
const saveOk = ref('')

function depOptionsFor(stepId: string) {
  return draftSteps.value
    .filter((s) => s.id !== stepId)
    .map((s) => ({ label: `${s.id} · ${s.action}`, value: s.id }))
}

function startEdit() {
  if (!selectedCase.value) return
  draftSteps.value = structuredClone(selectedCase.value.steps)
  baseRev.value = selectedCase.value.rev
  saveError.value = ''
  saveOk.value = ''
  editMode.value = true
}
function toggleEdit(val: boolean) {
  if (val) startEdit()
  else editMode.value = false
}
watch(() => store.selectedCaseId, () => { editMode.value = false; saveError.value = ''; saveOk.value = '' })

function addStep() {
  draftSteps.value.push({ id: `TS-${Date.now().toString().slice(-6)}`, action: '新步骤', expected: '', dependencies: [], result: '未执行' })
}
function removeStep(id: string) {
  draftSteps.value = draftSteps.value
    .filter((s) => s.id !== id)
    .map((s) => ({ ...s, dependencies: (s.dependencies ?? []).filter((d) => d !== id) }))
}

// 保存前实时查环路
const draftCycle = computed(() => findCycle(draftSteps.value))

function save(operator = '编排员', stale = false) {
  if (!selectedCase.value) return
  saveError.value = ''
  saveOk.value = ''
  const res = store.saveCaseSteps(selectedCase.value.id, draftSteps.value, stale ? baseRev.value - 1 : baseRev.value, operator)
  if (res.ok) {
    saveOk.value = `已保存至 r${res.rev}${res.invalidated?.length ? `；${res.invalidated.join('、')} 因预期变更失效，其他结果与证据已保留` : ''}`
    baseRev.value = res.rev!
    editMode.value = false
  } else if (res.conflict) {
    editMode.value = false
  } else if (res.reason === 'cycle') {
    const cycle = findCycle(draftSteps.value) ?? []
    saveError.value = `依赖图存在环路：${cycle.join(' → ')}。本次保存已拒绝，原图保留，请调整依赖后重试。`
  } else if (res.reason === 'write-failed') {
    saveError.value = '写入中途失败，已按已完成关系恢复，依赖图保持完整。'
    draftSteps.value = structuredClone(selectedCase.value.steps)
  }
}

// 冲突草稿：先到关系生效，后到者留草稿
const conflicts = computed(() => store.conflictDrafts.filter((d) => d.caseId === selectedCase.value?.id))
const viewingDraft = ref<ConflictDraft | null>(null)
const showDraftModal = computed({
  get: () => !!viewingDraft.value,
  set: (val: boolean) => { if (!val) viewingDraft.value = null },
})

// 只读视图：拓扑分层（同层可并行）
const layers = computed(() => selectedCase.value ? topologicalLayers(selectedCase.value.steps) : [])
function stepOf(id: string) {
  return selectedCase.value?.steps.find((s) => s.id === id)
}
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">步骤、预期与依赖</p><h1>测试用例编排</h1><p>每个步骤可依赖多个前置，保存前自动检查环路；预期变更后下游步骤立即失效，执行页标明触发关系。</p></div><n-space><n-switch :value="editMode" @update:value="toggleEdit">批量编辑模式</n-switch><n-button type="primary">新增用例</n-button></n-space></section>
  <div class="case-grid"><aside class="card case-list"><n-input placeholder="搜索用例、进路或设备" clearable /><button v-for="item in store.cases" :key="item.id" :class="{active:item.id===store.selectedCaseId}" @click="store.selectCase(item.id)"><div><b>{{item.id}}</b><small>{{item.name}}</small></div><n-tag :type="item.status==='通过'?'success':item.status==='失败'?'error':item.status==='阻塞'?'warning':'info'">{{item.status}}</n-tag></button></aside>
    <article class="card detail" v-if="selectedCase"><div class="panel-head"><div><h2>{{selectedCase.id}} · {{selectedCase.name}}</h2><p>{{selectedCase.precondition}}</p></div><n-space><n-tag type="info">编排修订 r{{selectedCase.rev}}</n-tag><n-tag type="info">{{selectedCase.version}}</n-tag></n-space></div>

      <n-alert v-if="selectedCase.failureReason" type="error" title="当前阻塞 / 失败原因" :description="selectedCase.failureReason" style="margin-bottom:12px" />

      <!-- 冲突草稿：先到关系生效，后到者留草稿 -->
      <div v-if="conflicts.length" class="conflict-banner">
        <n-alert type="warning" title="保存冲突：以下草稿未生效，已保留为冲突草稿">
          <div v-for="draft in conflicts" :key="draft.id" class="conflict-draft">
            <span><b>{{draft.operator}}</b> 基于旧版本 r{{draft.baseRev}}（{{draft.savedAt}}）· {{draft.steps.length}} 步</span>
            <n-space><n-button size="small" @click="viewingDraft=draft">查看草稿</n-button><n-button size="small" type="error" ghost @click="store.discardConflict(draft.id)">丢弃</n-button></n-space>
          </div>
        </n-alert>
      </div>

      <n-alert v-if="saveError" type="error" :title="saveError" style="margin-bottom:12px" />
      <n-alert v-if="saveOk" type="success" :title="saveOk" style="margin-bottom:12px" />
      <n-alert v-if="editMode && draftCycle" type="error" :title="`依赖图存在环路：${draftCycle.join(' → ')}，保存将被拒绝并保留原图`" style="margin-bottom:12px" />

      <div v-if="editMode" class="save-bar">
        <n-button type="primary" :disabled="!!draftCycle" @click="save()">保存依赖关系</n-button>
        <n-button @click="save('顾屿', true)" :disabled="!!draftCycle">模拟顾屿并行保存（旧版本）</n-button>
        <n-switch v-model:value="store.writeFailureArmed">模拟写入中断</n-switch>
        <span class="hint">已保存至 r{{baseRev}}；多前置按依赖分层，同层可并行</span>
      </div>

      <h3>执行步骤与依赖</h3>

      <!-- 只读视图 -->
      <template v-if="!editMode">
        <div v-for="(step,index) in selectedCase.steps" :key="step.id" class="step">
          <div class="step-index">{{index+1}}</div>
          <div class="step-main">
            <div class="step-head"><b>{{step.action}}</b><n-tag :type="step.result==='通过'?'success':step.result==='失败'?'error':step.result==='失效'?'warning':'info'">{{step.result}}</n-tag></div>
            <p>预期：{{step.expected}}</p>
            <div class="dep-edges">
              <span v-for="dep in (step.dependencies ?? [])" :key="dep" class="dep-edge">{{dep}} → {{step.id}}</span>
              <span v-if="!step.dependencies?.length" class="dep-edge root">起始步骤</span>
            </div>
            <n-alert v-if="step.result==='失效' && step.invalidReason" type="warning" :title="step.invalidReason" class="step-invalid" />
            <small v-if="step.actual">实测：{{step.actual}}</small>
            <small v-if="step.evidence">证据：{{step.evidence}}</small>
          </div>
        </div>
      </template>

      <!-- 编辑视图 -->
      <template v-else>
        <div v-for="(step,index) in draftSteps" :key="step.id" class="step-edit">
          <div class="step-index">{{index+1}}</div>
          <div class="fields">
            <n-input v-model:value="step.action" placeholder="执行动作" size="small" />
            <n-input v-model:value="step.expected" type="textarea" :rows="2" placeholder="预期结果（变更后下游步骤立即失效）" size="small" />
            <n-select v-model:value="step.dependencies" multiple :options="depOptionsFor(step.id)" size="small" placeholder="前置步骤（可多选，按依赖分层并行）" class="dep-select" />
            <div class="dep-edges">
              <span v-for="dep in (step.dependencies ?? [])" :key="dep" class="dep-edge">{{dep}} → {{step.id}}</span>
              <span v-if="!step.dependencies?.length" class="dep-edge root">起始步骤</span>
            </div>
          </div>
          <n-button size="small" type="error" ghost @click="removeStep(step.id)">删除</n-button>
        </div>
        <n-button size="small" dashed class="add-step" @click="addStep">新增步骤</n-button>
      </template>

      <n-divider />
      <div class="dependency"><b>依赖图</b>
        <div class="dep-graph">
          <div v-for="step in (editMode ? draftSteps : selectedCase.steps)" :key="step.id" class="dep-node">
            <span class="dep-id">{{step.id}}</span>
            <span class="dep-edges">
              <span v-for="dep in (step.dependencies ?? [])" :key="dep" class="dep-edge">{{dep}} → {{step.id}}</span>
              <span v-if="!step.dependencies?.length" class="dep-edge root">起始</span>
            </span>
          </div>
        </div>
        <div class="dep-layers" v-if="layers.length">
          <template v-for="(layer,i) in layers" :key="i">
            <b>第{{i+1}}层（可并行）：</b><span v-for="id in layer" :key="id" class="dep-edge">{{id}}<template v-if="stepOf(id)"> · {{stepOf(id)!.action}}</template></span>
          </template>
        </div>
        <div class="lines">→ 依赖关系 · 前置全部通过才可执行；预期变更沿关系链传导失效</div>
      </div>
    </article></div>

  <n-modal v-model:show="showDraftModal" :title="`冲突草稿 ${viewingDraft?.id ?? ''} · ${viewingDraft?.operator ?? ''}`" style="width:660px">
    <div v-for="step in viewingDraft?.steps ?? []" :key="step.id" class="dep-node" style="margin-bottom:8px">
      <span class="dep-id">{{step.id}}</span>
      <span>{{step.action}}</span>
      <span class="dep-edges">
        <span v-for="dep in (step.dependencies ?? [])" :key="dep" class="dep-edge">{{dep}} → {{step.id}}</span>
        <span v-if="!step.dependencies?.length" class="dep-edge root">起始</span>
      </span>
    </div>
  </n-modal>
</template>
