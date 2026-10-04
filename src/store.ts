import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ConflictDraft, SaveGraphResult, TestCase, TestStatus, TestStep } from './types'
import { collectDownstream, dropCyclicEdges, findCycle, normalizeSteps } from './graph'
import { seedCases, seedExecutions } from './mock'

const STORAGE_KEY = 'yy57-interlocking-draft-v1'
const STORAGE_BACKUP_KEY = 'yy57-interlocking-draft-v1-backup'

function now() { return new Date().toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', hour12:false }) }

/** 深拷贝：响应式 Proxy 无法走 structuredClone，数据均为纯 JSON */
export function deepClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) }

/** 旧数据升级：单前置按原顺序并入多前置，补版本号，剔除悬空/自环/成环边 */
function migrateCase(raw: TestCase): TestCase {
  const steps = dropCyclicEdges(normalizeSteps(raw.steps ?? []))
  return { ...raw, steps, revision: typeof raw.revision === 'number' ? raw.revision : 1 }
}

function computeStatus(item: TestCase, previous: TestStatus): TestStatus {
  if (item.steps.some((step) => step.result === '失败')) return '失败'
  if (item.steps.every((step) => step.result === '通过')) return '通过'
  if (item.steps.every((step) => step.result === '未执行')) return previous === '阻塞' ? '阻塞' : '未执行'
  return '执行中'
}

export const useTestStore = defineStore('interlocking', () => {
  const cases = ref<TestCase[]>(deepClone(seedCases).map(migrateCase))
  const executions = ref(deepClone(seedExecutions))
  const selectedCaseId = ref('TC-102')
  const selectedRouteIds = ref<string[]>(['R-02'])
  const baselineLocked = ref(false)
  const connection = ref<'在线' | '重连中'>('在线')
  const pendingRetry = ref(0)
  const liveMessage = ref('执行进度已同步')
  const conflictDrafts = ref<ConflictDraft[]>([])
  const graphNotice = ref<{ type: 'success' | 'warning' | 'error'; text: string } | null>(null)
  /** 演示用：注入一次持久化失败，验证事务回滚 */
  const failNextPersist = ref(false)
  const selectedCase = computed(() => cases.value.find((item) => item.id === selectedCaseId.value))
  const progress = computed(() => {
    const steps = cases.value.flatMap((item) => item.steps)
    return Math.round(steps.filter((step) => step.result !== '未执行').length / steps.length * 100)
  })
  const changedDevices = ['P-02 转辙机更换', 'T-03 绝缘节调整']
  const affectedCases = computed(() => cases.value.filter((item) => item.routeIds.some((routeId) => ['R-02','R-04'].includes(routeId))))

  /** 事务化写入：失败时返回 false，调用方负责回滚内存状态，不留半张依赖图 */
  function persist(): boolean {
    try {
      if (failNextPersist.value) { failNextPersist.value = false; throw new Error('模拟写入失败') }
      const payload = JSON.stringify({ cases: cases.value, executions: executions.value })
      localStorage.setItem(STORAGE_KEY, payload)
      localStorage.setItem(STORAGE_BACKUP_KEY, payload)
      return true
    } catch { return false }
  }
  function restore() {
    const load = (key: string) => {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const draft = JSON.parse(raw)
      return Array.isArray(draft?.cases) && Array.isArray(draft?.executions) ? draft : null
    }
    let draft: { cases: TestCase[]; executions: typeof executions.value } | null = null
    try { draft = load(STORAGE_KEY) } catch { /* 主存储损坏，尝试备份 */ }
    if (!draft) { try { draft = load(STORAGE_BACKUP_KEY) } catch { /* 备份亦不可用，保留种子数据 */ } }
    if (draft) { cases.value = draft.cases.map(migrateCase); executions.value = draft.executions }
  }
  function selectCase(id: string) { selectedCaseId.value = id; selectedRouteIds.value = cases.value.find((item) => item.id === id)?.routeIds ?? [] }

  /**
   * 保存用例依赖图：先查环（成环则保留原图），再比对版本号（后到者留冲突草稿），
   * 预期变更时传递失效下游步骤并记录触发关系，最后事务化写入，失败回滚。
   */
  function saveCaseGraph(caseId: string, draftSteps: TestStep[], baseRevision: number, editor: string): SaveGraphResult {
    const item = cases.value.find((entry) => entry.id === caseId)
    if (!item) return { ok:false, reason:'persist' }
    const prepared = normalizeSteps(deepClone(draftSteps))
    const cycle = findCycle(prepared)
    if (cycle) {
      graphNotice.value = { type:'error', text:`检测到环路 ${cycle.join(' → ')}，本次保存被拒绝，已保留原依赖图` }
      return { ok:false, reason:'cycle', cycle }
    }
    if (item.revision !== baseRevision) {
      conflictDrafts.value = [...conflictDrafts.value.filter((draft) => draft.caseId !== caseId),
        { caseId, editor, at:now(), baseRevision, steps:prepared }]
      graphNotice.value = { type:'warning', text:`另一编排员的关系（版本 ${item.revision}）已先生效，本次修改已存为冲突草稿` }
      return { ok:false, reason:'conflict' }
    }
    const changed = prepared.filter((next) => item.steps.find((step) => step.id === next.id)?.expected !== next.expected)
    const invalidated: string[] = []
    for (const source of changed) {
      for (const [id, parent] of collectDownstream(prepared, source.id)) {
        const step = prepared.find((entry) => entry.id === id)
        if (step && step.result !== '未执行') {
          step.result = '未执行'
          step.invalidation = { source:source.id, edge:`${parent} → ${id}`, at:now() }
          invalidated.push(id)
        }
      }
    }
    const snapshot = { steps:item.steps, revision:item.revision, status:item.status }
    item.steps = prepared
    item.revision = snapshot.revision + 1
    item.status = computeStatus(item, snapshot.status)
    if (!persist()) {
      item.steps = snapshot.steps
      item.revision = snapshot.revision
      item.status = snapshot.status
      graphNotice.value = { type:'error', text:'写入失败，已按已完成关系恢复，未留下半张依赖图' }
      return { ok:false, reason:'persist' }
    }
    conflictDrafts.value = conflictDrafts.value.filter((draft) => draft.caseId !== caseId)
    graphNotice.value = invalidated.length
      ? { type:'success', text:`依赖图已保存（版本 ${item.revision}）；${invalidated.join('、')} 因预期变更失效，证据已保留` }
      : { type:'success', text:`依赖图已保存（版本 ${item.revision}）` }
    return { ok:true, invalidated }
  }

  function resolveConflict(caseId: string, action: 'discard' | 'reapply') {
    const draft = conflictDrafts.value.find((entry) => entry.caseId === caseId)
    const item = cases.value.find((entry) => entry.id === caseId)
    if (!draft || !item) return
    if (action === 'discard') {
      conflictDrafts.value = conflictDrafts.value.filter((entry) => entry !== draft)
      graphNotice.value = { type:'warning', text:`已放弃 ${draft.editor} 的冲突草稿，保留当前生效关系` }
      return
    }
    const result = saveCaseGraph(caseId, draft.steps, item.revision, draft.editor)
    if (!result.ok && result.reason === 'conflict') conflictDrafts.value = [...conflictDrafts.value.filter((entry) => entry !== draft), draft]
  }

  /** 演示用：模拟另一编排员基于当前版本保存同一用例 */
  function simulateExternalSave(caseId: string) {
    const item = cases.value.find((entry) => entry.id === caseId)
    if (!item) return
    const draft = deepClone(item.steps)
    const target = draft.find((step) => step.id === 'TS-4') ?? draft[0]
    if (target && !target.expected.includes('协同复核')) target.expected += '（协同复核）'
    saveCaseGraph(caseId, draft, item.revision, '协同编排员')
  }

  function setStepResult(caseId: string, stepId: string, result: TestStep['result'], actual?: string) {
    if (baselineLocked.value) return
    const item = cases.value.find((entry) => entry.id === caseId)
    const step = item?.steps.find((entry) => entry.id === stepId)
    if (!item || !step) return
    const unmet = step.dependencies.filter((dep) => item.steps.find((entry) => entry.id === dep)?.result !== '通过')
    if (unmet.length) {
      liveMessage.value = `前置步骤 ${unmet.join('、')} 未通过，禁止跳过`
      return
    }
    step.result = result
    step.actual = actual ?? step.actual
    step.invalidation = undefined
    item.status = item.steps.some((entry) => entry.result === '失败') ? '失败' : item.steps.every((entry) => entry.result === '通过') ? '通过' : '执行中'
    persist()
  }
  function startExecution() {
    const item = selectedCase.value
    if (!item) return
    item.status = '执行中'
    executions.value.unshift({ id:`EX-${Date.now().toString().slice(-6)}`, caseId:item.id, operator:'当前用户', startedAt:now(), snapshot:'v26.10 / CS-LEU-09', result:'执行中', evidence:[] })
    persist()
  }
  function updateLiveProgress(value: number) { liveMessage.value = value >= 100 ? '全部用例执行完成，等待审核锁定' : `实时同步：已完成 ${value}%`; if (value >= 100) { const active = executions.value.find((item) => item.result === '执行中'); if (active) { active.result = '失败'; active.finishedAt = now() } } }
  function simulateDisconnect() { connection.value = '重连中'; pendingRetry.value += 1 }
  function retry() { connection.value = '在线'; pendingRetry.value = 0; liveMessage.value = '断线期间执行记录已补传' }
  function lockBaseline() { baselineLocked.value = true }
  watch(cases, () => persist(), { deep:true })
  restore()
  return { cases, executions, selectedCaseId, selectedRouteIds, selectedCase, progress, baselineLocked, connection, pendingRetry, liveMessage, conflictDrafts, graphNotice, failNextPersist, changedDevices, affectedCases, selectCase, saveCaseGraph, resolveConflict, simulateExternalSave, setStepResult, startExecution, updateLiveProgress, simulateDisconnect, retry, lockBaseline }
})
