import type { TestStep } from './types'

/** 读取单步的前置集合：优先多前置，旧数据回退到单前置字段，按原顺序去重 */
export function depsOf(step: TestStep): string[] {
  const raw = step.dependencies ?? (step.dependency ? [step.dependency] : [])
  return [...new Set(raw)]
}

/** 规范化整图：去掉自引用与悬空前置，保持原有顺序，不改写结果与证据 */
export function normalizeSteps(steps: TestStep[]): TestStep[] {
  const ids = new Set(steps.map((step) => step.id))
  return steps.map((step) => ({
    ...step,
    dependencies: depsOf(step).filter((dep) => dep !== step.id && ids.has(dep)),
  }))
}

/** 深度优先查环，返回环路径（首尾同节点），无环返回 null */
export function findCycle(steps: TestStep[]): string[] | null {
  const graph = new Map(steps.map((step) => [step.id, depsOf(step)]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  function visit(id: string): string[] | null {
    state.set(id, 'visiting')
    stack.push(id)
    for (const dep of graph.get(id) ?? []) {
      if (!graph.has(dep)) continue
      if (state.get(dep) === 'visiting') return [...stack.slice(stack.indexOf(dep)), dep]
      if (!state.has(dep)) {
        const found = visit(dep)
        if (found) return found
      }
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }
  for (const id of graph.keys()) {
    if (!state.has(id)) {
      const found = visit(id)
      if (found) return found
    }
  }
  return null
}

/** 逐边重建无环图：按原顺序接受依赖边，跳过会成环的边，用于恢复损坏数据 */
export function dropCyclicEdges(steps: TestStep[]): TestStep[] {
  const accepted = steps.map((step) => ({ ...step, dependencies: [] as string[] }))
  for (const step of steps) {
    const target = accepted.find((entry) => entry.id === step.id)
    if (!target) continue
    for (const dep of depsOf(step)) {
      target.dependencies.push(dep)
      if (findCycle(accepted)) target.dependencies.pop()
    }
  }
  return accepted
}

/** 下游闭包：返回每个受影响步骤 id 及其被失效波及的直接前置（用于说明触发关系） */
export function collectDownstream(steps: TestStep[], sourceId: string): Map<string, string> {
  const dependents = new Map<string, string[]>()
  for (const step of steps) {
    for (const dep of depsOf(step)) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), step.id])
    }
  }
  const reached = new Map<string, string>()
  const queue = [sourceId]
  while (queue.length) {
    const current = queue.shift()!
    for (const next of dependents.get(current) ?? []) {
      if (!reached.has(next)) {
        reached.set(next, current)
        queue.push(next)
      }
    }
  }
  return reached
}

/** 按依赖关系分层（Kahn）：同层步骤可并行执行，用于并行试验的执行顺序 */
export function topoLayers(steps: TestStep[]): string[][] {
  const ids = steps.map((step) => step.id)
  const remaining = new Map(steps.map((step) => [step.id, depsOf(step).filter((dep) => ids.includes(dep))]))
  const layers: string[][] = []
  while (remaining.size) {
    const layer = [...remaining.entries()].filter(([, deps]) => deps.length === 0).map(([id]) => id)
    if (!layer.length) break // 有环时停止，调用方应先查环
    layers.push(layer)
    for (const id of layer) remaining.delete(id)
    for (const deps of remaining.values()) {
      for (const id of layer) {
        const index = deps.indexOf(id)
        if (index >= 0) deps.splice(index, 1)
      }
    }
  }
  return layers
}
