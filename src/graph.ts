import type { TestStep } from './types'

/**
 * 旧数据升级：单前置 dependency → 多前置 dependencies，保持原顺序。
 * 旧草稿/旧用例只有单前置时按原顺序并入数组。
 */
export function normalizeSteps(raw: any): TestStep[] {
  if (!Array.isArray(raw)) return []
  return raw.map((s: any) => ({
    id: String(s.id),
    action: typeof s.action === 'string' ? s.action : '',
    expected: typeof s.expected === 'string' ? s.expected : '',
    dependencies: Array.isArray(s.dependencies)
      ? s.dependencies.map((d: any) => String(d))
      : (s.dependency ? [String(s.dependency)] : []),
    result: (['未执行', '通过', '失败', '失效'].includes(s.result) ? s.result : '未执行') as TestStep['result'],
    actual: typeof s.actual === 'string' ? s.actual : undefined,
    evidence: typeof s.evidence === 'string' ? s.evidence : undefined,
    invalidReason: typeof s.invalidReason === 'string' ? s.invalidReason : undefined,
  }))
}

/**
 * 环路检测（依赖图不允许成环）。
 * 采用三色标记 DFS，返回环路径（如 ['TS-3','TS-5','TS-3']），无环返回 null。
 */
export function findCycle(steps: TestStep[]): string[] | null {
  const ids = new Set(steps.map((s) => s.id))
  const adj = new Map<string, string[]>()
  steps.forEach((s) => adj.set(s.id, (s.dependencies ?? []).filter((d) => ids.has(d))))
  const color = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  let cycle: string[] | null = null
  function dfs(id: string) {
    if (cycle) return
    color.set(id, 1)
    stack.push(id)
    for (const dep of adj.get(id) ?? []) {
      const c = color.get(dep) ?? 0
      if (c === 1) {
        const i = stack.indexOf(dep)
        cycle = [...stack.slice(i), dep]
        return
      }
      if (c === 0) dfs(dep)
      if (cycle) return
    }
    stack.pop()
    color.set(id, 2)
  }
  for (const s of steps) {
    if ((color.get(s.id) ?? 0) === 0) dfs(s.id)
  }
  return cycle
}

/**
 * 拓扑分层（Kahn）：同层步骤的前置均已满足，可并行执行。
 * 返回分层后的步骤 id，如 [['TS-1','TS-2'],['TS-7']]。
 */
export function topologicalLayers(steps: TestStep[]): string[][] {
  const ids = new Set(steps.map((s) => s.id))
  const indeg = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  steps.forEach((s) => { indeg.set(s.id, 0); dependents.set(s.id, []) })
  steps.forEach((s) => {
    ;(s.dependencies ?? []).filter((d) => ids.has(d)).forEach((d) => {
      indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1)
      dependents.get(d)?.push(s.id)
    })
  })
  let layer = steps.filter((s) => (indeg.get(s.id) ?? 0) === 0).map((s) => s.id)
  const layers: string[][] = []
  while (layer.length) {
    layers.push(layer)
    const next: string[] = []
    layer.forEach((id) => {
      dependents.get(id)?.forEach((n) => {
        const d = (indeg.get(n) ?? 0) - 1
        indeg.set(n, d)
        if (d === 0) next.push(n)
      })
    })
    layer = next
  }
  return layers
}

/** 下游传递依赖：直接或间接依赖 stepId 的全部步骤（用于失效范围推导）。 */
export function downstreamOf(steps: TestStep[], stepId: string): string[] {
  const ids = new Set(steps.map((s) => s.id))
  const dependents = new Map<string, string[]>()
  steps.forEach((s) => dependents.set(s.id, []))
  steps.forEach((s) => {
    ;(s.dependencies ?? []).filter((d) => ids.has(d)).forEach((d) => dependents.get(d)?.push(s.id))
  })
  const out: string[] = []
  const seen = new Set<string>()
  const queue = [...(dependents.get(stepId) ?? [])]
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    queue.push(...(dependents.get(id) ?? []))
  }
  return out
}

/**
 * 关系链：fromId 到 toId 的依赖传导路径（用于失效说明）。
 * 不可达返回 null。
 */
export function relationChain(steps: TestStep[], fromId: string, toId: string): string[] | null {
  const ids = new Set(steps.map((s) => s.id))
  const dependents = new Map<string, string[]>()
  steps.forEach((s) => dependents.set(s.id, []))
  steps.forEach((s) => {
    ;(s.dependencies ?? []).filter((d) => ids.has(d)).forEach((d) => dependents.get(d)?.push(s.id))
  })
  const prev = new Map<string, string>()
  const queue = [fromId]
  const seen = new Set([fromId])
  while (queue.length) {
    const id = queue.shift()!
    if (id === toId) break
    ;(dependents.get(id) ?? []).forEach((n) => {
      if (!seen.has(n)) {
        seen.add(n)
        prev.set(n, id)
        queue.push(n)
      }
    })
  }
  if (!seen.has(toId)) return null
  const chain = [toId]
  let cur = toId
  while (cur !== fromId) {
    cur = prev.get(cur)!
    chain.unshift(cur)
  }
  return chain
}
