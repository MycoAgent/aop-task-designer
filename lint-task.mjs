#!/usr/bin/env node
// Lint a task.md for DRY / structure anti-patterns.
//
// Usage:
//   node lint-task.mjs <path/to/task.md>
//   node lint-task.mjs --all            # scan every tasks/*/task.md
//
// Checks:
//   DUP_INLINE  — a field declares `type: X` referencing a structured type
//                 defined in `## 对象`, AND lists inline sub-fields that
//                 duplicate that type's fields. The type ref alone is enough
//                 (expanding shows the type's fields); inline copies are a
//                 second source of truth that drifts. Drop the inline copy.
//                 (Mixed mode — inline sub-field with EXTRA keys beyond the
//                 referenced type — is NOT flagged; that is legitimate.)
//
//   A_NO_TYPE   — an action field under `### A（动作）` has no `type:`.
//                 A 行必填 key + type（禁止 object/any）；缺 type 则前端展开
//                 退化为只剩散文，无结构化参数。修法：在 ## 对象 定义
//                 结构体并在动作上 `type: <结构体名>` 引用。
//
//   EFFECT_REMOVED — any `effect:` line. effect 字段已退役：动作后果（s'=T(s,a)
//                 与奖励 r）不再写成 A 行散文，改由 ## Datasets 的 #### 转移
//                 以 (o,s,a,s',r) 样例承载。删掉 effect:，把后果迁到 #### 转移。
//
//   ROUTE_IN_SLOT — an `out:` line carries cross-task routing
//                 prose（反馈父任务 / 触发兄弟 / 任务名 ac-xxx / (反馈…））。
//                 路由是"送给谁/触发谁"，不进 out:；它只属父任务 `## 子任务`
//                 的 in/out 契约（子任务侧靠共享字段名对接成 DAG）。out: 只写
//                 字段名。（effect 的路由已由 EFFECT_REMOVED 一并覆盖。）
//
// Exit code: 0 if clean, 1 if any warning.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Cross-task routing smell in effect:/out:. Matches routing *direction* words
// (反馈父/反馈回/反馈到/反馈给), 触发兄弟, 送回/回灌/回传, a sibling task name
// (ac-xxx), or routing prose wrapped in parentheses. Deliberately does NOT match
// a bare 父任务 used as the *subject* of a local consequence (e.g.
// "父任务运行设定被改写"), nor bare 闭环反馈 — only routing direction + task refs.
const ROUTE_RE = /反馈(父|回|到|给)|触发兄弟|送回|回灌|回传|ac-[a-z]+|\((反馈|触发|送回)/i

function parseTask(md) {
  const lines = md.split(/\r?\n/)
  let inObj = false
  const types = new Map() // typeName -> Set(fieldKey)
  for (const l of lines) {
    if (/^## 对象/.test(l)) { inObj = true; continue }
    if (/^## /.test(l)) { inObj = false; continue }
    if (!inObj) continue
    const th = /^### (.+)$/.exec(l)
    if (th) { types.set(th[1].trim(), new Set()); continue }
    const sf = /^- ([^:]+):/.exec(l)
    if (sf && types.size) {
      const last = [...types.keys()].pop()
      types.get(last).add(sf[1].trim())
    }
  }
  return types
}

function lintFile(file) {
  const md = readFileSync(file, 'utf8')
  const types = parseTask(md)
  const lines = md.split(/\r?\n/)
  const warnings = []
  let cf = null      // current field
  let on = false     // inside a field's indented block
  let sec = ''
  const flush = () => {
    if (!cf) return
    if (/A\s*[（(]\s*动作/.test(sec) && !cf.type) {
      warnings.push({
        file, line: cf.line, section: 'A（动作）',
        msg: `A_NO_TYPE: 动作「${cf.name}」缺 type:。A 行必填 key+type（禁止 object/any）；缺 type 则展开退化为散文。若该动作带 payload，在 ## 对象 定义结构体并 type 引用之。`,
      })
    }
    const bt = (cf.type || '').replace(/^Array</, '').replace(/>$/, '').replace(/\?$/, '').trim()
    if (types.has(bt) && cf.subKeys.size > 0) {
      const typeFields = types.get(bt)
      // Pure-dup if every inline sub-key is already a field of the type.
      const extras = [...cf.subKeys].filter(k => !typeFields.has(k))
      if (extras.length === 0) {
        warnings.push({
          file, line: cf.line, section: sec.split('（')[0],
          field: cf.name, type: bt, sub: cf.subKeys.size,
          msg: `DUP_INLINE: 字段「${cf.name}」已 type 引用结构体「${bt}」，又内联了 ${cf.subKeys.size} 个与其重复的子字段（${[...cf.subKeys].join('、')}）。删掉内联，展开时自动取结构体字段。`,
        })
      }
    }
    cf = null
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^### /.test(l)) { flush(); on = false; sec = l; continue }
    const fm = /^- ([^:]+): /.exec(l)
    if (fm && !/^  /.test(l)) { flush(); cf = { name: fm[1].trim(), type: '', subKeys: new Set(), line: i + 1 }; on = true; continue }
    if (on && /^  /.test(l)) {
      const t = /^\s+type:\s*(.+)$/.exec(l)
      if (t) { cf.type = t[1].trim(); continue }
      const sf = /^\s+-\s+([^:]+):/.exec(l)
      if (sf) cf.subKeys.add(sf[1].trim())
    }
  }
  flush()
  // EFFECT_REMOVED + ROUTE_IN_SLOT: line-by-line across all sections.
  //  - effect: retired entirely (consequence → ## Datasets #### 转移).
  //  - out: must be field names only, never cross-task routing prose.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const ef = /^\s*effect:\s*(.*)$/.exec(l)
    if (ef) {
      warnings.push({
        file, line: i + 1, section: 'effect 已退役',
        msg: `EFFECT_REMOVED: 残留 effect:（「${ef[1].trim().slice(0, 40)}」）。effect 已退役，动作后果（s'=T(s,a) 与 r）改由 ## Datasets 的 #### 转移 以 (o,s,a,s',r) 样例承载。删掉此 effect:。`,
      })
      continue
    }
    const om = /^\s*out:\s*(.*)$/.exec(l)
    if (om && ROUTE_RE.test(om[1])) {
      warnings.push({
        file, line: i + 1, section: '跨任务路由',
        msg: `ROUTE_IN_SLOT: out: 出现跨任务路由标记（「${om[1].trim().slice(0, 40)}」）。路由（反馈父/触发兄弟/任务名）不进 out:，只进父任务 ## 子任务 in/out 契约；out 只写字段名。`,
      })
    }
  }
  return warnings
}

function main() {
  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const tasksRoot = resolve(__dirname, '..', '..', 'tasks')
  const files = all
    ? readdirSync(tasksRoot).filter(d => statSync(join(tasksRoot, d)).isDirectory()).map(d => join(tasksRoot, d, 'task.md')).filter(existsSync)
    : args.filter(a => !a.startsWith('-'))
  if (!files.length) {
    console.error('Usage: node lint-task.mjs <task.md> | --all')
    process.exit(2)
  }
  let total = 0
  for (const f of files) {
    const ws = lintFile(f)
    if (ws.length === 0) { console.log('OK   ' + f); continue }
    total += ws.length
    console.log('WARN ' + f)
    for (const w of ws) console.log(`  L${w.line} ${w.section} :: ${w.msg}`)
  }
  process.exit(total ? 1 : 0)
}

main()
