---
name: aop-task-designer
description: AOP 任务设计器——把模糊需求精化为 ROSA/PCDATR 范式的结构化 task.md（R/O/S/A 问题空间 + PCDATR 解空间 + Datasets 轨迹样本），并启动本地看板服务实时渲染。当用户要设计任务、精化需求、编写或校验 task.md、启动 AOP 看板时使用。
---

# AOP Task Designer

把模糊需求精化成结构化的 task.md（AOP/PCDATR 范式），并在本地看板实时渲染。

## 使用前必读

完整方法论、设计流程（Step 1-6）、交互规则、字段规范都在本目录的 **aop.md**——
设计任务前先 Read 它，严格按其流程执行。本文件只负责启动方式与路径映射。

**路径映射**：aop.md 中出现的所有 `.claude/commands/xxx` 路径，在本 skill 中一律
指本 SKILL.md 所在目录的平铺文件（如 `.claude/commands/aop-server.mjs` → 本目录
`aop-server.mjs`）。生成 view.bat 时同理，把脚本路径指向本 skill 目录。

## 启动看板服务

```bash
node <本skill目录>/aop-server.mjs --dir <目标项目>/tasks            # 默认端口 8765
node <本skill目录>/aop-server.mjs --port <N> --dir <目标项目>/tasks
```

- 服务与 aop.html 同目录，模板自动加载，无需 --template
- `--dir` 指向目标项目的 tasks 目录（不存在则先创建；tasks 属于目标项目，不属于本 skill）
- 浏览器打开 `http://localhost:8765/{任务名}`；改 task.md 后经 SSE 自动刷新，无需 F5
- 启动前先清掉占用端口的旧实例（aop.md「启动后端服务」节有完整步骤）
- Windows 下用 bat 启动时，目录参数请写 `--dir "%~dp0."` 而非 `"%~dp0"`（尾部反斜杠+引号会被转义吃掉）

## 校验 task.md

```bash
node <本skill目录>/lint-task.mjs <task.md>    # 单文件
node <本skill目录>/lint-task.mjs --all        # tasks 目录全部
```

## 架构铁律（摘要，全文见 README.md）

1. task.md 是唯一真相源，看板只忠实渲染——禁止前端派生/补全/替数据做决定
2. 输出即 task.md，不导出；嵌套子任务 = 扁平兄弟目录 + frontmatter parent 指针
3. 解空间分工是 task.md 的内容职责，不掺进渲染器
