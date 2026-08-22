# AOP Task Designer

AOP (Agent-Oriented Programming) 任务设计工具 — 基于 POMDP 理论和 PCDATR 方法论，交互式定义智能体任务。

## 理论基础

### POMDP（部分可观测马尔可夫决策过程）

Agent 在现实世界中面临的核心挑战是**信息不完全**：传感器有噪声、环境动态变化、部分状态不可直接观测。POMDP 为此提供了严格的数学框架：

- **O（观察）**— Agent 能感知什么（有噪声、有延迟）
- **S（状态）**— 领域中存在哪些真实状态/因素（信念/置信度由 PCDATR 框架的 C 层统一处理，不在任务定义中重复）
- **A（动作）**— Agent 能做什么
- **R（评价）**— 什么算好（评估标准）
- **T（转变）**— 环境如何响应动作（S' = T(S, A)）

POMDP 的核心思想：**Agent 永远无法直接获得真实状态，只能通过 Observation 维护一个 Belief State（信念状态），并在此基础上做决策。** Belief State 由 C 层负责维护，不在任务定义层重复。这正是智能体区别于传统软件的关键 — 传统软件假设输入是确定的，智能体必须处理不确定性。

### PCDATR 六层协议

PCDATR 是 POMDP 在工程实践中的落地框架，将 Agent 的认知闭环拆解为六层：

| 层 | 角色 | 职责 | POMDP映射 | 类比 |
|----|------|------|-----------|------|
| **P** 感知 | 感知器 | 数据采集 | → O | 眼睛 |
| **C** 认知 | 认知器 | O→S 状态估计 | 维护 Belief State | 军师 |
| **D** 决策 | 决策器 | S→A 策略选择 | 最优策略 π(S) | 将军 |
| **A** 执行 | 执行器 | 执行操作 | 执行动作 | 双手 |
| **T** 转变 | 转变器 | 状态转变 | S' = T(S, A) | 因果律 |
| **R** 评价 | 评估器 | 质量评估 | 奖励函数 | 裁判 |

**C 层的核心职责是输出 S（信念状态），不是打分。** C 从 P 采集的原始观察 (O) 推断出结构化状态 (S)，可能比原始观察增加信息（类似"悟"），但带有置信度，需通过 D-A-T-R 闭环验证。

最小可行集：P→C→D→A 四层闭环，T 和 R 按需添加。

## 这是什么

一个 Claude Code 的自定义 Skill（斜杠命令），用于交互式设计 Agent 任务。通过对话引导，将模糊需求逐步精化为结构化的问题空间定义（R/S/O/A），自动映射出 PCDATR 解空间管线。

## 使用方式

### 安装

将本项目 clone 到你的项目中：

```bash
cp -r .claude/commands/ your-project/.claude/commands/
```

### 启动

在 Claude Code 中输入：

```
/aop 你的任务名称
```

例如：`/aop 叉车机器人`

### 交互流程

1. 在 Claude Code 中输入 `/aop 任务名称`，Skill 自动启动后端服务并打开浏览器
2. 通过对话逐步定义 **R（评价指标）→ S（领域状态）→ O（观察）→ A（动作）**，结构化类型在用到时内联定义
3. 系统自动生成 PCDATR 管线，并生成示例数据集
4. 每步修改 task.md 后浏览器自动刷新（SSE 实时推送，无需手动 F5）
5. 定义完成后可脱离 Claude Code：双击 `tasks/{任务名}/view.bat` 即可查看

## 核心设计理念

**问题空间 + 解空间 双层架构：**

- **问题空间（Task Tab）**— 定义 WHAT：用户只需定义 R/S/O/A，字段 type 可内联结构化类型（如 `GpsPosition`、`Array<Container>`），禁止泛型 `object`
- **解空间（Agent Tab）**— 定义 HOW：PCDATR 管线自动生成

用户不需要手动拆解 PCDATR，只需在问题空间定义数据，系统自动映射出解空间管线。设计顺序**目标驱动**：R 定目标 → S 梳领域因素 → O 定义输入 → A 定义输出。

## 架构铁律（不可破）

> 这是本项目的**基础设计约束**，任何开发/重构都不得违反。改前端前先读这一节。

1. **task.md 是唯一真相源；前端只是忠实渲染器。** `aop.html` 的职责仅限：读 task.md → 正确渲染 → 处理展开/钻取。**禁止在前端做任何"派生/补全/替数据做决定"**——分工、字段归属、D→action 映射等，都必须由 task.md 显式写定，前端只如实呈现。

2. **输出格式即 task.md；不导出。** 没有前端 export/JSON 落盘：task.md 本身就是规范的格式化产出。**嵌套子任务 = 多个 task.md**（扁平兄弟目录 `tasks/<parent>-<scope>/`，frontmatter `parent`/`parent_layer` 指针，去中心引用，非嵌套子目录——SSE watcher 取 `parts[0]`）。前端只负责把这一族 task.md 渲染成可钻取的树。

3. **解空间的分工是 task.md 的内容职责，不是前端的智能。** 需要多个 D（或任意层多技能）、各自产出不同 action 时，在 task.md 的 `## 解空间` 里手写多条 `#### Dn · skill_id`（各自 `in/out`）。前端读到几条就渲染几张卡，**不合并、不臆造、不替你拆**。问题空间 R/O/S/A 同理只描述任务本身，不掺分工/多智能体（那是解空间/能力环节的事）。

**前端改动的合法边界**：只允许"读得更全、渲染得更准、展开/钻取更顺、解析更鲁棒"；**不允许**"替数据做决定、生成额外格式、把分工逻辑塞进渲染器"。拿不准时，把信息补进 task.md，而不是在 HTML 里猜。

## 文件结构

```
.claude/commands/
  aop.md              # Skill 定义（交互流程、task.md 格式规范）
  aop.html            # 前端模板（Task/Agent 双Tab，支持拖放和 SSE）
  aop-server.mjs      # 轻量后端（SSE 推送 + task.md 监听，零依赖）

tasks/                # 任务数据目录（每个任务一个子目录）
  {task-name}/
    task.md           # 唯一数据源：YAML frontmatter + ROSA 定义 + PCDATR 解空间 + 数据集
    view.bat          # 双击即可启动服务并打开浏览器
    *.jpg/mp3/mp4     # 媒体素材
```

### 架构

```
Claude Code (/aop skill)
  │ 写入 task.md
  ▼
tasks/{name}/task.md     ← 唯一数据源
  │ aop-server.mjs fs.watch() 检测变更
  ▼
浏览器 (http://localhost:8765/{name})
  ← SSE 自动推送，无需 F5
```

## License

MIT
