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

export interface TestStep {
  id: string
  action: string
  expected: string
  /** 前置步骤（可多个），并行编排时按依赖分层执行；旧数据可能缺失，加载时自动升级 */
  dependencies?: string[]
  /** @deprecated 旧版单前置字段，加载时按原顺序并入 dependencies */
  dependency?: string
  result: '未执行' | '通过' | '失败' | '失效'
  actual?: string
  evidence?: string
  /** 失效原因：由哪条关系触发（预期变更沿依赖链传导） */
  invalidReason?: string
}

export interface TestCase {
  id: string
  name: string
  routeIds: string[]
  precondition: string
  version: string
  /** 编排修订号：并发保存时先到关系生效，后到者据此被识别为冲突 */
  rev: number
  status: TestStatus
  steps: TestStep[]
  failureReason?: string
}

/** 两名编排员同时保存同一用例时，后到者保留的冲突草稿 */
export interface ConflictDraft {
  id: string
  caseId: string
  baseRev: number
  savedAt: string
  operator: string
  steps: TestStep[]
}

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
