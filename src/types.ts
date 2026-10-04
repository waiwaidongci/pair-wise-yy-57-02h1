export type TestStatus = '未执行' | '执行中' | '通过' | '失败' | '阻塞'

export interface StationDevice {
  id: string
  name: string
  kind: '道岔' | '信号机' | '轨道区段'
  x: number
  y: number
  routeIds: string[]
}

export interface RouteRelation {
  id: string
  name: string
  color: string
  points: [number, number][]
  devices: string[]
  affectedBy: string[]
}

export interface StepInvalidation {
  /** 预期发生变更的根源步骤 */
  source: string
  /** 触发失效的依赖关系，如 'TS-4 → TS-7' */
  edge: string
  at: string
}

export interface TestStep {
  id: string
  action: string
  expected: string
  /** 前置步骤集合，全部通过后才允许执行本步骤 */
  dependencies: string[]
  /** @deprecated 旧版单前置字段，仅在数据迁移时读取 */
  dependency?: string
  result: '未执行' | '通过' | '失败'
  actual?: string
  evidence?: string
  /** 因上游预期变更而失效的记录，重新执行后清除 */
  invalidation?: StepInvalidation
}

export interface TestCase {
  id: string
  name: string
  routeIds: string[]
  precondition: string
  version: string
  status: TestStatus
  steps: TestStep[]
  /** 依赖图版本号，每次成功保存递增，用于并发冲突检测 */
  revision: number
  failureReason?: string
}

export interface ConflictDraft {
  caseId: string
  editor: string
  at: string
  baseRevision: number
  steps: TestStep[]
}

export type SaveGraphResult =
  | { ok: true; invalidated: string[] }
  | { ok: false; reason: 'cycle'; cycle: string[] }
  | { ok: false; reason: 'conflict' }
  | { ok: false; reason: 'persist' }

export interface ExecutionRecord {
  id: string
  caseId: string
  operator: string
  startedAt: string
  finishedAt?: string
  snapshot: string
  result: TestStatus
  evidence: string[]
}
