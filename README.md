# my-plugins-skill

一个交给 Agent 执行的个人 Skill 与外部插件管理器。它使用 `pluginset.json` 保存经过审核的常用 Skill 和插件，让你通过自然语言完成检查、规划、环境同步、安装、更新、卸载和审计。

## 安装

```bash
npx skills add boostmerlin/my-plugins-skill --skill my-plugins-skill --global
```

推荐先将本仓库 Fork 到自己的 GitHub 账号，再从个人 Fork 安装。这样 `pluginset.json` 会成为你自己的、可版本控制的 Skill 清单。

配置字段和规则详见 [`references/configuration.md`](./references/configuration.md)。请保留 `schemaVersion: 1`；通常建议保留 `agents: ["detected"]`，让管理器以当前 Agent 为安装目标。

### 从个人 Fork 安装

将下面的 `<your-github-user>` 替换为你的 GitHub 用户名：

```bash
npx skills add <your-github-user>/my-plugins-skill --skill my-plugins-skill --global
```

也可以把个人 Fork 或其本地克隆交给 Agent，然后使用：

```text
从 <your-github-user>/my-plugins-skill 安装 my-plugins-skill 为全局 Skill。
```
也可以让 Agent 使用自带的 Skill installer 完成安装。
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

`pluginset.json` 的 `plugins` 保存需要 CLI 安装、Codex/MCP 配置和卸载命令的外部集成，由 `scripts/manage_plugins.mjs` 管理。它们与 Codex Marketplace 原生插件分开管理。

未限定对象地说“执行 plan”等命令时，Agent 会检查两个管理器，分别处理支持该命令的一侧；明确指定对象、资源或脚本时，以明确范围为准。不带选择器的“执行 plan”会预览两边的全部兼容 Profile。修改请求不会自动追加 `--all` 或 `--yes`。

`install` 只添加所选项，`remove` 显式卸载所选项，`sync` 才会替换互斥方案；`plan` 预览同步计划。插件操作必须选择 `--profile`、`--plugin` 或 `--all`，所有修改命令不带 `--yes` 都只预览。执行同步时先安装、配置并验证新插件，再清理旧方案；失败后报告进度，不自动回滚。

```powershell
node scripts/manage_plugins.mjs plan --profile codegraph --agent codex
node scripts/manage_plugins.mjs install --plugin gitnexus --yes
node scripts/manage_plugins.mjs sync --profile codegraph --yes
node scripts/manage_plugins.mjs update --plugin codegraph
node scripts/manage_plugins.mjs remove --plugin gitnexus --yes
```

三个插件分别使用同名 Profile：`gitnexus`、`codegraph`、`codebase-memory-mcp`，属于 `codegraph` 互斥组，默认选中 `codegraph`。工作流 `mattpocock` 与 `superpowers` 属于独立的 `coding` 组，可以选择一个工作流搭配一个插件；选择工作流本身不会选中插件。

插件默认识别当前会话，也支持显式目标；当前配置只录入已核对的 Codex `agentMap` 映射。`--detect-installed` 用于明确面向本机已安装 Agent 的请求，不能与 `--agent` 合用。插件卸载可能移除共享 CLI 并影响其他 Agent，计划会说明范围。本管理器不初始化、刷新或删除项目索引；`codebase-memory-mcp` 的上游卸载仍保留索引删除提示。

完整选择器、命令顺序和失败处理见 [操作说明](references/operations.md#external-plugin-lifecycle)，配置格式见 [配置说明](references/configuration.md)。

## 当前配置

默认初始化只选择 `core`。`mattpocock` Profile 收录其正式套件的 25 个 Skill，按上游 v1.2.3（commit `959a8e9f1edc3adbe2f7e3054bb6fbefa6696260`）的 [发布清单](https://github.com/mattpocock/skills/blob/959a8e9f1edc3adbe2f7e3054bb6fbefa6696260/.claude-plugin/plugin.json) 核对，覆盖 engineering 与 productivity，不包含 misc 和 in-progress 项。该版本仅是清单核对基准，安装来源 `mattpocock/skills` 没有锁定版本。旧名称 `writing-great-skills` 已改为 `writing-for-agents`。

选择 `mattpocock` 或同步全部兼容 Profile 时才会安装这套 Skill。安装后，每个项目在使用工程工作流前先运行 `setup-matt-pocock-skills`，配置 issue tracker、分诊标签与文档位置。完整条目见 [pluginset.json](pluginset.json)。

### 同一 Profile 内选择替代工具

Profile 互斥用于整套方案切换，条目互斥用于同一 Profile 内的替代工具。`docs` 中的 `humanizer-zh` 与 `qu-ai-wei` 属于 `chinese-humanizer` 组，默认选择前者：

```powershell
node scripts/manage-skills.mjs plan --profile docs
node scripts/manage-skills.mjs plan --profile docs --choose chinese-humanizer=qu-ai-wei
node scripts/manage-skills.mjs sync --profile docs --choose chinese-humanizer=qu-ai-wei --yes
node scripts/manage-skills.mjs audit --profile docs --choose chinese-humanizer=qu-ai-wei
```

`--choose` 只对本次命令生效，下次不传参数恢复默认。`install` 允许替代项并存，`remove` 显式卸载匹配项；这两个命令不接受 `--choose`。指定 Profile 审计检查选中方案，全目录审计检查所有配置变体。完整规则见 [替代工具操作说明](references/operations.md#entry-alternatives)。

### 单独安装和卸载 Skill

```powershell
node scripts/manage-skills.mjs install --profile mattpocock,superpowers --yes
node scripts/manage-skills.mjs remove --profile superpowers --yes
```

这两个命令不会自动清理其他方案。显式卸载会包含所选 Profile 中的共享 Skill，计划会列出其归属；本地来源跳过，未纳管项保留。Skill 卸载必须指定 `--profile` 或 `--all`。

## Agent 会做什么

1. 检查工具、配置和当前 Agent，对照当前安装状态生成计划。
2. 展示精确名称、来源、目标、跳过项和冲突；在已有授权范围内执行，无需重复确认。
3. 同步时先安装并验证新方案，再清理受管互斥项，最后核对结果。
4. 审计缺失、来源冲突、链接问题和未纳管项；导出前另行评估来源证据。

## 关键边界

`pluginset.json` 是受管配置源；删除条目即结束管理，没有历史归属记录。同步保留无关 Profile 和未纳管项。安装元数据缺失时仍按当前清单判断归属；若已明确记录了不同来源、本地安装或受保护路径，则阻止修改并报告，不能把冲突记录丢弃后当成“缺失”重新安装。

本地路径只作为库存记录保留，不会安装或删除。同步遇到仅由可选本地项组成的替代方案时，会阻止对应互斥组、目标 Agent 的清理；真正空的所选 Profile 可以清理旧方案，可用远程替代项与可选本地项混合时仍可同步。必需本地项与本地条目替代项的清理限制保持不变。详见 [同步说明](references/operations.md#environment-sync)。

版本更新只处理请求范围内已安装、已纳管的远程名称，并按 global/project 分别执行；未纳管项、本地项和受保护项不会被顺带更新。名称列表为空时不执行命令。更新不使用互斥默认项，也不保证共享安装只对一个 Agent 可见。详见 [受管 Skill 更新](references/operations.md#managed-skill-version-updates)。

来源确认默认离线，结合 CLI 元数据、lock 和 Git 证据。Git 仓库必须跟踪该 Skill 的准确 `SKILL.md`；仅处于某项目目录下不足以证明来源。只有 `CONFIRMED` 或 `VERIFIED` 的远程来源可以进入导出方案，这个门槛不用于普通生命周期的归属判断。来源确认也不证明本地内容从未修改。详见 [来源与导出](references/provenance.md)。

`agents: ["detected"]` 识别当前 Codex、Claude Code 或 WorkBuddy / CodeBuddy 会话；后者使用 Skills CLI 的 `codebuddy` 目标。缺失或冲突时需要明确目标。共享 `~/.agents/skills/` 可能让其他 Agent 同样可见；WorkBuddy 重定向全局目录时，`doctor` 会提示与 CLI 写入路径的差异。检测依据和处理方法见 [Agent 检测说明](references/agent-detection.md)。

未经审核的条目不安装，未授权的修改不执行；只读命令只报告。系统 Skill、插件缓存、凭据和系统依赖不在管理范围内。本地修改可能被覆盖时停止并报告。

## 维护资料

| 文件 | 内容 |
|---|---|
| [SKILL.md](SKILL.md) | Agent 路由和关键约束 |
| [pluginset.json](pluginset.json) | 当前 Skill 与外部插件清单 |
| [operations.md](references/operations.md) | 操作步骤、选择范围、执行和验证 |
| [configuration.md](references/configuration.md) | 配置字段与格式 |
| [provenance.md](references/provenance.md) | 来源证据与导出规则 |
| [agent-detection.md](references/agent-detection.md) | 当前会话与已安装 Agent 检测 |
| [reporting.md](references/reporting.md) | 面向用户的结果报告 |

修改配置或脚本后，可以要求 Agent：

```text
验证 my-plugins-skill。
```
