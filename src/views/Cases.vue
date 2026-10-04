<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTestStore, deepClone } from '../store'
import { topoLayers } from '../graph'
import type { TestStep } from '../types'

const store = useTestStore()
const editMode = ref(false)
const selectedCase = computed(() => store.selectedCase)
const draftSteps = ref<TestStep[]>([])
const baseRevision = ref(0)
const conflict = computed(() => store.conflictDrafts.find((draft) => draft.caseId === store.selectedCaseId))
const layers = computed(() => topoLayers(selectedCase.value?.steps ?? []))
const edges = computed(() => (selectedCase.value?.steps ?? []).flatMap((step) => step.dependencies.map((dep) => ({ from:dep, to:step.id }))))

function beginDraft() {
  draftSteps.value = deepClone(selectedCase.value?.steps ?? [])
  baseRevision.value = selectedCase.value?.revision ?? 0
}
watch([editMode, () => store.selectedCaseId], () => { if (editMode.value) beginDraft() }, { immediate:true })

function depOptions(stepId: string) {
  return (selectedCase.value?.steps ?? []).filter((step) => step.id !== stepId).map((step) => ({ label:`${step.id} · ${step.action}`, value:step.id }))
}
function save() {
  const result = store.saveCaseGraph(store.selectedCaseId, draftSteps.value, baseRevision.value, '当前编排员')
  if (result.ok) editMode.value = false
  else if (result.reason === 'cycle') beginDraft()
}
function reapplyConflict() {
  store.resolveConflict(store.selectedCaseId, 'reapply')
  if (!conflict.value) beginDraft()
}
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">步骤、预期与依赖</p><h1>测试用例编排</h1><p>步骤支持多前置并行编排，保存前自动查环；预期变更会按依赖关系传递失效，版本冲突保留双方草稿。</p></div><n-space><n-switch v-model:value="editMode">批量编辑模式</n-switch><n-button @click="store.simulateExternalSave(store.selectedCaseId)">模拟协同编排员保存</n-button><n-button @click="store.failNextPersist = true">注入写入失败</n-button><n-button type="primary">新增用例</n-button></n-space></section>
  <n-alert v-if="store.graphNotice" :type="store.graphNotice.type" :title="store.graphNotice.text" closable @close="store.graphNotice = null" style="margin-bottom:14px" />
  <n-alert v-if="conflict" type="warning" style="margin-bottom:14px" :title="`版本冲突：${conflict.editor} 基于版本 ${conflict.baseRevision} 的修改未生效`" :description="`当前生效版本 ${selectedCase?.revision}。可放弃该草稿，或以最新关系为基准重新应用（仍会查环）。`">
    <template #action><n-space><n-button size="small" @click="store.resolveConflict(store.selectedCaseId,'discard')">放弃草稿</n-button><n-button size="small" type="warning" @click="reapplyConflict">以最新关系重放草稿</n-button></n-space></template>
  </n-alert>
  <div class="case-grid"><aside class="card case-list"><n-input placeholder="搜索用例、进路或设备" clearable /><button v-for="item in store.cases" :key="item.id" :class="{active:item.id===store.selectedCaseId}" @click="store.selectCase(item.id)"><div><b>{{item.id}}</b><small>{{item.name}}</small></div><n-tag :type="item.status==='通过'?'success':item.status==='失败'?'error':item.status==='阻塞'?'warning':'info'">{{item.status}}</n-tag></button></aside>
    <article class="card detail" v-if="selectedCase"><div class="panel-head"><div><h2>{{selectedCase.id}} · {{selectedCase.name}}</h2><p>{{selectedCase.precondition}}</p></div><n-space><n-tag>图版本 {{selectedCase.revision}}</n-tag><n-tag type="info">{{selectedCase.version}}</n-tag></n-space></div><n-alert v-if="selectedCase.failureReason" type="error" title="当前阻塞 / 失败原因" :description="selectedCase.failureReason" /><h3>执行步骤与依赖</h3>
      <template v-if="!editMode"><div v-for="(step,index) in selectedCase.steps" :key="step.id" class="step"><div class="step-index">{{index+1}}</div><div class="step-main"><div class="step-head"><b>{{step.action}}</b><n-space size="small"><n-tag v-if="step.invalidation" type="warning">已失效</n-tag><n-tag :type="step.result==='通过'?'success':step.result==='失败'?'error':'info'">{{step.result}}</n-tag></n-space></div><p>预期：{{step.expected}}</p><small v-if="step.dependencies.length">前置步骤：{{step.dependencies.join('、')}}</small><small v-if="step.invalidation">失效触发：关系 {{step.invalidation.edge}}（{{step.invalidation.source}} 预期变更 · {{step.invalidation.at}}），原证据已保留</small><small v-if="step.actual">实测：{{step.actual}}</small><small v-if="step.evidence">证据：{{step.evidence}}</small></div></div></template>
      <template v-else><div v-for="(step,index) in draftSteps" :key="step.id" class="step"><div class="step-index">{{index+1}}</div><div class="step-main"><div class="step-head"><b>{{step.id}} · {{step.action}}</b><n-tag size="small">{{step.result}}</n-tag></div><n-form label-placement="top" size="small"><n-form-item :label="`预期结果（变更将失效下游 ${step.id} 的全部依赖步骤）`"><n-input v-model:value="step.expected" /></n-form-item><n-form-item label="前置步骤（可多选，全部通过后才可执行）"><n-select v-model:value="step.dependencies" multiple clearable :options="depOptions(step.id)" /></n-form-item></n-form></div></div><n-space style="margin:10px 0 16px"><n-button type="primary" @click="save">保存依赖图</n-button><n-button @click="beginDraft">还原草稿</n-button></n-space></template>
      <n-divider /><div class="dependency"><b>依赖图（同层步骤可并行执行）</b><div v-for="(layer,level) in layers" :key="level" class="layer-row"><span class="layer-tag">第{{level+1}}层</span><div class="nodes"><span v-for="id in layer" :key="id">{{id}}</span></div></div><div class="lines"><n-tag v-for="edge in edges" :key="edge.from+edge.to" size="small" style="margin:0 6px 6px 0">{{edge.from}} → {{edge.to}}</n-tag></div><div class="lines">全部前置通过后才允许执行后续步骤 · 成环保存会被拒绝并保留原图</div></div></article></div>
</template>
