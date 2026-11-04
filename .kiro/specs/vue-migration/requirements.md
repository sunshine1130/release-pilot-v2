# Requirements Document

## Introduction

本规格用于将现有的「需求发版管理」工具（`todo-release.html`，约 3275 行原生 JavaScript）重写为基于 Vue 3 的实现。项目中已包含未被使用的 `vue.global.js`（Vue 3 全局构建版本）。

本次改造的目标是**纯结构性迁移**：使用 Vue 的声明式模板与响应式数据替换当前手动的 DOM 操作（`document.getElementById`、`innerHTML` 字符串拼接、手动 `addEventListener` 绑定、手写 `render()` 函数），从而减少代码量并提升可维护性。**改造必须在不改变现有功能与界面外观的前提下进行**：所有用户可见的行为、交互、视觉样式、数据格式与持久化方式都必须与现状保持一致。

后端服务（`server.js`，Express，端口 1949）与 `fetch-branches.js` 不在本次改造范围内，迁移后的前端必须继续以现有方式与该本地 API 交互。

## Glossary

- **发版管理应用 / The_App**: 迁移后基于 Vue 3 的「需求发版管理」单页应用，是本规格中所有需求的系统主体。
- **需求 / Item**: 一条发版需求记录，数据结构为 `{ id, name, link, status, projects, syncBranches, targetBranches, releaseTime }`。
- **状态 / Status**: 需求所处阶段，取值为 `new`（新建）、`pending`（待发版）、`releasing`（发版中）、`released`（已发版）之一。
- **项目分支对 / Project_Pair**: 需求涉及的项目与分支组合，结构为 `{ name, branch, notes }`，存放于需求的 `projects` 数组。
- **一同发版分支 / Sync_Branch**: 需求附带的同期发版分支，结构为 `{ project, branch, notes }`，存放于需求的 `syncBranches` 数组。
- **项目 / Project**: 在「项目管理」中维护的项目定义，结构为 `{ name, mr, localPath }`。
- **上线分支 / Launch_Branch**: 全局公用的上线目标分支名（`launchBranch`），持久化于 `localStorage`。
- **目标分支映射 / Target_Branches**: 需求发版时为各项目指定的目标分支，结构为 `{ 项目名: 分支名 }`，存放于需求的 `targetBranches`。
- **分支缓存 / Branch_Cache**: 各项目从 Git 拉取的分支数据缓存，结构为 `{ 项目名: { branches, timestamp } }`。
- **本地分支 API / Branch_API**: `server.js` 在 `http://localhost:1949` 暴露的接口，包含 `/api/branches` 与 `/api/git-user`。
- **完整数据 / Full_Data**: 应用的全量可导出数据，结构为 `{ projectNames, items, branchesCache, launchBranch }`。
- **Toast**: 屏幕底部短暂显示的轻量提示消息。

## Requirements

### Requirement 1: 技术栈迁移

**User Story:** 作为维护者，我希望应用以 Vue 3 的声明式与响应式方式实现，以便减少手动 DOM 操作代码并提升可维护性。

#### Acceptance Criteria

1. THE The_App SHALL 使用项目内已存在的 `vue.global.js`（Vue 3 全局构建版本）作为前端框架。
2. THE The_App SHALL 通过 Vue 的响应式数据与声明式模板渲染界面，替换原有的 `document.getElementById`、`innerHTML` 字符串拼接与手写 `render()` 函数。
3. THE The_App SHALL 通过 Vue 的事件绑定机制替换原有的手动 `addEventListener` 与内联 `onclick` 字符串绑定。
4. THE The_App SHALL 保持与现有应用一致的全部用户可见行为、交互流程与视觉样式。
5. THE The_App SHALL 保持**既有**字段与 `localStorage` 键名不变；v2 新增的字段一律为加法且向后兼容 —— 旧数据、旧导出文件均可正常加载与导入。

### Requirement 2: 需求三分区展示

**User Story:** 作为发版负责人，我希望按状态分区查看需求，以便清晰掌握各阶段的发版进度。

#### Acceptance Criteria

1. THE The_App SHALL 将需求分为「待发版」（状态为 `pending` 或 `new`）、「发版中」（状态为 `releasing`）、「已发版」（状态为 `released`）三个分区展示。
2. THE The_App SHALL 在每个分区标题旁显示该分区当前需求数量，无数据时显示 `0`。
3. THE The_App SHALL 在页面标题区显示需求总数，文本格式为「共 N 条」。
4. WHEN 用户点击某分区的折叠标题，THE The_App SHALL 切换该分区内容的展开与收起状态，并同步切换箭头图标的旋转状态。
5. WHEN 应用渲染，THE The_App SHALL 默认展开「待发版」分区。
6. WHILE 「发版中」分区存在需求，THE The_App SHALL 默认展开「发版中」分区。
7. WHERE 某分区无需求，THE The_App SHALL 在该分区显示对应的空状态文案（「暂无待发版需求」「暂无发版中需求」「暂无已发版需求」）。
8. THE The_App SHALL 在「已发版」分区为每条需求额外显示发版时间列。

### Requirement 3: 新增需求

**User Story:** 作为发版负责人，我希望新增发版需求，以便登记待发版的内容。

#### Acceptance Criteria

1. WHEN 用户点击「+ 新增需求」按钮，THE The_App SHALL 在「待发版」分区顶部插入一个可编辑的新增行。
2. THE The_App SHALL 在新增行中提供需求名称、需求链接、项目分支对、一同发版分支的输入控件。
3. WHEN 用户在新增行点击保存且需求名称非空，THE The_App SHALL 创建一条状态为 `new` 的需求并插入到需求列表顶部。
4. IF 用户在新增行点击保存且需求名称为空，THEN THE The_App SHALL 显示「请输入需求名称」提示并阻止保存。
5. WHEN 用户在新增行点击取消，THE The_App SHALL 丢弃该新增行且不创建需求。
6. WHEN 新创建的需求被渲染，THE The_App SHALL 对该行播放一次新增动画。

### Requirement 4: 编辑需求

**User Story:** 作为发版负责人，我希望内联编辑已登记的需求，以便修正信息。

#### Acceptance Criteria

1. WHEN 用户对状态为 `new` 或 `pending` 的需求点击「编辑」，THE The_App SHALL 将该行切换为内联编辑模式。
2. IF 用户对状态为 `releasing` 或 `released` 的需求点击「编辑」，THEN THE The_App SHALL 显示「发版中/已发版不支持编辑」提示并保持显示模式。
3. WHEN 用户在编辑行点击保存且需求名称非空，THE The_App SHALL 将需求名称、链接、项目分支对、一同发版分支更新为编辑后的值并退出编辑模式。
4. IF 用户在编辑行点击保存且需求名称为空，THEN THE The_App SHALL 显示「请输入需求名称」提示并阻止保存。
5. WHEN 用户在编辑行点击取消，THE The_App SHALL 放弃改动并退出编辑模式。
6. WHEN 用户在编辑行点击「+ 添加分支」或「+ 添加一同发版分支」，THE The_App SHALL 追加一个空的项目分支对输入行。
7. WHEN 用户在编辑行点击某分支输入行的移除按钮，THE The_App SHALL 删除对应输入行。
8. WHEN 收集编辑行数据，THE The_App SHALL 仅保留项目名非空的项目分支对，且仅保留分支名非空的一同发版分支。
9. WHEN 用户在分支名输入框中输入，THE The_App SHALL 移除其中的所有空白字符。

### Requirement 5: 需求状态流转

**User Story:** 作为发版负责人，我希望在各状态间流转需求，以便驱动发版流程。

#### Acceptance Criteria

1. WHEN 用户对 `new` 状态需求点击「设为待发版」，THE The_App SHALL 将其状态置为 `pending`。
2. WHEN 用户对 `pending` 状态需求点击「回退新建」，THE The_App SHALL 将其状态置为 `new`。
3. WHEN 用户对 `pending` 状态需求点击「发版」且全局上线分支已设置，THE The_App SHALL 将其状态置为 `releasing` 并记录发版时间。
4. WHEN 用户对 `releasing` 状态需求点击「标记已发版」，THE The_App SHALL 将其状态置为 `released` 并记录发版时间。
5. WHEN 用户对 `releasing` 或 `released` 状态需求点击「恢复待发版」，THE The_App SHALL 将其状态置为 `pending` 并清除其发版时间。

> 2026-11 修订：原文为「并在来源为 `released` 时清除其发版时间」，代码实现为**不论来源一律清除**。
> 从「发版中」退回待发版时 `releaseTime` 已经写入，保留它会让列表显示一个并未发生的发版时间，
> 因此以代码行为为准修订规格。
6. WHILE 「发版中」分区存在需求，THE The_App SHALL 显示「全部发版」按钮；点击该按钮时 THE The_App SHALL 将所有 `releasing` 需求置为 `released` 并记录统一的发版时间。
7. WHEN 记录发版时间，THE The_App SHALL 使用 `YYYY-MM-DD HH:mm:ss` 格式。

### Requirement 6: 删除需求

**User Story:** 作为发版负责人，我希望删除需求时有二次确认，以便避免误删。

#### Acceptance Criteria

1. WHEN 用户对任意需求点击「删」，THE The_App SHALL 弹出包含该需求名称的删除确认对话框。
2. WHEN 用户在确认对话框点击「确定删除」，THE The_App SHALL 删除对应需求并显示已删除提示。
3. WHEN 用户点击取消、点击遮罩层或按下 Escape 键，THE The_App SHALL 关闭确认对话框且不删除需求。

### Requirement 7: 项目分支对与一同发版分支展示

**User Story:** 作为发版负责人，我希望直观查看需求涉及的项目与分支，以便快速复制分支名或跳转 MR。

#### Acceptance Criteria

1. THE The_App SHALL 为每个项目分支对显示带颜色的项目标签，颜色索引由项目在项目列表中的位置对 30 取模决定。
2. WHERE 项目在项目管理中配置了 MR 地址，THE The_App SHALL 以 `has-mr` 样式显示其项目标签，并使标签可点击跳转到该 MR 地址。
3. WHEN 用户点击分支文本且对应项目配置了 MR 地址，THE The_App SHALL 复制该分支名，并在延迟后打开以该分支为源分支构建的新建 MR 页面。
4. WHEN 用户点击分支文本且对应项目未配置 MR 地址，THE The_App SHALL 仅复制该分支名。
5. WHEN 用户点击分支旁的复制按钮，THE The_App SHALL 复制该分支名并显示复制成功提示。
6. THE The_App SHALL 以与项目分支对一致的方式展示一同发版分支的项目标签与分支标签。
7. WHERE 分支长度超过 40 个字符，THE The_App SHALL 在显示时截断并追加省略号，同时在悬浮提示中显示完整分支名。
8. WHERE 某项目分支对或一同发版分支已存在备注，THE The_App SHALL 在该行显示备注按钮。

### Requirement 8: 项目管理

**User Story:** 作为发版负责人，我希望维护项目清单及其 MR 地址与本地路径，以便在新增需求时复用并支持分支抓取。

#### Acceptance Criteria

1. WHEN 用户点击「项目管理」标题，THE The_App SHALL 切换项目管理面板的展开与收起状态。
2. WHEN 用户填写项目名称并点击「添加」，THE The_App SHALL 将该项目（含可选 MR 地址与本地路径）加入项目列表。
3. IF 用户添加的项目名称已存在，THEN THE The_App SHALL 显示「项目已存在」提示并阻止添加。
4. WHEN 用户对某项目点击编辑，THE The_App SHALL 将该项目切换为内联编辑行，允许修改名称、MR 地址与本地路径。
5. IF 用户将项目改名为另一已存在的项目名称，THEN THE The_App SHALL 显示「项目名称已存在」提示并阻止保存。
6. WHEN 用户删除某项目，THE The_App SHALL 从项目列表移除该项目并显示移除提示。
7. WHERE 项目配置了 MR 地址，THE The_App SHALL 在该项目标签旁显示「MR」链接与「NB」（基于 master 新建分支）链接。
8. WHERE 项目配置了本地路径，THE The_App SHALL 在该项目标签旁显示路径图标，并在悬浮提示中显示完整路径。

### Requirement 9: 上线分支设置与发版填写弹窗

**User Story:** 作为发版负责人，我希望设置公用上线分支或在发版时按项目填写目标分支，以便正确构建发版 MR。

#### Acceptance Criteria

1. WHEN 用户在项目管理中填写上线分支名并点击「保存上线分支」，THE The_App SHALL 保存全局上线分支名并持久化；保存为空时 THE The_App SHALL 清除上线分支。
2. IF 用户对 `pending` 需求点击「发版」且全局上线分支未设置，THEN THE The_App SHALL 弹出按项目填写目标分支的对话框，仅列出尚无目标分支的项目。
3. WHERE 需求涉及的所有项目均已有目标分支，THE The_App SHALL 直接发版而不弹出填写对话框。
4. IF 用户在目标分支填写对话框中存在未填写的项目，THEN THE The_App SHALL 显示「请填写所有项目的目标分支」提示、标红空输入框并阻止确认。
5. WHEN 用户在目标分支填写对话框点击「确认发版」且所有项目均已填写，THE The_App SHALL 将填写值与已有目标分支合并写入需求的目标分支映射，并将需求置为 `releasing`。
6. WHEN 用户点击取消、点击遮罩层或按下 Escape 键，THE The_App SHALL 关闭目标分支填写对话框且不发版。

### Requirement 10: 搜索过滤

**User Story:** 作为发版负责人，我希望按关键字搜索需求，以便在大量记录中快速定位。

#### Acceptance Criteria

1. WHEN 用户在搜索框输入关键字，THE The_App SHALL 按关键字（不区分大小写）过滤需求，匹配范围包括需求名称、需求链接、项目分支名与一同发版分支名。
2. WHILE 搜索框存在关键字，THE The_App SHALL 显示清除按钮。
3. WHEN 用户点击清除按钮或在存在关键字时按下 Escape 键，THE The_App SHALL 清空搜索关键字并恢复显示全部需求。

### Requirement 11: 备注管理

**User Story:** 作为发版负责人，我希望为分支添加备注，以便记录 SQL 脚本、DDL 变更等注意事项。

#### Acceptance Criteria

1. WHEN 用户在编辑行点击某分支行的备注按钮且项目名非空，THE The_App SHALL 打开可编辑的备注对话框。
2. IF 用户在编辑行点击备注按钮且项目名为空，THEN THE The_App SHALL 显示「请先输入项目名」提示并不打开对话框。
3. WHEN 用户在显示模式下点击已有备注的备注按钮，THE The_App SHALL 以只读方式打开备注对话框。
4. WHEN 用户在可编辑备注对话框点击保存，THE The_App SHALL 将备注内容写入对应分支并显示保存或清除提示。
5. WHEN 用户点击取消、点击遮罩层或按下 Escape 键，THE The_App SHALL 关闭备注对话框且不保存改动。

### Requirement 12: 分支右键上下文菜单

**User Story:** 作为发版负责人，我希望右键分支快速管理备注，以便高效操作。

#### Acceptance Criteria

1. WHEN 用户在「待发版」分区右键点击某项目分支对或一同发版分支，THE The_App SHALL 在光标位置显示包含「添加/编辑备注」选项的上下文菜单。
2. WHERE 该分支已有备注，THE The_App SHALL 在上下文菜单中额外显示「清除备注」选项。
3. WHEN 上下文菜单将超出视口边界，THE The_App SHALL 调整菜单位置使其完整显示在视口内。
4. WHEN 用户点击「编辑备注」，THE The_App SHALL 打开可编辑备注对话框。
5. WHEN 用户点击「清除备注」，THE The_App SHALL 清空该分支备注并刷新显示。
6. WHEN 用户点击页面其他位置、滚动页面或按下 Escape 键，THE The_App SHALL 关闭上下文菜单。

### Requirement 13: 分支抓取集成

**User Story:** 作为发版负责人，我希望从本地 Git 仓库抓取分支列表，以便选择正确的分支填入需求。

#### Acceptance Criteria

1. WHEN 用户点击「获取分支」且存在配置了本地路径的项目，THE The_App SHALL 通过本地分支 API 逐个抓取各项目分支并在弹窗中分组展示。
2. IF 用户点击「获取分支」时没有任何配置了本地路径的项目，THEN THE The_App SHALL 显示「没有配置本地路径的项目」提示。
3. IF 本地分支 API 不可达，THEN THE The_App SHALL 显示「请先启动服务器: node server.js」提示。
4. WHEN 用户在编辑行点击某分支行的分支查找按钮且对应项目配置了本地路径，THE The_App SHALL 打开该项目的分支列表弹窗（优先使用分支缓存）。
5. WHEN 用户在分支列表弹窗中点击某分支，THE The_App SHALL 将该分支名（去除空白字符后）填入对应的分支输入框。
6. WHEN 用户在分支弹窗的搜索框输入关键字，THE The_App SHALL 按分支名（不区分大小写）过滤分支列表。
7. WHERE 某分支已存在于已发版需求中，THE The_App SHALL 以删除线样式标记该分支。
8. WHEN 应用初始化且当天尚未自动抓取过分支，THE The_App SHALL 在后台对配置了本地路径的项目逐个抓取分支并显示进度条，每日最多自动抓取一次。

### Requirement 14: 数据持久化与导入导出

**User Story:** 作为发版负责人，我希望数据被持久保存并可导入导出，以便防止丢失并在设备间迁移。

#### Acceptance Criteria

1. WHEN 需求、项目列表或上线分支发生变更，THE The_App SHALL 将对应数据写入 `localStorage`，沿用现有键名（`todo_release_data`、`todo_project_names`、`todo_launch_branch`、`todo_branch_cache`）。
2. WHEN 应用初始化，THE The_App SHALL 优先尝试从同目录的 `toDo.json` 文件加载完整数据；加载失败时 THE The_App SHALL 从 `localStorage` 恢复数据。
3. WHEN 用户点击「导出」，THE The_App SHALL 将完整数据导出为文件名形如 `todoList-发版需求-{时间戳}.json` 的 JSON 文件。
4. WHEN 用户选择 JSON 文件导入，THE The_App SHALL 用文件内容替换当前完整数据、持久化并刷新界面，显示导入的需求条数。
5. IF 导入的文件不是合法 JSON，THEN THE The_App SHALL 显示「导入失败：JSON 格式错误」提示。
6. WHEN 保存分支缓存，THE The_App SHALL 过滤掉以 `origin/` 开头及名为 `origin` 的分支。

### Requirement 15: 每日备份提醒

**User Story:** 作为发版负责人，我希望每天首次打开时收到备份提醒，以便防止缓存清理导致数据丢失。

#### Acceptance Criteria

1. WHEN 应用加载且当天尚未显示过提醒，THE The_App SHALL 显示数据备份提醒弹窗。
2. WHEN 用户在提醒弹窗点击「导出保存」，THE The_App SHALL 导出数据并关闭弹窗，同时记录当天已提醒。
3. WHEN 用户在提醒弹窗点击「暂不保存」，THE The_App SHALL 关闭弹窗并记录当天已提醒。

### Requirement 16: 键盘快捷键

**User Story:** 作为发版负责人，我希望使用键盘快捷键，以便提升操作效率。

#### Acceptance Criteria

1. WHEN 用户按下 Ctrl/Cmd + N，THE The_App SHALL 开始新增需求。
2. WHEN 用户按下 Ctrl/Cmd + F，THE The_App SHALL 聚焦到搜索框。
3. WHEN 用户按下 Escape 键，THE The_App SHALL 依次关闭已打开的上下文菜单、备注对话框、确认对话框与上线分支对话框，并在存在搜索关键字时清空搜索。

### Requirement 17: 发版中项目汇总

**User Story:** 作为发版负责人，我希望在「发版中」标题旁看到涉及项目的汇总，以便一键发起合并到 master 的 MR。

#### Acceptance Criteria

1. WHILE 「发版中」分区存在需求，THE The_App SHALL 在分区标题旁汇总展示这些需求涉及的所有项目（去重）。
2. WHERE 某汇总项目配置了 MR 地址，THE The_App SHALL 使其标签可点击，跳转到以上线分支（或该项目的目标分支）为源、`master` 为目标构建的新建 MR 页面。

### Requirement 18: MR 与分支 URL 构建

**User Story:** 作为发版负责人，我希望系统据 MR 基础地址正确构建 GitLab 链接，以便直接打开合并请求或新建分支页面。

#### Acceptance Criteria

1. WHEN 构建新建 MR 链接，THE The_App SHALL 基于项目 MR 基础地址生成 `merge_requests/new` 路径，并附加经 URL 编码的源分支与目标分支参数。
2. WHERE 未显式指定目标分支，THE The_App SHALL 依次回退使用全局上线分支或 `master_launched` 作为目标分支。
3. WHEN 构建新建分支链接，THE The_App SHALL 基于项目 MR 基础地址生成 `branches/new` 路径，并附加经 URL 编码的来源分支参数与名为 `master_{MMDD}` 的新分支名参数。

### Requirement 19: 复制与提示反馈

**User Story:** 作为发版负责人，我希望复制操作有明确反馈且在不支持剪贴板 API 时仍可用，以便确认操作成功。

#### Acceptance Criteria

1. WHEN 用户触发复制操作，THE The_App SHALL 将目标文本写入剪贴板并显示包含该文本的成功提示。
2. IF 浏览器剪贴板 API 不可用，THEN THE The_App SHALL 使用临时文本域执行复制作为回退方案。
3. WHEN 显示 Toast 提示，THE The_App SHALL 在约 1.6 秒后自动隐藏该提示。

---

# v2 新增需求（飞书项目同步 · GitLab 分支直读 · 需求↔分支关联）

> 以下四条是 v2 在 v1 基础上的能力扩展。**约束**：v1 的既有字段与 localStorage 键名保持不变，
> 新增字段一律向后兼容 —— 旧导出文件仍可导入，旧数据仍可正常使用。

### Requirement 20: 飞书项目需求批量同步

**User Story:** 作为发版负责人，我希望按条件从飞书项目一次拉取一批需求，以便不再手工复制标题与链接。

#### Acceptance Criteria

1. WHEN 用户打开「同步设置」，THE The_App SHALL 加载并展示当前登录身份可访问的飞书项目空间，并允许选择其一。
2. WHEN 用户选定空间，THE The_App SHALL 加载该空间的工作项类型并允许**多选**，默认勾选名称含「需求管理」或「优化」的类型。
3. WHERE 同一空间内需求按业务域拆分为多个工作项类型，THE The_App SHALL 对每个选中类型分别查询并合并结果，任一类型失败 SHALL 只记录该类型的错误而不中断其余类型。
4. WHEN 用户打开「同步预览」，THE The_App SHALL 展示待导入需求的需求ID、名称、状态、所属类型与飞书详情链接。
5. WHEN 需求在本地已存在同需求ID的记录，THE The_App SHALL 将其标记为「已导入」且**不重复创建**。
6. WHEN 用户导入选中的需求，THE The_App SHALL 以状态 `new` 创建需求，并写入 `source` 溯源字段（provider / projectKey / simpleName / workItemType / workItemId / syncedAt）。
7. WHEN 同步时本地已存在同一需求，THE The_App SHALL **不覆盖**本地已修改的内容。
8. IF 用户未登录飞书项目，THEN THE The_App SHALL 给出明确的重新登录指引且不打开空白的预览窗口。
9. WHEN 查询使用 MQL，THE The_App SHALL 由前端下发可编辑的 MQL 模板（含 `{space}` 与 `{type}` 占位符），服务端不得硬编码查询语句。
10. WHEN 用户打开「同步预览」，THE The_App SHALL **不预勾选任何需求、不默认启用「只看未导入」筛选**，把筛选与勾选的决定权交给用户。
11. THE The_App SHALL 按需求状态分组展示预览结果，并在组头给出条数与新增数，支持「全选本组 / 取消本组」。
12. WHEN 用户点击分组标题，THE The_App SHALL 切换该组的展开与收起；收起只影响显示，不得改变已勾选的项，且收起态下「全选本组 / 取消本组」仍可用。

### Requirement 21: GitLab 分支直读

**User Story:** 作为发版负责人，我希望不依赖本地克隆就能看到远端真实分支，以便在任意机器上选对分支。

#### Acceptance Criteria

1. WHEN 项目配置了仓库地址（或可从 MR 地址推导），THE The_App SHALL 通过 `git ls-remote` 列出远端分支，**不要求本地克隆、不要求额外凭据**。
2. WHEN 本地存在克隆，THE The_App SHALL 同时保留原有本地分支通道（含作者与日期），两条通道并存互不替代。
3. THE The_App SHALL 过滤环境与临时分支（如 `dev`、`uat`、`test`、`master_launched`、`mdmdev`、`mdmuat`、`mdmtest`、`*_old`、`*_copy`、`copy分支`、`复制分支`）。
4. WHERE 项目配置了本地路径，THE The_App SHALL 以远端真实分支列表与本地 ref 取交集，滤除远端已删除的陈旧分支。
5. WHERE 用户未关闭「只看我的分支」，THE The_App SHALL 只保留由当前提交身份创建的分支，创建者按该分支**首个独占提交的作者**判定。
6. IF 无法取得当前提交身份，THEN THE The_App SHALL 不做创建者过滤并如实回传未过滤，而不是把所有分支判为他人分支而清空索引。
7. WHEN 服务端口与默认端口不一致，THE The_App SHALL 读取服务写入的端口文件并连到实际端口，不得静默把请求打到其他进程。
8. IF 远端不可达，THEN THE The_App SHALL 记录错误并降级为纯本地分析，而不是让整个索引失败。

### Requirement 22: 需求与分支的自动关联

**User Story:** 作为发版负责人，我希望系统自动把需求与分支对应起来，以便不再逐个手选分支，且能识别一个分支服务多个需求的融合分支。

#### Acceptance Criteria

1. WHEN 计算分支所覆盖的需求，THE The_App SHALL 以该分支相对发布主线的 **`--first-parent` 独占提交**中出现的需求ID为准，**不得依赖分支名**。
2. THE The_App SHALL 将「分支名中包含的需求ID」作为并列的第二条来源，与实际反查结果取**并集**，并在界面上标注来源（反查 / 分支名 / 手工）。
3. WHERE 一个分支覆盖多个需求，THE The_App SHALL 使该分支同时被这些需求引用。
4. WHEN 展示某条需求的分支，THE The_App SHALL 提示该分支还覆盖的**其他**需求数量与需求ID，以便发现隐藏的同行者。
5. WHEN 某需求未写入 `source.workItemId`，THE The_App SHALL 从需求链接中提取需求ID作为自身标识。
6. WHERE 同一需求在同一项目命中多个分支，THE The_App SHALL 优先选择反查命中且独占提交更少的作为主分支，其余分支保留为可选项而非丢弃。
7. THE The_App SHALL 将分支索引结果限定在有效期内（默认 10 分钟），过期后重新计算。
8. WHEN 需求行所挂分支之外，索引还查到能覆盖该需求的**其他分支**，THE The_App SHALL 在需求行上以「自动匹配：项目 · 分支」列出该建议，并支持点击一键挂到该需求；已手工挂过的同一条分支不得重复提示。
9. IF 该需求在同一项目下已挂有别的分支，THEN THE The_App SHALL 不覆盖已有分支，只提示用户自行更换。

### Requirement 23: 未登记分支发现与处置

**User Story:** 作为发版负责人，我希望知道哪些分支有代码却没有需求登记，以便避免发版时漏掉它们。

#### Acceptance Criteria

1. WHEN 分支相对发布主线存在独占提交、且三条关联来源都查不到需求ID，THE The_App SHALL 将其列为「未登记分支」。
2. THE The_App SHALL 按分支名跨项目聚合展示未登记分支，并给出涉及项目数与提交总数。
3. WHEN 用户对未登记分支选择「无需需求」或「忽略」，THE The_App SHALL 记录该处置并使其不再出现在列表中，且该处置对同名分支的所有项目同时生效。
4. WHEN 用户恢复已处置的分支，THE The_App SHALL 使其重新出现在列表中。
5. THE The_App SHALL 持久化未登记分支的处置结果，并在导出数据时一并导出。
6. THE The_App SHALL 默认收起「未登记分支」面板（标题上仍显示条数），点击标题可展开。
7. THE The_App SHALL 支持按**分支名或项目名**筛选未登记分支，显示命中数与总数的比，无命中时给出区别于「暂无未登记分支」的空态；筛选同时作用于已处置分支区。

### Requirement 24: 手动刷新分支索引

**User Story:** 作为发版负责人，我希望按需重算分支与需求的关联，以便不必每次打开页面都等待 git 分析。

#### Acceptance Criteria

1. WHEN 用户点击「刷新分支索引」，THE The_App SHALL 显示进度并逐个项目重新计算索引。
2. WHILE 索引计算进行中，THE The_App SHALL 禁止重复触发并给出进行中提示。
3. WHEN 索引计算完成，THE The_App SHALL 更新未登记分支列表与影响面提示。
4. WHERE 项目未同时配置 MR 地址与本地路径（无法取得提交历史），THE The_App SHALL 跳过该项目并明确说明原因，而不是静默返回空结果。


