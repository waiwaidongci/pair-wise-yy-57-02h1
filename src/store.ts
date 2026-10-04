import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ConflictDraft, ExecutionRecord, TestCase, TestStep } from './types'
import { seedCases, seedExecutions } from './mock'
import { downstreamOf, findCycle, normalizeSteps, relationChain, topologicalLayers } from './graph'

const STORAGE_KEY = 'yy57-interlocking-draft-v1'

/** 用例数据升级：补 rev，旧单前置 dependency 并入 dependencies（保持原顺序）。 */
function normalizeCase(raw: any): TestCase {
  return {
    ...raw,
    steps: normalizeSteps(raw?.steps),
    rev: typeof raw?.rev === 'number' ? raw.rev : 1,
  }
}

export const useTestStore = defineStore('interlocking', () => {
  const cases = ref<TestCase[]>(seedCases.map(normalizeCase))
  const executions = ref<ExecutionRecord[]>(structuredClone(seedExecutions))
  const selectedCaseId = ref('TC-102')
  const selectedRouteIds = ref<string[]>(['R-02'])
  const baselineLocked = ref(false)
  const connection = ref<'在线' | '重连中'>('在线')
  const pendingRetry = ref(0)
  const liveMessage = ref('执行进度已同步')
  /** 并发保存时后到者保留的冲突草稿 */
  const conflictDrafts = ref<ConflictDraft[]>([])
  /** 演示开关：武装后下次保存模拟写入中断，验证按已完成关系恢复 */
  const writeFailureArmed = ref(false)

  const selectedCase = computed(() => cases.value.find((item) => item.id === selectedCaseId.value))
  const progress = computed(() => {
    const steps = cases.value.flatMap((item) => item.steps)
    const done = steps.filter((step) => step.result === '通过' || step.result === '失败').length
    return steps.length ? Math.round(done / steps.length * 100) : 0
  })
  const changedDevices = ['P-02 转辙机更换', 'T-03 绝缘节调整']
  const affectedCases = computed(() => cases.value.filter((item) => item.routeIds.some((routeId) => ['R-02','R-04'].includes(routeId))))

  /** 拓扑分层：同层步骤前置均已满足，可并行执行。 */
  function layersOf(caseId: string): string[][] {
    const item = cases.value.find((c) => c.id === caseId)
    return item ? topologicalLayers(item.steps) : []
  }
  /** 失败步骤的下游失效范围（直接 + 传递依赖）。 */
  function failureScope(caseId: string): string[] {
    const item = cases.value.find((c) => c.id === caseId)
    if (!item) return []
    const scope = new Set<string>()
    item.steps.filter((s) => s.result === '失败').forEach((s) => {
      downstreamOf(item.steps, s.id).forEach((d) => scope.add(d))
    })
    return [...scope]
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ cases: cases.value, executions: executions.value, conflictDrafts: conflictDrafts.value }))
  }
  function restore() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const draft = JSON.parse(raw)
    if (Array.isArray(draft.cases)) cases.value = draft.cases.map(normalizeCase)
    if (Array.isArray(draft.executions)) executions.value = draft.executions
    if (Array.isArray(draft.conflictDrafts)) conflictDrafts.value = draft.conflictDrafts
  }
  function selectCase(id: string) {
    selectedCaseId.value = id
    selectedRouteIds.value = cases.value.find((item) => item.id === id)?.routeIds ?? []
  }

  /** 执行步骤：多条前置全部通过才允许，未满足时点名是哪条关系触发拦截。 */
  function setStepResult(caseId: string, stepId: string, result: TestStep['result'], actual?: string): boolean {
    if (baselineLocked.value) return false
    const item = cases.value.find((entry) => entry.id === caseId)
    const step = item?.steps.find((entry) => entry.id === stepId)
    if (!item || !step) return false
    if (result !== '通过' && result !== '失败') return false
    const unmet = (step.dependencies ?? []).find((depId) => item.steps.find((entry) => entry.id === depId)?.result !== '通过')
    if (unmet) {
      liveMessage.value = `前置步骤 ${unmet} 未通过，关系 ${unmet} → ${step.id} 未满足，禁止跳过`
      return false
    }
    step.result = result
    step.actual = actual ?? step.actual
    step.invalidReason = undefined
    item.status = item.steps.some((entry) => entry.result === '失败') ? '失败' : item.steps.every((entry) => entry.result === '通过') ? '通过' : '执行中'
    persist()
    return true
  }

  /**
   * 编排保存：步骤依赖多个前置。
   * 1. 保存前查环路，发现环路拒绝写入并保留原图；
   * 2. 并发控制：baseRev 与当前修订一致才写入，先到关系生效；不一致则草稿保留为冲突草稿；
   * 3. 原子写入：写入失败按已完成关系恢复，不留半张依赖图；
   * 4. 预期变更传导：下游步骤立即失效，其他通过结果与证据保留。
   */
  function saveCaseSteps(caseId: string, nextSteps: TestStep[], baseRev: number, operator = '编排员'): { ok: boolean; reason?: string; conflict?: boolean; invalidated?: string[]; rev?: number } {
    const item = cases.value.find((c) => c.id === caseId)
    if (!item) return { ok: false, reason: '用例不存在' }
    const draft = normalizeSteps(nextSteps)
    // 1. 环路检测
    const cycle = findCycle(draft)
    if (cycle) {
      liveMessage.value = `依赖关系存在环路（${cycle.join(' → ')}），本次保存已拒绝，原图保留`
      return { ok: false, reason: 'cycle' }
    }
    // 2. 并发控制：先到关系生效，后到者留冲突草稿
    if (baseRev !== item.rev) {
      conflictDrafts.value.unshift({
        id: `CD-${Date.now().toString().slice(-6)}`,
        caseId,
        baseRev,
        savedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
        operator,
        steps: structuredClone(draft),
      })
      liveMessage.value = `保存冲突：${operator} 基于旧版本 r${baseRev} 的草稿未生效，已保留为冲突草稿；当前 r${item.rev} 关系先生效`
      persist()
      return { ok: false, conflict: true }
    }
    // 3. 原子写入：失败回滚到已完成关系
    const snapshot = structuredClone(item.steps)
    try {
      if (writeFailureArmed.value) {
        writeFailureArmed.value = false
        throw new Error('模拟写入中断')
      }
      const oldExpected = new Map(item.steps.map((s) => [s.id, s.expected]))
      item.steps = draft
      // 4. 预期变更 → 下游立即失效（其他通过结果与证据保留）
      const invalidated: string[] = []
      draft.forEach((s) => {
        if (!oldExpected.has(s.id) || oldExpected.get(s.id) === s.expected) return
        downstreamOf(draft, s.id).forEach((downId) => {
          const target = draft.find((t) => t.id === downId)
          if (!target || target.result === '失效') return
          const chain = relationChain(draft, s.id, downId) ?? [s.id, downId]
          target.result = '失效'
          target.invalidReason = `前置 ${s.id} 预期变更，关系 ${chain.join(' → ')} 触发失效`
          invalidated.push(downId)
        })
      })
      item.rev += 1
      item.status = item.steps.some((s) => s.result === '失败') ? '失败' : item.steps.every((s) => s.result === '通过') ? '通过' : '执行中'
      liveMessage.value = invalidated.length
        ? `用例 ${caseId} 依赖关系已保存至 r${item.rev}；${invalidated.join('、')} 因预期变更失效，其他结果与证据已保留`
        : `用例 ${caseId} 依赖关系已保存至 r${item.rev}`
      persist()
      return { ok: true, rev: item.rev, invalidated }
    } catch {
      item.steps = snapshot
      liveMessage.value = '写入中途失败，已按已完成关系恢复，依赖图保持完整'
      persist()
      return { ok: false, reason: 'write-failed' }
    }
  }

  function discardConflict(draftId: string) {
    conflictDrafts.value = conflictDrafts.value.filter((d) => d.id !== draftId)
    persist()
  }

  function startExecution() {
    const item = selectedCase.value
    if (!item) return
    item.status = '执行中'
    executions.value.unshift({ id:`EX-${Date.now().toString().slice(-6)}`, caseId:item.id, operator:'当前用户', startedAt:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}), snapshot:'v26.10 / CS-LEU-09', result:'执行中', evidence:[] })
    persist()
  }
  function updateLiveProgress(value: number) {
    liveMessage.value = value >= 100 ? '全部用例执行完成，等待审核锁定' : `实时同步：已完成 ${value}%`
    if (value >= 100) {
      const active = executions.value.find((item) => item.result === '执行中')
      if (active) { active.result = '失败'; active.finishedAt = new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}) }
    }
  }
  function simulateDisconnect() { connection.value = '重连中'; pendingRetry.value += 1 }
  function retry() { connection.value = '在线'; pendingRetry.value = 0; liveMessage.value = '断线期间执行记录已补传' }
  function lockBaseline() { baselineLocked.value = true }

  watch(cases, persist, { deep: true })
  restore()

  return {
    cases, executions, selectedCaseId, selectedRouteIds, selectedCase, progress, baselineLocked,
    connection, pendingRetry, liveMessage, changedDevices, affectedCases,
    conflictDrafts, writeFailureArmed,
    layersOf, failureScope,
    selectCase, setStepResult, saveCaseSteps, discardConflict,
    startExecution, updateLiveProgress, simulateDisconnect, retry, lockBaseline,
  }
})
