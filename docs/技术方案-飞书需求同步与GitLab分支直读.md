# 发版小助手 · 飞书项目需求同步 + GitLab 分支直读 · 技术方案

| 项 | 内容 |
|---|---|
| 状态 | 待评审（v3，修正 L1 反查算法 + 新增「未登记分支」反向发现） |
| 日期 | 2026-10-29 |
| 目标仓库 | `D:\自研\发版小助手`（origin: github.com/sunshine1130/release-pilot） |
| 涉及改动 | `server.js`、`todo-release.js`、`todo-release.html`、`todo-release.css`、`使用说明.html`、`.kiro/specs/vue-migration/requirements.md` |

> v1→v2：关联机制从「分支名匹配」改为「独占提交反查」（融合分支需求）。
> v2→v3：修正反查算法（`--first-parent` + 固定基线），并把「有代码但无需求登记」的分支提升为一等功能。

---

## 0. 结论先行

两个方向都成立，且合起来才能同时消掉「手工贴需求」和「手工选分支」。可行性已在本机实测，不是推断：

| 验证项 | 命令 | 结果 |
|---|---|---|
| 飞书项目 CLI 可用 | `meegle auth status` | CLI 已装，host=`project.feishu.cn`，**未登录**（`no local token`） |
| GitLab API 存活 | `GET http://git.joyintoy.cn/api/v4/version` | 401（服务正常，缺 token） |
| **分支直读（零凭据）** | `git ls-remote --heads https://git.joyintoy.cn/joyin/pms-web.git` | **exit=0，40 个分支，1.29s** ✅ |
| 并发 5 仓 | 5 个 `ls-remote` 并发 | 总计 2.9s |
| GitLab API 匿名访问 | `GET /api/v4/projects/joyin%2Fpms-web/repository/branches` | 404（私有项目） |
| 复用 git 凭据调 API | basic auth / `PRIVATE-TOKEN` | **401 全部失败**（存的是 8 位账号密码，不是 PAT） |
| **融合分支反查** | `git log --first-parent %s master..分支` | `feat/ops四需求合并分支` 精确还原 **4 个需求ID** ✅ |
| 反查（不排除基线，错误做法） | 直接 `git log origin/<分支>` | 冒出 6~9 个他人的需求ID，**不可用** |
| **反查（缺 `--first-parent`）** | `git log %s 基线..分支` | 把分支 merge 进来的兄弟分支工作算成自己的，**不可用** |
| 全仓提交扫描性能 | `git log --all --format=%s`（ops-web） | 915 条，**0.26s** |

### 最重要的四个发现

**1）关联线索不是分支名，是「分支 first-parent 独占提交里的需求ID」**

初版认为「分支名带需求ID 所以能闭环」，被证伪：实测 5 仓 128 个分支，**只有约四成带 10 位 ID**，融合/长期分支一律不带（`feat/ops四需求合并分支`、`feat/mdm公共分支_权限字段合并`、`perf/integration`、`refactor/price-management`）。

真正的线索是 commit message 里的需求ID（提交规范 `feat(模块-需求ID): ...`）。但**两个坑必须同时避开**：

```bash
# ✗ 坑1：log 整个分支 —— 会把从 dev/master 继承的上游提交全算进来
git log --format=%s origin/feat/TextSearch组件优化 | grep -oE '[0-9]{10}' | sort -u
→ 9 个 ID，几乎全是别人的需求

# ✗ 坑2：只排除基线但不用 --first-parent —— 会把分支 merge 进来的兄弟分支算成自己的
#    （实测 feat/7101366806默认规则属性配置 merge 了 feat/mdm三期分支）

# ✓ 正解
base=$(git merge-base origin/master "origin/feat/ops四需求合并分支")
git log --first-parent --format=%s "$base..origin/feat/ops四需求合并分支"
      | grep -oE '(^|[^0-9])[0-9]{10}([^0-9]|$)' | sort -u
→ 7029460314 7058457690 7072591743 7073079049   ← 正好 4 个，与「四需求」吻合 ✅
```

**2）基线必须固定为发布主线，不能用「取独占提交最少」的启发式（v2 的算法错误）**

v2 写的「对候选主线取独占提交数最少者」实测会**把分支真正的工作整个吞掉**。实测对照：

| 分支 | base=master (全部/fp) | base=dev (全部/fp) | base=mdmdev (全部/fp) |
|---|---|---|---|
| `pms-web feat/7101366806默认规则属性配置` | **256 / 80** → `7048154426 7101366806` ✅ | 184 / 38 → 只有 `7101366806` | **1 / 1 → 0 个 ID** ❌ |
| `ops-web feat/ops四需求合并分支` | **19 / 8** → 4 个 ID ✅ | 2 / 2 → 只有 1 个 ID ❌ | 19 / 8 → 4 个 ✅ |
| `aps-web feat/6929850538中台重构二期` | 1 / 1 → 无 ID | 1 / 1 → 无 ID | 1 / 1 → 无 ID |

取"最少"会把 base 选到已经吸收了该分支的 dev/mdmdev 上，导致只看到 1 个提交、0 个 ID。**必须固定用发布主线 `master`（可配优先级），并配合 `--first-parent`。**

**3）L1 和 L2 必须取并集，不是主备降级关系（v2 的第二个错误）**

实测中大量**分支名带 ID、但 commit message 没写 ID** 的分支（作者没按规范写提交信息）：

```
aps-web  feat/6929850538中台重构二期   → message: "refactor(采购计划): 修改采购订单跳转逻辑"   无 ID
scm-web  feat/7128829743费用单新增批量驳回按钮 → message: "feat: 增加批量驳回功能并重构批量操作逻辑"  无 ID
```

这两个都是**近期活跃**分支（2026-05-07 / 2026-09-30）。全仓统计里 **L2 单独补位 14 个**（aps-web 一家就 8 个）。所以 L1 ∪ L2，UI 上标注各自来源与置信度。

**4）最大的风险不是"关联不上"，而是"有代码但没有任何需求登记"**

按 v3 算法统计 5 个仓库：

| 仓库 | L1 命中 | L2 补位 | **两路皆空（未登记）** |
|---|---|---|---|
| pms-web | 22 | 2 | 3 |
| aps-web | 6 | **8** | **8** |
| scm-web | 5 | 2 | 7 |
| auth-web | 1 | 0 | 5 |
| ops-web | 7 | 2 | 1 |
| **合计** | **41** | **14** | **24** |

其中**活跃且承载大量提交**的未登记分支（这才是真正会漏发的）：

```
aps-web  2026-10-22  feat/mdm交付计划新增命中测试功能   first-parent 提交 42
aps-web  2026-10-21  feat/mdm二期分支                  first-parent 提交 41
scm-web  2026-10-16  refactor/price-management         first-parent 提交 58
scm-web  2026-10-12  feat/mdm二期分支                  first-parent 提交 49
ops-web  2026-09-21  feat/mdm二期分支                  first-parent 提交 28
aps-web  2026-08-24  feat/tms环境变量添加mdm前缀         first-parent 提交 24
```

**`feat/mdm二期分支` 同时存在于 aps-web / scm-web / ops-web 三个项目，合计 118 个 first-parent 提交，最近提交都在 2026-10 月**——一个横跨三项目、还在活跃开发的集成分支，在现有工具里完全不可见。这类分支正如你所说：需求早期没出，或相关需求/优化太多就都做在一起了。

**结论：这个工具的价值不只是"从需求找分支"，还包括反过来"从分支找没登记的需求"。** 这是 G5。

---

## 1. 目标与非目标

### 1.1 目标（可验收）

| # | 目标 | 验收方式 |
|---|---|---|
| G1 | 从飞书项目按条件拉取需求（标题 + 需求ID + 链接），去重后导入本地 | 点一次同步，勾选后生成 N 条 `status=new` 的需求 |
| G2 | 分支列表可从 GitLab 直读，不依赖本地 clone | 项目只配 `mr` 地址、不配 `localPath`，仍能列出分支 |
| G3 | 自动建立「需求 ↔ 分支」关联，**含融合分支（一分支多需求）** | 融合分支被 4 条需求正确引用，且无幻觉关联 |
| G4 | 全流程零手工输入 | 从「贴标题+链接+选分支」变为「审核 + 点保存」 |
| **G5** | **反向发现「有代码但无需求登记」的分支，防止发版漏发** | `feat/mdm二期分支` 等 24 个未登记分支被列出，可关联/豁免/忽略 |

### 1.2 非目标（本期不做）

- **不回写飞书项目**（状态流转、评论、流转节点）——写别人系统数据，风险与收益不对等，留作 P3；
- 不改现有 4 个 `localStorage` 键名、不改导出 JSON 的既有字段语义；
- 不引入构建工具、不引入 npm 运行时依赖（保持「双击 HTML 就能用」）；
- 不做多用户/服务端部署，仍是本机个人工具。

---

## 2. 现状与约束

### 2.1 现状架构

```
浏览器 (todo-release.html + todo-release.js, Vue3 全局构建)
   │  localStorage: todo_release_data / todo_project_names / todo_launch_branch / todo_branch_cache
   │
   ├─ fetch ./toDo.json                 ← 优先数据源
   └─ fetch http://localhost:1949/api/… ← 唯一后端
                    │
              server.js (node 原生 http，无依赖)
                    ├─ /api/git-user   → git config user.name
                    ├─ /api/branches   → 对 localPath 执行 git for-each-ref
                    └─ 静态文件服务
```

### 2.2 约束

1. **无构建、无依赖**：不能 `npm install`，不能用 ESM/TS，浏览器侧只能用 `<script>` 全局 Vue。
2. **兼容面**：`requirements.md` 第 14 条要求「保留数据结构、localStorage 键名与导出 JSON 格式」。本次是**主动扩字段**，属于对规格的有意变更，必须同步更新规格与使用说明。
3. **工作区有待决改动**：`todo-release.js` 有一行未提交改动（`changeStatus` 中 `newStatus==='pending'` 无条件清除 `releaseTime`），与规格 5.5 冲突。**开工前先定稿并提交**。
4. **平台**：Windows + Git for Windows。git 凭据助手会子进程启动 `sh.exe`，受限沙箱下会失败（`couldn't create signal pipe, Win32 error 5`），GitLab 通道**必须在正常用户进程里运行**。

---

## 3. 总体设计

### 3.1 改造后的数据流

```
飞书项目 (Meegle)                     GitLab / 本地 clone
      │                                      │
      │ meegle CLI (复用 OAuth token)         │ git ls-remote      → 分支名（零凭据，未 clone 可用）
      │                                      │ git log --first-parent → 分支↔需求ID 反查（需 clone）
      ▼                                      ▼
┌───────────────────────────────────────────────────────────────────┐
│ server.js  :1949                                                  │
│   /api/meegle/*         → spawn meegle CLI → 结构化 JSON           │
│   /api/git/branches     → git ls-remote → 分支名列表                │
│   /api/git/branch-index → merge-base + log --first-parent → 需求ID  │
│   /api/branches         → 保留（原有本地 git 通道，行为不变）        │
└───────────────────────────────────────────────────────────────────┘
      │
      ▼
┌───────────────────────────────────────────────────────────────────┐
│ todo-release.js (前端)                                             │
│   ① 合并去重(source 唯一键)     ② 需求↔分支 L1∪L2∪L3 关联          │
│   ③ 未登记分支发现与处置        ④ 预览确认 → 写入 items/缓存        │
└───────────────────────────────────────────────────────────────────┘
```

**职责切分原则**：server 只负责「取数据、转 JSON」，不含业务判断；**去重、关联、合并全部在前端**（前端才持有 localStorage 全量数据），避免两处状态。

### 3.2 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 飞书项目接入 | spawn `meegle` CLI | 复用 CLI 的 OAuth 与 token 刷新，**不用注册飞书应用** |
| 备选（已否决） | 直接调飞书项目 OpenAPI | 需自建应用、申请权限、实现 token 生命周期，成本高一个量级 |
| 分支枚举 | `git ls-remote` 优先 | 零新凭据、零配置、未 clone 也能用；实测 1.3s/仓 |
| 需求↔分支关联 | **L1 反查（first-parent 独占提交）× L2 分支名 × L3 人工，取并集** | 实测三者互不覆盖：L1 覆盖融合分支、L2 补提交信息未规范的分支、L3 兜早期分支 |
| 基线选择 | **固定发布主线 master（可配优先级）** | 实测「取最少」启发式会吞掉分支工作 |
| 富筛选（作者/日期） | GitLab REST API + PAT（P2 可选） | 要用户建 PAT，不阻断主流程 |

---

## 4. 需求 ↔ 分支关联策略（核心）

### 4.1 三条路径取并集（不是降级）

| 路径 | 机制 | 覆盖场景 | 实测覆盖 | 置信度 |
|---|---|---|---|---|
| **L1 反查** | 分支 `--first-parent` 独占提交中提取需求ID | 融合分支、分支名无ID的分支 | 41 | 高 |
| **L2 分支名** | 分支名含该需求ID（数字边界） | commit message 未按规范写的分支 | 14 | 中 |
| **L3 人工** | 手工把分支挂到需求上，写入 `todo_branch_links` 长期复用 | 早期分支（提交信息早于规范落地） | 按需 | 高（人给的） |

**三者结果合并去重**，UI 上按来源标注（`反查` / `分支名` / `手工`），让用户能判断可信度。任一路径命中即视为已登记，不再进入「未登记分支」列表。

### 4.2 L1 算法（v3 修正版）

```
输入：项目本地路径 path、发布主线 base='origin/master'（可配优先级列表）
对每个远端分支 b（先排除环境/主线/`*_old`/`*_copy`）：
    mb = git merge-base <base> <b>              # 失败 → 跳过该分支
    n  = git rev-list --count --first-parent mb..b
    若 n == 0 → 该分支已并入主线，标记「已合并」，跳过
    ids = git log --first-parent --format=%s mb..b
          | 提取 10 位需求ID（数字边界）| 去重
    lastDate = git log -1 --format=%ad --date=short b
产出：{ b: { ids, base, commits: n, lastDate } }
```

三个必须遵守的点（均为实测教训）：

1. **`--first-parent` 不能省**：分支会互相 merge（实测 `feat/7101366806默认规则属性配置` merge 了 `feat/mdm三期分支`），不加会把兄弟分支的工作算到自己头上。
2. **base 固定为发布主线**：不要在多条主线里挑「独占提交最少」的（会把 base 选到已吸收该分支的 dev 上，实测导致 0 个 ID）。
3. **数字边界**：用 `(^|[^0-9])[0-9]{10}([^0-9]|$)`，防止子串误命中。

产出索引（前端由正向索引实时翻转）：

```js
// 正向：分支 → 覆盖的需求
branchIndex['ops-web']['feat/ops四需求合并分支'] = {
  ids: ['7029460314','7058457690','7072591743','7073079049'],
  base: 'origin/master', commits: 8, lastDate: '2026-05-11', via: 'L1'
}
// 反向：需求ID → 所有 (项目, 分支)
reqToBranches['7029460314'] = [
  { project: 'ops-web', branch: 'feat/7029460314销售预测迭代', via: 'L1' },
  { project: 'ops-web', branch: 'feat/ops四需求合并分支',        via: 'L1' }
]
```

### 4.3 未登记分支发现（G5，本方案新增的重点）

**判定**：分支 `first-parent` 独占提交 `n > 0`，且 L1/L2/L3 三路都没关联到任何已知需求ID → 进入「未登记分支」列表。

**排序**：按 `n × 活跃度权重` 降序（活跃度 = 最近提交距今的衰减）。实测真正值得关注的是 `n ≥ 20` 且近期活跃的那批：

| 项目 | 分支 | fp 提交 | 最近提交 |
|---|---|---|---|
| scm-web | `refactor/price-management` | 58 | 2026-10-16 |
| scm-web | `feat/mdm二期分支` | 49 | 2026-10-12 |
| aps-web | `feat/mdm交付计划新增命中测试功能` | 42 | 2026-10-22 |
| aps-web | `feat/mdm二期分支` | 41 | 2026-10-21 |
| ops-web | `feat/mdm二期分支` | 28 | 2026-09-21 |
| aps-web | `feat/tms环境变量添加mdm前缀` | 24 | 2026-08-24 |

**跨项目聚合**：同名分支（如 `feat/mdm二期分支` 出现在 3 个项目）合并展示为一张卡片，显示「跨 3 个项目，合计 118 个提交」，避免逐个项目重复处理。

**三种处置**（写入 `todo_branch_triage` 长期记忆，不再重复提示）：

| 处置 | 语义 | 后续行为 |
|---|---|---|
| 关联到需求 | 挂到 1~N 条需求（等价 L3） | 参与正常发版流程 |
| 标记为「无需需求」 | 纯技术重构/组件优化/环境调整 | 从列表消失，但发版时若该分支被选中会提示 |
| 忽略 | 已废弃 / 不关心 | 从列表消失，不再提示 |

### 4.4 多对多的表示

数据模型无需为融合分支加新结构：`item.projects` 本来就是数组，**一个需求挂多个分支是既有能力**。融合分支被 4 条需求引用时，就是 4 条需求行各自带同一个 `{name, branch}`。

**影响面提示（建议做）**：分支标签上显示「**此分支还服务：7058457690 / 7072591743 / 7073079049**」。发版时一眼看出这次改动会带上谁，防漏发/误发。这条在实测中得到强化——`feat/7101366806默认规则属性配置` 的 first-parent 提交里除自身外还带出 `7048154426`，即**分支名只写了一个需求，代码里实际覆盖两个**，靠 L2 永远发现不了。

### 4.5 典型场景对照（实测）

| 分支 | 类型 | L1（first-parent） | 结论 |
|---|---|---|---|
| `feat/ops四需求合并分支` | 融合分支 | 4 个 ID | L1 精准 ✅ |
| `feat/7101366806默认规则属性配置` | 单需求分支（还覆盖另一个需求） | `7048154426 7101366806` | L1 发现隐藏覆盖 ✅ |
| `feat/7029460314销售预测迭代` | 单需求分支 | `7029460314` | 与分支名自校验一致 ✅ |
| `feat/6929850538中台重构二期` | 提交信息未写ID | 无 | **L2 补位** ✅ |
| `fix/渠道下拉框数据错误` | 已合入主线 | fp 提交 0 | 跳过，噪声归零 ✅ |
| `feat/mdm二期分支` | 需求未出/需求太多 | 无 | **未登记分支**，走 G5 ✅ |

---

## 5. 数据模型变更

### 5.1 需求（item）新增 `source`

```js
{
  id, name, link, status, projects, syncBranches, targetBranches, releaseTime,
  // ↓ 新增，可选；旧数据没有该字段，完全兼容
  source: {
    provider: 'meegle', projectKey: 'xxx', simpleName: 'xxx',
    workItemType: 'story', workItemId: '7134246577', syncedAt: 1761700000000
  }
}
```

**去重唯一键**：`source.provider + ':' + source.workItemId`。

### 5.2 项目（Project）新增可选 `repo`

```js
{ name: 'pms-web', mr: 'https://git.joyintoy.cn/joyin/pms-web', localPath: 'C:\\项目\\pms-web', repo: '' }
```

- `repo` 留空时**从 `mr` 推导**：去掉 `/-/merge_requests...` 段与末尾 `/`，补 `.git`；
- `localPath` 存在才能跑 L1 反查；否则只能走 L2。

### 5.3 新增 localStorage 键（不动现有 4 个）

| 键名 | 内容 |
|---|---|
| `todo_integration_config` | 空间、工作项类型、过滤条件、参与项目、**发布主线优先级**、环境分支排除规则 |
| `todo_branch_links` | **L3 人工关联记忆**：`{ '项目\u0000分支': ['需求ID', ...] }` |
| `todo_branch_triage` | **未登记分支处置**：`{ '项目\u0000分支': { action: 'exempt'\|'ignored'\|'linked', ids: [], at: ts } }` |

`todo_branch_cache` 复用并扩展：

```js
{
  'pms-web': {
    branches: [{ branch, author, date, message, isRemote }],   // 原有本地通道
    names: [...],                                              // ls-remote 通道（仅名字）
    repo: 'https://git.joyintoy.cn/joyin/pms-web.git',
    source: 'ls-remote' | 'local',
    base: 'origin/master',
    index: { 'feat/xxx': { ids: [], commits, lastDate } },      // L1 反查结果
    unregistered: ['refactor/xxx', ...],                        // 未登记分支名
    timestamp: 1761700000000
  }
}
```

### 5.4 导出 JSON

新增字段随 `getFullData()` 自然导出，**不删不改既有字段**。导入旧文件（无 `source`）行为不变。

---

## 6. 接口设计（server.js 新增）

统一约定：JSON 进出；错误 `{ error, code? }`；每个外部调用带超时。

### 6.1 飞书项目

| 接口 | 请求 | 响应 |
|---|---|---|
| `GET /api/meegle/status` | — | `{ authenticated, host }` |
| `GET /api/meegle/spaces?q=<关键字>` | — | `{ spaces: [{ projectKey, simpleName, name }] }` |
| `POST /api/meegle/query` | `{ projectKey, mql, sessionId?, pageNum? }` | `{ items: [{ workItemId, workItemType, name, status, link, owners }], count, sessionId }` |

要点：spawn `meegle workitem query --project-key <k> --mql <m> --format json`；**翻页**按 skill 协议（首查拿 `session_id` + `count`，后续只传 `--session-id` + `--group-pagination-list`）；链接拼 `https://project.feishu.cn/{simple_name}/{work_item_type}/detail/{work_item_id}` 并用 `meegle url decode` 反校验；Windows 下须走 `meegle.cmd`；未登录返回 `code: 'MEEGLE_UNAUTH'`。

### 6.2 分支枚举

| 接口 | 请求 | 响应 |
|---|---|---|
| `GET /api/git/branches?repo=<url>&match=<pattern>` | — | `{ branches: [{ name }], source: 'ls-remote', cached, elapsedMs }` |
| `GET /api/git/branches?path=<localPath>` | — | 原有本地 git 通道（**行为不变**） |

要点：`execFile('git', ['ls-remote','--heads', repo, ...])`；**必须 `GIT_TERMINAL_PROMPT=0`**（否则挂死在交互输入）；超时 15s/仓；并发 4；LRU + TTL 10 分钟；URL 仅允许 `http(s)://` 并以 `--` 分隔防参数注入。

### 6.3 L1 反查（新增）

| 接口 | 请求 | 响应 |
|---|---|---|
| `GET /api/git/branch-index?path=<localPath>&base=master&markUnregistered=1` | — | `{ base, branches: [{ name, ids, commits, lastDate, merged }], elapsedMs }` |

要点：

- 一次 `git for-each-ref` 取分支，逐个跑 §4.2；`merge-base` / `rev-list` 失败即跳过该分支；
- 纯本地操作，实测 `git log --all` 单仓 0.26s，预计 1~3s/仓，并发 2~4；
- 结果随 `branchesCache[项目].index` 持久化，TTL 10 分钟，「刷新分支索引」可强制重算；
- **性能保护**：`--first-parent` 后仍超过阈值（如 500）的巨大分支可整体跳过并标注，避免拖垮刷新。

### 6.4 环境分支过滤（共用）

现有正则 `^(master|test|dev|main|release|staging|hotfix|uat)(\b|_)` 挡不住 `mdmdev`/`mdmuat`/`mdmtest`/`mdmtouat`。补充（可配）：

- `<前缀><环境>` 模式：前缀非空 + 环境词 ∈ {dev,test,uat,staging,prod,release}；
- `*_old` / `*_copy` / `复制分支` / `copy分支` 一并排除；
- 注意 `release-20260721`、`flx-0721` 这类**发版批次分支**（auth-web 实测存在）不在排除列表，会进「未登记分支」，属于预期行为。

---

## 7. 前端改造

### 7.1 新增 UI

| 位置 | 元素 | 行为 |
|---|---|---|
| 顶部按钮区 | 「同步飞书项目」 | 未登录时提示；已登录则打开同步预览弹窗 |
| 顶部按钮区 | 「同步设置」 | 空间、工作项类型、过滤条件、参与项目、发布主线优先级 |
| 顶部按钮区 | 「刷新分支索引」 | 强制重算 L1 反查（默认走缓存） |
| **未登记分支卡片区** | 列表 | 按 `提交数×活跃度` 排序；跨项目同名聚合；三种处置按钮 |
| 同步预览弹窗 | 三段列表 | ① 新需求 N 条（可勾选）② 已存在 M 条（默认不勾，可开「仅更新标题/链接」）③ 自动关联到分支 K 条（可预览、可取消单条） |
| 需求行分支列 | 影响面提示 | 「此分支还服务：xxx」；来源标注 `反查`/`分支名`/`手工` |
| 分支右键菜单 | 「关联到需求...」 | L3 人工关联，多选需求后写入 `todo_branch_links` |

### 7.2 同步流程（伪代码）

```
1. authStatus() → 未登录 ⇒ 提示 + 引导 `meegle auth login`
2. 对参与项目并发刷新 branchIndex(project)          // L1，带缓存
3. query(projectKey, mql) → 翻页取全量 → rawItems
4. 对每条 rawItem：
     key = 'meegle:' + workItemId
     存在 ⇒ 「已存在」（默认不覆盖）；否则 ⇒ 「新需求」（status = 'new'）
5. 对每条 rawItem：遍历参与项目，三路并集
     associate =
         L1: branchIndex[project][b].ids 含 workItemId
       ∪ L2: names 中数字边界命中
       ∪ L3: todo_branch_links 命中
     ⇒ projects = [{ name, branch, notes:'' }, ...]   // 允许一个需求挂多个分支
6. 未登记分支扫描：branchIndex 中 n>0、三路皆空、未被 triage 处置的分支
     ⇒ 渲染成卡片（跨项目聚合），等待处置
7. 用户在预览弹窗确认 → items.unshift(...) → saveToLocalStorage()
```

### 7.3 冲突与边界策略

| 场景 | 策略 |
|---|---|
| 一个需求ID命中多个分支 | 全部列出，默认选 L1 命中且 `commits` 最小的（越专一越可能是主分支），其余折叠为「另有 N 个」 |
| 一个分支服务多个需求（融合分支） | 各需求行各自引用，并在分支标签标注覆盖的其他需求 |
| 分支名写1个ID、代码覆盖面更大 | **以 L1 并集为准**，UI 上提示「分支名未写出的需求：7048154426」 |
| 需求ID无任何关联 | 只建需求行，分支留空，仍可用现有 📂 手动查 |
| L2 命中但 L1 空 | 采用，并标注来源「分支名（推断）」，与 L1 视觉区分 |
| 本地已手工改过标题/分支的同 ID 需求 | **默认不覆盖**，可开「仅更新标题/链接」 |
| 飞书里已关闭/删除的需求 | **本期不自动删**，预览里标注「飞书状态：已完成」由人决定 |
| 分支已被完全合入主线（fp 提交 0） | 不参与关联，标记「已合并」 |
| 项目既无 `mr` 也无 `localPath` | 跳过并提示 |

---

## 8. 里程碑与工作量

| 里程碑 | 内容 | 产出 | 估时 |
|---|---|---|---|
| **M0** | 定稿 5.5 待决改动并提交；接口骨架与配置存储 | `server.js` 骨架、config | 0.5d |
| **M1** | 分支枚举双通道、缓存、超时、并发、环境分支过滤 | `/api/git/branches` | 0.5d |
| **M2** | **L1 反查（first-parent + 固定基线）+ L1∪L2∪L3 并集 + 影响面提示** | `/api/git/branch-index` + 关联 UI | 1d |
| **M2.5** | **未登记分支发现与处置（G5）**：列表、跨项目聚合、三种处置、记忆 | 未登记分支视图 | 0.5d |
| **M3** | 飞书项目同步（登录引导、空间查询、MQL、翻页、链接拼装、去重合并、预览弹窗） | `/api/meegle/*` + 同步 UI | 1d |
| **M4** | 联调、UI 验收、更新 `requirements.md` 与 `使用说明.html` | 文档 + 验收报告 | 0.5d |
| | | **合计** | **≈4d** |

**建议顺序**：M1 → M2 → M2.5（**都不依赖任何授权，可立刻开工**）→ M3（等一次 meegle 授权）→ M4。

---

## 9. 测试与验收方案

### 9.1 分层测试

| 层 | 方式 |
|---|---|
| 接口层 | 打 `/api/git/branches`、`/api/git/branch-index`、`/api/meegle/*`，断言结构与错误码（未登录、超时、坏 URL、无 `.git`、非 git 仓库） |
| **算法层（重点）** | 用真实仓库做夹具：① 融合分支 `feat/ops四需求合并分支` → 恰好 4 个 ID；② `feat/7101366806…` → 含 `7048154426`（验证 first-parent 不漏 merge 前工作）；③ `feat/6929850538…` → L1 空、L2 命中；④ `fix/渠道下拉框数据错误` → fp 提交 0；⑤ 回归断言：**base=dev 时不得作为结果**（防算法倒退）；⑥ 数字边界不误命中 |
| 逻辑层 | 去重合并、L1/L2/L3 并集去重、未登记判定与 triage 记忆、`deriveRepoUrl`、环境分支过滤 |
| **UI 层（必须）** | **Playwright 驱动真实浏览器**打开 `http://localhost:1949`，覆盖：同步预览弹窗、勾选导入、多分支候选填入、影响面提示、**未登记分支卡片与三种处置**、Toast 文案、刷新后持久化 —— 不只交接口测试 |
| 回归 | 现有 19 条需求主路径（新增/编辑/发版/导入导出/备注/右键菜单）不得回归 |

### 9.2 验收清单（对应 G1–G5）

- [ ] 项目**只配 `mr`、不配 `localPath`**，点「获取分支」能列出 GitLab 分支
- [ ] `feat/ops四需求合并分支` 被识别为覆盖 4 个需求，4 条需求行都关联到它
- [ ] `feat/6929850538中台重构二期` 通过 L2 被关联（L1 空），来源标注为「分支名」
- [ ] `fix/渠道下拉框数据错误` 这类已合并分支**不产生**任何关联
- [ ] `feat/mdm二期分支` 出现在未登记分支列表，跨 aps/scm/ops 三项目聚合为一张卡片
- [ ] 未登记分支三种处置都能落库，刷新后不再重复提示
- [ ] 重复点同步不产生重复需求（按 `workItemId` 去重）
- [ ] 关闭页面重开数据仍在；导出 JSON 含新字段且旧文件仍可导入
- [ ] 未登录飞书项目 / 未启动 server 时，提示明确且不白屏

---

## 10. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| 提交信息未按规范写 ID | L1 空 | L2 补位（实测补 14 个）；UI 标注来源；L3 兜底 |
| 早期分支提交信息早于规范落地 | L1/L2 都空 | 归入未登记分支，人工一次性 triage 后长期记忆 |
| 分支互相 merge 导致归属错乱 | 关联错人 | 强制 `--first-parent`；结果过预览确认 |
| **误关联/漏关联导致发版漏发或错发** | 线上风险 | 关联结果必须经预览确认；L2 明确标注「推断」；影响面提示反向暴露 |
| 项目未本地 clone | 无法跑 L1 | 降级 L2；未登记列表无法覆盖（UI 明确说明覆盖范围）；P2 可选 PAT 走 API 补全 |
| 大仓库反查耗时 | 刷新卡顿 | 并发 2~4 + TTL 缓存 + 超大分支跳过阈值 + 进度条；实测 0.26s，风险低 |
| 未登记分支列表噪声过多（24 个） | 用户疲劳 | 按 `提交数×活跃度` 排序，默认只展示 `n ≥ 5` 且近 90 天活跃；一次 triage 后长期不再提示 |
| 飞书 CLI 未登录 / token 过期 | 同步不可用 | 检测 `auth status`，引导重新登录；不影响其他功能 |
| MQL 过滤条件字段语义不对 | 拉不到或拉多 | 授权后先 `workitem meta-fields` 探测；保留 `view get` 兜底；条件外置可编辑 |
| 空间名歧义（同名/无权限） | 无法定位空间 | `project search` 多命中不自动选，弹给用户 |
| `ls-remote` 某些仓库需交互式凭据 | 接口挂起 | 强制 `GIT_TERMINAL_PROMPT=0` + 超时 + 降级本地通道 |

---

## 11. 待确认事项

1. **同步口径**：默认过滤条件建议「负责人 = 我 且 状态未完成 且 指定迭代」；
2. **参与匹配的项目范围**：全部项目，还是固定 pms-web / aps-web / scm-web / auth-web / ops-web；
3. **发布主线**：确认固定用 `master`（本方案结论）；若存在比 master 更权威的发布主线请指定；
4. **未登记分支的默认展示阈值**：建议「first-parent 提交 ≥ 5 且近 90 天有提交」，避免 24 个全铺开；
5. **未登记分支是否需要「无需需求」这个豁免态**：技术重构类分支建议给，否则会一直挂在列表里；
6. **飞书需求被关闭/删除后**：本地保留、标记，还是允许一键清理；
7. **是否保留「手工新增需求」入口**：建议保留（临时/外部需求）；
8. **是否要 P3（状态回写飞书）**：本期建议不做。
