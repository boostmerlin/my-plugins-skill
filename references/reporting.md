# User-facing reports

Turn raw command output into a compact Markdown report in the user's language. Preserve exact facts while making status, scope, exceptions, and the next action easy to scan.

## Visual hierarchy

- Lead with a short outcome heading: `## 同步计划`, `## 同步完成`, `## 审计发现漂移`, or the equivalent in the user's language.
- Put the key counts immediately below the heading in one bold summary line. Use `·` between metrics instead of a long sentence.
- Use a table when comparing three or more sources, profiles, or statuses. Do not repeat the same label in a long bullet list.
- Use status symbols consistently: `✓` success, `!` warning or drift, `×` failure. Do not decorate every line with emoji.
- Put warnings in their own `### 注意` section. Explain a nonzero exit code next to the condition that caused it, not in a dense closing paragraph.
- End with `### 下一步` only when the user must confirm, restart a task, resolve a failure, or make another decision.
- Use inline code only for identifiers, commands, profile names, packages, and skill names. Do not style ordinary prose as code.
- Avoid restating the same counts or outcome in both prose and bullets.

## Plan awaiting confirmation

Show the selected profiles, target agent, scope, total skills, and batch count before the exact source plan. Group skills by install batch and preserve whether each batch is required or optional.

```markdown
## 同步计划

**23 个 Skill · 9 个安装批次 · 3 个待清理 · 全局同步至 `codex`**

Profile：`core` · `superpowers`

| 动作 | 来源 | Skill |
|---|---|---|
| 安装（必需） | `owner/repository` | `skill-a`、`skill-b` |
| 删除（互斥） | `owner/another` | `skill-c` |

### 安全边界

- ✓ 所有计划来源均已审核
- ✓ 未纳管、共享、非冲突和本地 Skill 不会被删除

### 下一步

确认后开始安装；安装全部成功后自动清理互斥 Skill。**是否执行？**
```

For a large batch, show its count and all exact names. Wrap naturally inside the table cell; do not replace the names with a wildcard if doing so would make the approval plan ambiguous.

## Sync result

Lead with installed versus planned counts. Summarize profile results in a table when useful, then separate audit drift and security scanner findings.

```markdown
## 同步完成

**✓ 23/23 个 Skill 已安装 · 3/3 个互斥 Skill 已清理**

| Profile | 结果 |
|---|---:|
| `core` | ✓ 完成 |
| `superpowers` | ✓ 完成 |

### 审计

- ✓ 受管 Skill 无缺失
- ! 未纳管：`local-skill`（保留原状）
- ! 退出码 `1`：仅由上述未纳管项触发

### 注意

- `example-skill`：扫描器标记为 High Risk；这表示能力或数据暴露面较高，不等同于已发现恶意代码

### 下一步

开启新任务以加载新安装的 Skill。
```

Omit empty sections. If installation partially fails, replace the success heading and summary with an accurate partial-result heading; list failed required and optional batches before successful details, and give a concrete retry or remediation step.

## Audit result

- With no drift, lead with `✓` and say the audited profile count and managed skill count.
- With drift, lead with `!`, group findings as missing, wrong agent links, blocked, local, and unmanaged. Show counts before names.
- A local or unmanaged entry is not an installation failure. State whether it was preserved.
- Do not call an audit successful when its exit code is nonzero; say that the audit completed and explain the drift that produced the code.

## Risk wording

Report only meaningful warnings surfaced by the installer or audit. Name the scanner when known, distinguish capability risk from confirmed malicious behavior, and avoid declaring a skill safe or malicious from an aggregate label alone.
