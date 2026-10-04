<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTestStore } from '../store'

const store = useTestStore()
const failureReason = ref('模拟 3G 占用后，S2 信号未立即关闭，联锁日志出现 126ms 延迟')
const evidence = ref('录屏 VID-021、联锁日志 LG-144、CS-LEU-09 设备快照')

const selectedCase = computed(() => store.selectedCase)
const failureScope = computed(() => store.failureScope(selectedCase.value?.id ?? ''))

/** 下一个可执行步骤：前置全部通过的未执行/失效步骤，否则回退到首个未执行步骤（由 store 拦截点名关系）。 */
function targetStep() {
  const item = selectedCase.value
  if (!item) return undefined
  const ready = item.steps.find((s) =>
    (s.result === '未执行' || s.result === '失效') &&
    (s.dependencies ?? []).every((depId) => item.steps.find((t) => t.id === depId)?.result === '通过'),
  )
  return ready ?? item.steps.find((s) => s.result === '未执行' || s.result === '失效')
}
function failStep() {
  const item = selectedCase.value
  const step = targetStep()
  if (item && step && failureReason.value.trim()) store.setStepResult(item.id, step.id, '失败', failureReason.value)
}
function passStep() {
  const item = selectedCase.value
  const step = targetStep()
  if (item && step) store.setStepResult(item.id, step.id, '通过', '预期结果一致，证据已归档')
}
function simulateDisconnect() { store.simulateDisconnect() }
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">实时执行与证据</p><h1>回归执行记录</h1><p>每次执行关联设备快照、证据附件和失败原因；未通过用例不能无痕跳过。</p></div><n-space><n-button @click="simulateDisconnect">模拟断线</n-button><n-button type="success" @click="passStep">记录通过</n-button><n-button type="error" @click="failStep">记录失败</n-button></n-space></section>
  <div class="execution-grid"><article class="card"><div class="panel-head"><div><h2>{{store.selectedCase?.id}} 执行面板</h2><p>{{store.selectedCase?.name}}</p></div><n-tag :type="store.connection==='在线'?'success':'warning'">{{store.connection}} · {{store.liveMessage}}</n-tag></div><n-progress type="line" :percentage="store.progress" :height="12" />

      <n-alert v-if="failureScope.length" type="error" class="scope-alert" :title="`失效范围：${failureScope.join('、')}`" description="失败步骤的下游依赖步骤已被阻塞，前置恢复前不得跳过。" />

      <div v-for="step in store.selectedCase?.steps" :key="step.id" class="execute-step" :class="{ failed: step.result==='失败', invalid: step.result==='失效' }">
        <div>
          <b>{{step.id}} · {{step.action}}</b>
          <small>预期：{{step.expected}}</small>
          <div class="dep-edges">
            <span v-for="dep in (step.dependencies ?? [])" :key="dep" class="dep-edge">{{dep}} → {{step.id}}</span>
            <span v-if="!step.dependencies?.length" class="dep-edge root">起始步骤</span>
            <span v-if="step.result==='未执行' && step.dependencies?.length" class="dep-edge ready">前置已满足 · 可并行</span>
          </div>
          <n-alert v-if="step.result==='失效' && step.invalidReason" type="warning" :title="step.invalidReason" class="step-invalid" />
          <small v-if="step.actual">实测：{{step.actual}}</small>
        </div>
        <n-tag :type="step.result==='通过'?'success':step.result==='失败'?'error':step.result==='失效'?'warning':'info'">{{step.result}}</n-tag>
      </div>
      <n-form label-placement="top"><n-form-item label="失败原因与设备快照"><n-input v-model:value="failureReason" type="textarea" :rows="3" /></n-form-item><n-form-item label="证据附件"><n-input v-model:value="evidence" /></n-form-item></n-form></article>
    <aside class="card"><div class="panel-head"><div><h2>执行历史</h2><p>失败与重测记录不可覆盖</p></div></div><n-timeline><n-timeline-item v-for="record in store.executions" :key="record.id" :type="record.result==='通过'?'success':record.result==='失败'?'error':'info'" :title="`${record.caseId} · ${record.result}`" :content="`${record.operator} ${record.startedAt}${record.finishedAt ? ' → '+record.finishedAt : ''}\n${record.snapshot}\n证据：${record.evidence.join('、') || '采集中'}`" /></n-timeline><n-button block>导出执行报告</n-button></aside></div>
</template>
