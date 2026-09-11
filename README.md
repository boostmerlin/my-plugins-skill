# my-skills-skill

一个交给 Agent 执行的个人 Skill 管理器。它使用 `pluginset.json` 保存经过审核的常用 Skill，让你通过自然语言完成检查、规划、环境同步、版本更新和审计。

## 安装

```bash
npx skills add boostmerlin/my-skills-skill --skill my-skills-skill --global
```

推荐先将本仓库 Fork 到自己的 GitHub 账号，再从个人 Fork 安装。这样 `pluginset.json` 会成为你自己的、可版本控制的 Skill 清单。

配置字段和规则详见 [`references/configuration.md`](./references/configuration.md)。请保留 `schemaVersion: 1`；通常建议保留 `agents: ["detected"]`，让管理器以当前 Agent 为安装目标。

### 2. 从个人 Fork 安装

将下面的 `<your-github-user>` 替换为你的 GitHub 用户名：

```bash
npx skills add <your-github-user>/my-skills-skill --skill my-skills-skill --global
```

也可以把个人 Fork 或其本地克隆交给 Agent，然后使用：

```text
从 <your-github-user>/my-skills-skill 安装 my-skills-skill 为全局 Skill。
```
一般会使用Agent自带的skill installer 安装本skill。
安装完成后开启新会话，再使用下方 Prompt 同步或审计环境。

## 推荐 Prompt

### 初始化我的 Skill（默认 Profile）

```text
使用 $my-skills-skill 初始化我的 Skill。
```

```text
使用 $my-skills-skill 同步我的 Skill。
```

“初始化”是自然语言别名，Agent 实际执行无选择器的 `sync`，严格使用 `defaultProfiles`。当前默认 Profile 是 `core`。

### 同步全部兼容 Profile

```text
使用 $my-skills-skill 同步全部 Profile。
```

Agent 会选择所有普通 Profile，以及每个互斥组中配置的默认 Profile，无需逐一列出。

### 同步到指定 Profile

```text
使用 $my-skills-skill 将当前环境同步到 core 和 coding2 Profile。
```

### 只查看计划

```text
使用 $my-skills-skill 查看同步到 core 和 coding2 Profile 的计划，不执行修改。
```

### 审计指定 Profile 环境

```text
使用 $my-skills-skill 审计当前 coding2 Profile 环境。
```

### 查找新的 Skill

```text
使用 $my-skills-skill 查找适合「<你的需求>」的 Skill。
```

限定 GitHub 作者：

```text
使用 $my-skills-skill 在 <owner> 的仓库中查找适合「<你的需求>」的 Skill。
```

### 将 Skill 加入配置

```text
使用 $my-skills-skill 审核并将 <owner/repository> 的 <skill-name> 加入 <profile>：
scope=<global|project>，agents=detected，required=<true|false>。
```

### 导出当前 Skill

```text
使用 $my-skills-skill 给出当前非系统 Skill 的 pluginset.json 导出方案。
```

### 确认单个 Skill 的来源

```text
使用 $my-skills-skill 确认 grill-me 的来源并显示证据。
```

允许联网补充验证：

```text
使用 $my-skills-skill 联网确认 <skill-name> 的来源。
```

### 记录本机 Skill

```text
使用 $my-skills-skill 将 ./path/to/local-skill 的 <skill-name> 记录为本地来源。
```

### 更新已安装 Skill 的版本

```text
使用 $my-skills-skill 更新我的 Skill。
```

“更新”只升级已安装受管 Skill 的版本，不执行 Profile 同步或互斥清理。

### 从配置移除但保留本机安装

```text
使用 $my-skills-skill 从配置移除 <skill-name>，保留本机安装。
```

## 外部插件管理

更新插件：`node scripts/manage_plugins.mjs update --plugin codegraph` 预览，追加 `--yes` 实际执行。也支持 `--profile coding2` 或 `--all`。更新按 `updateCommand` → `setupCommand` 顺序执行；任一插件未安装、未配置更新命令或未通过审核时，不执行更新。`updateCommand` 支持字符串、平台对象及混合数组。

GitNexus 归入 `coding1`；CodeGraph 和 Codebase Memory MCP 归入 `coding2`。用 `--profile coding2` 可同时选择后两个插件，也可用 `--plugin` 单独选择。

`pluginset.json` 顶层的 `plugins` 保存需要执行 CLI 安装、Codex/MCP 配置或卸载命令的外部集成。这类命令管理的集成不是 Codex Marketplace 原生插件，也不经过 `npx skills`；统一使用独立管理器：

```powershell
node scripts/manage_plugins.mjs plan --plugin gitnexus
node scripts/manage_plugins.mjs plan --profile coding2
node scripts/manage_plugins.mjs install --profile coding1 --yes
node scripts/manage_plugins.mjs remove --plugin gitnexus --yes
```

每次操作必须明确给出 `--profile`、`--plugin` 或 `--all` 其中一个选择器。安装有两道确认门槛：目录项必须是 `reviewed: true`，且执行修改必须显式传入 `--yes`；未传 `--yes` 时只显示包含完整命令的计划。删除只要求 `--yes`，因此未审核条目仍可清理。

管理器按当前平台解析命令，在 Windows 使用 PowerShell，在 Linux 和 macOS 使用 `/bin/sh`。修改命令严格串行执行，任一步失败都会停止整个调用。`codebase-memory-mcp` 的上游卸载命令刻意不传 `-y`，保留其项目索引删除提示；本管理器本身不初始化、刷新或删除项目索引。

## 当前配置

见 [skillset](./pluginset.json)

## Agent 会做什么

收到 Prompt 后，Agent 会根据请求选择以下操作：

1. 检查 Node.js、Git、Skills CLI、配置和当前 Agent。
2. 将 `pluginset.json` 与当前安装状态对比，生成安装与互斥清理计划。
3. 在任何安装或版本更新前展示计划并等待确认。
4. 将同来源、同 scope、同目标 Agent、同失败策略的缺失项合并安装。
5. 安装全部成功后，清理当前目标 Agent 中被替代 Profile 的专属 Skill，并验证删除结果。
6. 审计缺失项、互斥冲突、链接问题和未纳管项。
7. 导出前交叉检查 CLI 元数据、lock 记录和本地 Git 证据，并展示可信等级。

只读操作不会改变安装状态。同步和版本更新属于修改操作；同步清理不增加独立确认，只有清理动作时，显式同步请求本身就是授权。

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

配置中的 `agents: ["detected"]` 表示让管理器把当前运行 Agent 传给 Skills CLI，而不是使用 `--agent '*'`。目前能够从运行时标记自动识别 Codex 和 Claude Code；无法识别或检测结果冲突时，Agent 会要求你明确目标。

指定 Codex 不代表其他 Agent 一定看不到该 Skill。Skills CLI 可能把内容存入共享的 `~/.agents/skills/`，使 Cursor、GitHub Copilot 等兼容 Agent 同样可见。`detected` 保证的是请求的安装目标，不保证目录隔离。

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
my-skills-skill/
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
验证 my-skills-skill。
```
