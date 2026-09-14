# my-plugins-skill

一个交给 Agent 执行的个人 Skill 与外部插件管理器。它使用 `pluginset.json` 保存经过审核的常用 Skill 和插件，让你通过自然语言完成检查、规划、环境同步、安装、更新、卸载和审计。

## 安装

```bash
npx skills add boostmerlin/my-plugins-skill --skill my-plugins-skill --global
```

推荐先将本仓库 Fork 到自己的 GitHub 账号，再从个人 Fork 安装。这样 `pluginset.json` 会成为你自己的、可版本控制的 Skill 清单。

配置字段和规则详见 [`references/configuration.md`](./references/configuration.md)。请保留 `schemaVersion: 1`；通常建议保留 `agents: ["detected"]`，让管理器以当前 Agent 为安装目标。

### 2. 从个人 Fork 安装

将下面的 `<your-github-user>` 替换为你的 GitHub 用户名：

```bash
npx skills add <your-github-user>/my-plugins-skill --skill my-plugins-skill --global
```

也可以把个人 Fork 或其本地克隆交给 Agent，然后使用：

```text
从 <your-github-user>/my-plugins-skill 安装 my-plugins-skill 为全局 Skill。
```
一般会使用Agent自带的skill installer 安装本skill。
安装完成后开启新会话，再使用下方 Prompt 同步或审计环境。

## 推荐 Prompt

### 初始化我的 Skill（默认 Profile）

```text
使用 $my-plugins-skill 初始化我的 Skill。
```

```text
使用 $my-plugins-skill 同步我的 Skill。
```

“初始化”是自然语言别名，Agent 实际执行无选择器的 `sync`，严格使用 `defaultProfiles`。当前默认 Profile 是 `core`。

### 同步全部兼容 Profile

```text
使用 $my-plugins-skill 同步全部 Profile。
```

Agent 会选择所有普通 Profile，以及每个互斥组中配置的默认 Profile，无需逐一列出。

### 同步到指定 Profile

```text
使用 $my-plugins-skill 将当前环境同步到 core 和 superpowers Profile。
```

### 只查看计划

```text
使用 $my-plugins-skill 查看同步到 core 和 superpowers Profile 的计划，不执行修改。
```

### 审计指定 Profile 环境

```text
使用 $my-plugins-skill 审计当前 superpowers Profile 环境。
```

### 查找新的 Skill

```text
使用 $my-plugins-skill 查找适合「<你的需求>」的 Skill。
```

限定 GitHub 作者：

```text
使用 $my-plugins-skill 在 <owner> 的仓库中查找适合「<你的需求>」的 Skill。
```

### 将 Skill 加入配置

```text
使用 $my-plugins-skill 审核并将 <owner/repository> 的 <skill-name> 加入 <profile>：
scope=<global|project>，agents=detected，required=<true|false>。
```

### 导出当前 Skill

```text
使用 $my-plugins-skill 给出当前非系统 Skill 的 pluginset.json 导出方案。
```

### 确认单个 Skill 的来源

```text
使用 $my-plugins-skill 确认 grill-me 的来源并显示证据。
```

允许联网补充验证：

```text
使用 $my-plugins-skill 联网确认 <skill-name> 的来源。
```

### 记录本机 Skill

```text
使用 $my-plugins-skill 将 ./path/to/local-skill 的 <skill-name> 记录为本地来源。
```

### 更新已安装 Skill 的版本

```text
使用 $my-plugins-skill 更新我的 Skill。
```

“更新”只升级已安装受管 Skill 的版本，不执行 Profile 同步或互斥清理。

### 安装配置之外的 Skill

安装某个 Skill 前，Agent 会先核对当前 `pluginset.json`。如果该 Skill 不在配置中，必须先读取并使用 `find-skills` 技能，按其流程查找、核验来源并处理安装，而不是直接绕过技能执行搜索命令。安装配置外 Skill 不会自动将它加入受管配置，也不会清理互斥方案；只有明确要求纳管时才修改配置。

### 从配置移除但保留本机安装

```text
使用 $my-plugins-skill 从配置移除 <skill-name>，保留本机安装。
```

## 外部插件管理

未限定对象地说“执行某命令”时，Agent 默认检查两个管理器：两边都支持就分别执行，只有一边支持才执行单边，并说明另一边不支持。不会仅因上一轮讨论插件而漏掉 Skills。明确指定对象、资源名称或脚本命令时，以明确范围为准。`plan/install/remove/sync` 两边均支持；`doctor/audit/sources` 当前仅 Skills 支持，管理器的 `update` 命令仅 Plugins 支持。不带选择器地说“执行 plan”，默认运行两边的 `plan --all`；修改命令保留指定范围和授权，不擅自追加 `--all` 或 `--yes`。

两个管理器均支持 `install`、`remove`、`sync`。`install` 只安装所选项，`remove` 只卸载所选项，两者都允许同组方案共存或批量操作，不额外清理其他项。`install --all` 和 `remove --all` 选择全部纳管项。只有 `sync` 执行状态同步；`plan` 预览同步计划。所有修改命令不传 `--yes` 都只预览，包括仅清理的同步。

受管范围只由当前 `pluginset.json` 定义：删除配置条目后就不再管理其安装，不保留历史受管记录。`sync --profile superpowers` 只同步所选方案并清理同组被替代项，保留 `core`、`docs`、`marketing` 等其他 Profile 和未纳管项。

Skill 示例：`node scripts/manage-skills.mjs install --profile mattpocock,superpowers --yes` 可同时安装两套方案；`node scripts/manage-skills.mjs remove --profile superpowers --yes` 显式卸载所选条目，其中包含的共享 Skill 也会列入卸载计划。本地来源跳过，未纳管条目保留。Skill 卸载必须指定 `--profile` 或 `--all`。

三个插件分别使用同名 Profile：`gitnexus`、`codegraph`、`codebase-memory-mcp`，属于 `codegraph` 互斥组，默认项为 `codegraph`。工作流 `mattpocock` 与 `superpowers` 仍属于独立的 `coding` 组，可以将一个工作流与一个插件搭配使用；仅选择工作流 Profile 不再选中插件。

插件的 `plan`、`sync` 不允许同时选择同组不同方案，`--plugin` 也遵守该规则。它们的 `--all` 选择普通 Profile 和各互斥组默认项对应的插件，当前会选中 `codegraph`。`install`、`update`、`remove` 忽略互斥且不额外清理其他项；这三个命令的 `--all` 选择全部三个插件。

同步计划会列出同组旧插件的清理命令。执行 `sync --yes` 后，先完成所有所选插件的安装与配置，并检查新插件可用，再卸载已安装的旧插件、检查其不再可用。前半程失败时保留旧插件；清理失败立即停止，报告已完成和待执行动作，不自动回滚。只自动清理单一被替代 Profile 专属的插件；共享、其他组和未纳管插件保留。验证使用 CLI 可用性检查，不保证上游残留配置已清除。需要替换旧方案时，请将原先的插件 `install` 命令改为 `sync`。

检测方式：默认识别当前会话；`--detect-installed` 则按本机全局配置目录选择所有已安装候选，例如 `node scripts/manage_plugins.mjs plan --profile codegraph --detect-installed`。候选可能包括已卸载工具留下的配置，每个目标仍需 `agentMap`，缺失时会报错。该参数与 `--agent` 互斥。详见 [上游检测源码分析](references/agent-detection.md)。

插件支持 `agents: ["detected"]` 自动识别当前 Codex 或 Claude Code，也可以列出多个明确 agent。`agentMap` 将名称映射为工具参数，命令中的 `{agent}` 按目标逐个展开；不含占位符的共享安装、更新、卸载命令只执行一次。可用 `--agent codex` 显式解析 `detected`，或设置 `MY_SKILLS_AGENT`；显式配置的目标列表不会被覆盖。当前三个插件只录入了已核对的 Codex 映射，其他目标需补充映射后使用。

例如：`node scripts/manage_plugins.mjs plan --profile codegraph --agent codex`。任何目标无法识别或缺少映射时，整个操作会在检查之前停止。`remove` 仍是完整卸载，可能移除共享 CLI 并影响其他 agent，并非仅清理选定目标。

更新插件：`node scripts/manage_plugins.mjs update --plugin codegraph` 预览，追加 `--yes` 实际执行。也支持 `--profile codegraph` 或 `--all`。更新按 `updateCommand` → `setupCommand` 顺序执行；任一插件未安装、未配置更新命令或未通过审核时，不执行更新。`updateCommand` 支持字符串、平台对象及混合数组。

`pluginset.json` 顶层的 `plugins` 保存需要执行 CLI 安装、Codex/MCP 配置或卸载命令的外部集成。这类命令管理的集成不是 Codex Marketplace 原生插件，也不经过 `npx skills`；统一使用独立管理器：

```powershell
node scripts/manage_plugins.mjs plan --plugin gitnexus
node scripts/manage_plugins.mjs plan --profile codegraph
node scripts/manage_plugins.mjs install --profile gitnexus --yes
node scripts/manage_plugins.mjs sync --profile codegraph --yes
node scripts/manage_plugins.mjs remove --plugin gitnexus --yes
```

每次操作必须明确给出 `--profile`、`--plugin` 或 `--all` 其中一个选择器。安装有两道确认门槛：目录项必须是 `reviewed: true`，且执行修改必须显式传入 `--yes`；未传 `--yes` 时只显示包含完整命令的计划。删除只要求 `--yes`，因此未审核条目仍可清理。

管理器按当前平台解析命令，在 Windows 使用 PowerShell，在 Linux 和 macOS 使用 `/bin/sh`。修改命令严格串行执行，任一步失败都会停止整个调用。`codebase-memory-mcp` 的上游卸载命令刻意不传 `-y`，保留其项目索引删除提示；本管理器本身不初始化、刷新或删除项目索引。

## 当前配置

见 [pluginset](./pluginset.json)

## Agent 会做什么

收到 Prompt 后，Agent 会根据请求选择以下操作：

1. 检查 Node.js、Git、Skills CLI、配置和当前 Agent。
2. 将 `pluginset.json` 与当前安装状态对比，生成安装与互斥清理计划。
3. 在修改前展示计划，获得授权后执行；已有明确授权无需再次确认。
4. 将同来源、同 scope、同目标 Agent、同失败策略的缺失项合并安装。
5. 同步时，在安装全部成功后清理当前目标 Agent 中被替代 Profile 的专属 Skill，并验证删除结果；单独安装不会触发清理。
6. 审计缺失项、互斥冲突、链接问题和未纳管项。
7. 导出前交叉检查 CLI 元数据、lock 记录和本地 Git 证据，并展示可信等级。

只读操作不会改变安装状态。两个管理器的修改命令必须传入 `--yes` 才执行；不传时只预览，只有清理动作的同步也不例外。

## 关键行为

### `pluginset.json` 是配置源

应由人审核并纳入版本控制的是 `pluginset.json`。它记录：

- 来源（远程仓库或本机路径）和准确 Skill 名称
- 所属 Profile
- 可选的 Profile 互斥组及组内默认项
- `global` 或 `project` scope
- 目标 Agent
- 是否为必需项
- 来源是否已审核

`skills-lock.json` 不是本项目的人工配置源；它只是 Skills CLI 可能使用的项目级状态。

配置格式详见 [references/configuration.md](references/configuration.md)。

同一 `exclusiveGroup` 中的 Profile 不能同时同步。每个互斥组必须至少包含两个 Profile，并通过 `defaultInExclusiveGroup: true` 指定唯一默认项。`sync --all` 使用该默认项；同步成功后只清理当前目标 Agent 中由其它组成员专属管理的远程 Skill。共享、非冲突、未纳管和本地来源 Skill 均保留。

### 来源确认与导出门槛

来源确认默认完全离线。Agent 会交叉检查 Skills CLI 的 JSON 元数据、对应 scope 的 lock 记录，以及安装路径解析后的 Git remote。只有明确允许时，才会联网查询候选仓库公开的 Skill 列表。

- `CONFIRMED`：CLI 与 lock 指向同一来源。
- `VERIFIED`：本地 Git origin 或显式远程查询提供了独立验证。
- `CANDIDATE`：证据单一或互相冲突，需要人工确认。
- `UNKNOWN`：没有可信来源线索。
- `LOCAL`：机器本地路径，不适合跨环境恢复。

只有 `CONFIRMED` 和 `VERIFIED` 可以进入远程导出方案。确认的是安装来源，不代表本地文件内容从未被修改。详细规则见 [references/provenance.md](references/provenance.md)。

本机路径也可以直接写入 `package`，无需增加 `sourceType`。与 Skills CLI 相同，绝对路径、`./`、`../`、`.`、`..` 和 Windows 盘符路径会被识别为本地来源。它们只作为本机清单保留：恢复时由 Agent 跳过并报告，不会在其他环境尝试安装。

### 自动识别当前 Agent

配置中的 `agents: ["detected"]` 表示让管理器把当前运行 Agent 传给 Skills CLI，而不是使用 `--agent '*'`。目前能够从运行时标记自动识别 **Codex**、**Claude Code**（`CLAUDECODE === "1"`）以及 **WorkBuddy / CodeBuddy**。WorkBuddy 桌面端或底层 CodeBuddy CLI 运行时会被识别为 Skills CLI 的 `codebuddy` 目标（而非 `workbuddy`，因为 Skills CLI 只接受 `codebuddy` 这一 id，用 `workbuddy` 安装会失败）。无法识别或检测结果冲突（例如同时出现 Codex 与 CodeBuddy 标记）时，Agent 会要求你明确目标。

> 注意：WorkBuddy 会向会话注入 Claude Code 兼容变量（如 `CLAUDE_SESSION_ID`），但这些只作兼容用途，不会让检测器误判为 `claude-code`——只有 `CLAUDECODE === "1"` 才算 claude-code 的活动证据。

指定 Codex 不代表其他 Agent 一定看不到该 Skill。Skills CLI 可能把内容存入共享的 `~/.agents/skills/`，使 Cursor、GitHub Copilot 等兼容 Agent 同样可见。`detected` 保证的是请求的安装目标，不保证目录隔离。

另外，Skills CLI 对 `codebuddy` 硬编码写入 `~/.codebuddy/skills`，而 CodeBuddy/WorkBuddy 运行时读取 `$CODEBUDDY_CONFIG_DIR/skills`（默认也是 `~/.codebuddy`）。当宿主把该目录重定向（例如指向 `~/.workbuddy`）时，全局安装会落到扫描路径之外。`doctor` 会对此发出 `[WARN]`，提示两个路径不一致；此时可设置 `CODEBUDDY_CONFIG_DIR=~/.codebuddy` 或把重定向目录链接回 `~/.codebuddy`，使写入路径与扫描路径一致。

## 安全边界

- 未经审核的条目不会安装。
- 未经确认不会开始安装或版本更新；清理不增加第二次确认。
- 未纳管 Skill 只报告，不自动删除或加入配置。
- 不管理系统内置 Skill、插件缓存、凭据或系统依赖。
- 不自动删除共享、非冲突或本地来源 Skill。
- 本地修改可能被覆盖时，Agent 应停止并报告冲突。

完整操作规则见 [references/operations.md](references/operations.md)。

## 项目结构

```text
my-plugins-skill/
├── README.md                        用户 Prompt 与使用说明
├── SKILL.md                         Agent 执行入口
├── pluginset.json                    受管 Skill 配置源
├── agents/openai.yaml               Codex UI 元数据
├── scripts/manage-skills.mjs        确定性管理脚本
├── scripts/manage-skills.test.mjs   批处理逻辑测试
├── scripts/manage_plugins.mjs       外部插件命令管理器
├── scripts/manage_plugins.test.mjs  外部插件管理器测试
└── references/
    ├── configuration.md             配置和 Agent 目录规则
    ├── operations.md                操作流程与安全约束
    └── provenance.md                来源证据、状态与导出规则
```

维护者修改配置或脚本后，可以直接要求 Agent：

```text
验证 my-plugins-skill。
```
