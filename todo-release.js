const { createApp, reactive, computed, watch, nextTick, onMounted } = Vue
const JSON_FILENAME = 'toDo.json'

/**
 * 本地引擎地址。
 *
 * 引擎在 1949 被占用时会自动顺延，并把实际端口写进同目录的 .server-port。
 * 这里如果继续写死 1949，服务一旦漂移，页面上所有请求都会打到别的进程上，
 * 而且不报任何错 —— 只表现为「按钮点了没反应」，极难排查。
 * 所以启动时先读端口文件，读不到再退回默认值（旧引擎不写这个文件，属正常情况）。
 */
const DEFAULT_API_PORT = 1949
// 用 reactive 而不是普通对象：端口是启动后才知道的，模板里的提示要跟着它出现
const api = reactive({ port: DEFAULT_API_PORT })

/**
 * 引擎跑在非默认端口上。
 *
 * 这不仅是「换个地址」：localStorage 按来源（协议+主机+端口）隔离，
 * 端口一变页面看到的就是另一份数据（通常是空的）。所以一旦漂移必须在界面上说清楚，
 * 否则用户会以为「数据丢了」。
 */
const portShifted = computed(() => api.port !== DEFAULT_API_PORT)

async function resolveApiPort() {
  try {
    const resp = await fetch('./.server-port', { cache: 'no-store' })
    if (!resp.ok) return
    const text = (await resp.text()).trim()
    if (/^\d+$/.test(text)) api.port = Number(text)
  } catch {}
}

function apiUrl(pathname) {
  return `http://localhost:${api.port}${pathname}`
}

// v2 新增的持久化键（不动 v1 既有的四个键）
const LS_BRANCH_INDEX = 'todo_branch_index'
const LS_BRANCH_LINKS = 'todo_branch_links'
const LS_BRANCH_TRIAGE = 'todo_branch_triage'
const LS_MEEGLE_CONFIG = 'todo_meegle_config'
const LS_INDEX_CONFIG = 'todo_index_config'
// 卡片区的浏览状态（折叠 / 分组开合）。刻意不导出：这是本机的浏览偏好，不是需求数据
const LS_COLLAPSED = 'todo_collapsed_items'
const LS_EXPANDED_RELEASED = 'todo_expanded_released'
const LS_SECTION_EXPANDED = 'todo_section_expanded'
const LS_DAILY_BRANCH_CHECK = 'todo_daily_branch_check'
const LS_UPDATE_NOTICE = 'todo_update_notice'
/** 索引 TTL：分支一直在长，实测同一条分支两天内需求覆盖就会变，不能无限期复用 */
const INDEX_TTL_MS = 10 * 60 * 1000

createApp({
  setup() {
    // ===== State =====
    const state = reactive({
      projectNames: [],
      items: [],
      launchBranch: '',
      branchesCache: {},
      searchQuery: '',
      pmExpanded: false,
      editProjectIdx: -1,
      editProjectName: '',
      editProjectMr: '',
      editProjectPath: '',
      newProjectName: '',
      newProjectMr: '',
      newProjectPath: '',
      addingItems: [],
      addingCounter: 0,
      editingIds: {},
      selectedIds: [],
      batchBranchDialog: { visible: false, branch: '', projects: [] },
      dailyBranchCheck: {
        date: getTodayStr(), branch: getDailyBranchName(), started: false, active: false,
        checking: false, stopAt: 0, lastCheckedAt: '', fallbackLaunchBranch: '', projects: {}
      },
      pageGuide: { active: false, step: 0, rect: { left: 0, top: 0, width: 0, height: 0 } },
      toastMsg: '',
      toastShow: false,
      showReminder: false,
      branchProgress: { visible: false, done: 0, total: 0 },
      confirmDialog: { item: null },
      launchDialog: { item: null, label: '', projects: [] },
      noteDialog: { visible: false, label: '', project: '', branch: '', notes: '', readonly: false, target: null },
      branchModal: { visible: false, project: '', branches: [], search: '', targetInput: null, releasedSet: new Set() },
      allBranchesModal: { visible: false, projects: [], search: '', loading: false, releasedSet: new Set() },
      ctxMenu: { visible: false, x: 0, y: 0, item: null, dataItem: null, projIndex: -1, field: '' },
      projDropdown: { visible: false, x: 0, y: 0, w: 0, filtered: [], target: null, field: '' },
      sectionExpanded: { pending: true, releasing: false, released: false },

      // ↓↓↓ v2 新增：卡片区的浏览状态（折叠 / 排序）↓↓↓
      // 折叠两个集合各存「例外」：待发版/发版中记「手动折叠的」，已发版记「手动展开的」，
      // 这样新出现的已发版需求不用逐条初始化就是折叠的。
      collapsedItems: new Set(),
      expandedReleased: new Set(),
      sortMode: false,          // 排序模式：只有待发版用，进去才出现拖拽手柄

      // ↓↓↓ v2 新增：分支索引 / 人工关联记忆 / 未登记分支处置 ↓↓↓
      // branchIndex[项目名] = { base, branches:{ 分支名:{ids,commits,lastDate,merged,skipped} }, unregistered:[分支名], timestamp }
      branchIndex: {},
      indexBusy: false,
      indexProgress: { visible: false, done: 0, total: 0 },
      branchLinks: {}, // { '项目\u0000分支': [需求ID] }
      branchTriage: {}, // { '项目\u0000分支': { action:'exempt'|'ignored', at } }
      // 未登记分支面板默认收起：它是「需要你确认的例外」，不是每天都要看的主线内容；
      // 折叠时标题上仍会显示条数，不会漏。
      unregExpanded: false,
      unregKeyword: '',

      // ↓↓↓ v2 新增：飞书项目同步 ↓↓↓
      meegleStatus: { authenticated: null, host: '', error: '' },
      meegleConfig: {
        projectKey: '', simpleName: '', spaceName: '',
        typeApiNames: [],
        mqlTemplate: 'SELECT `work_item_id`,`name`,`work_item_status` FROM `{space}`.`{type}`{statusFilter}',
        maxPerType: 200,
        // 已完成的需求不该出现在发版清单里。实测 your_space 的 story 表 805 条中
        // 已结束 335 + 已上线 412，真正还在流程中的只有 58 条 —— 不排除的话，
        // 拉回来的绝大部分是废数据，还会把 maxPerType 的额度占满。
        excludeStatuses: ['已结束', '已上线'],
      },
      syncSettings: { visible: false, loading: false, error: '', spaces: [], types: [] },
      // 版本徽标：点它就是「检查并更新」
      appVersion: { commit: '', date: '', subject: '', branch: '', remote: '', dirty: false, pid: 0, hasUpdate: false, remoteLatest: null, restartRequired: false, restartCommit: '', restartPreviousPid: 0 },
      updateBusy: false,
      // 备份到项目 backup/ 目录：列表、恢复与目录路径都由引擎给
      backupDialog: { visible: false, loading: false, error: '', dir: '', files: [], pendingRestore: '', pendingDelete: '' },
      triagedDialog: { visible: false, project: '', entries: [] },
      syncDialog: { visible: false, loading: false, error: '', perType: [], errors: [], keyword: '', onlyUnregistered: false },
      syncRaw: [],
      syncSelection: {},
      // 状态分组里被手动收起的那些（默认全部展开：要勾选就得先看得见）
      syncCollapsed: {},
      // 分支索引只保留自己创建的分支：同事的分支混进未登记列表与匹配结果纯是噪声
      indexConfig: { onlyMine: true }
    })

    const guideSteps = [
      { title: '顶部工具条', text: '在这里新增或同步需求、搜索清单、备份数据、获取分支和刷新分支索引。右上角版本号用于检查更新。', selector: '.header-actions' },
      { title: '项目管理', text: '展开后维护项目名称、MR 地址和本地路径。MR 与 NB 在这里打开；公共上线分支也在此保存。', selector: '.project-mgr' },
      { title: '未登记分支', text: '这里列出有提交但查不到需求登记的分支。发版前检查它，确认哪些要补登记、无需需求或忽略。', selector: '.unreg-panel' },
      { title: '需求卡片与批量流转', text: '左侧勾选后可批量设为待发版或批量开始发版。点卡片展开分支与备注，点分支名可复制并打开新建 MR。', selector: '.section[data-section="pending"] .req-card', fallback: '.section[data-section="pending"] .section-header' },
      { title: '发版中与今日上线分支', text: '这里按项目展示当天分支是否已建立及实际 MR 源分支。可批量打开 NB、立即检测，再打开 MR；全部发版表示全部标记完成。', selector: '.daily-branch-board', fallback: '.section[data-section="releasing"] .section-header' },
      { title: '已发版', text: '完成的需求保留在这里并记录时间，默认收起。需要修改或重新发版时，先恢复待发版。', selector: '.section[data-section="released"] .section-header' },
    ]
    const currentGuideStep = computed(() => guideSteps[state.pageGuide.step] || guideSteps[0])
    const guideSpotlightStyle = computed(() => {
      const r = state.pageGuide.rect
      return { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }
    })
    const guideTooltipStyle = computed(() => {
      const r = state.pageGuide.rect
      const width = Math.min(370, window.innerWidth - 24)
      const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12))
      let top = r.top + r.height + 14
      if (top + 220 > window.innerHeight) top = Math.max(12, r.top - 220 - 14)
      return { left: left + 'px', top: top + 'px', width: width + 'px' }
    })

    // ===== Sections (computed) =====
    function filterItems(arr) {
      const q = state.searchQuery
      if (!q) return arr
      return arr.filter(i => {
        if (i.name.toLowerCase().includes(q)) return true
        if (i.link && i.link.toLowerCase().includes(q)) return true
        if (i.projects && i.projects.some(p => p.branch && p.branch.toLowerCase().includes(q))) return true
        if (i.syncBranches && i.syncBranches.some(sb => sb.branch && sb.branch.toLowerCase().includes(q))) return true
        return false
      })
    }

    const sections = computed(() => {
      const pending = filterItems(state.items.filter(i => i.status === 'pending' || i.status === 'new'))
      const releasing = filterItems(state.items.filter(i => i.status === 'releasing'))
      const released = filterItems(state.items.filter(i => i.status === 'released'))
      return [
        { key: 'pending', title: '待发版', items: pending, expanded: state.sectionExpanded.pending, empty: '暂无待发版需求' },
        { key: 'releasing', title: '发版中', items: releasing, expanded: state.sectionExpanded.releasing, empty: '暂无发版中需求' },
        { key: 'released', title: '已发版', items: released, expanded: state.sectionExpanded.released, empty: '暂无已发版需求' }
      ]
    })

    // 一旦有需求进入发版中，默认展开一次。
    // 必须放在 watch 里：写在 sections 内部等于在 computed 里改自己的依赖，
    // 用户点折叠后重算又被置回 true，「发版中」就永远合不上。
    watch(
      () => state.items.filter(i => i.status === 'releasing').length,
      n => { if (n > 0) state.sectionExpanded.releasing = true },
    )

    const batchSelection = computed(() => {
      const selected = state.items.filter(i => state.selectedIds.includes(i.id) && (i.status === 'new' || i.status === 'pending'))
      return {
        count: selected.length,
        newCount: selected.filter(i => i.status === 'new').length,
        pendingCount: selected.filter(i => i.status === 'pending').length,
      }
    })

    const releasingProjects = computed(() => {
      const names = new Set()
      state.items.filter(i => i.status === 'releasing').forEach(item => {
        if (item.projects) item.projects.forEach(p => { if (p.name) names.add(p.name) })
        if (item.syncBranches) item.syncBranches.forEach(sb => { if (sb.project) names.add(sb.project) })
      })
      const daily = state.dailyBranchCheck.date === getTodayStr() ? state.dailyBranchCheck : null
      return [...names].map(name => {
        const info = getProjectInfo(name)
        const hasMr = !!info?.mr
        const srcBranch = getProjectLaunchBranch(name)
        const check = daily?.projects?.[name]
        return {
          name, srcBranch,
          url: hasMr ? buildMrUrl(info.mr, srcBranch, 'master') : null,
          nbUrl: hasMr ? buildBranchUrl(info.mr, 'master') : null,
          checkStatus: !daily?.started ? 'unchecked' : (check?.status || 'waiting'),
          checkError: check?.error || '',
        }
      })
    })

    const dailyExistsCount = computed(() => releasingProjects.value.filter(p => p.checkStatus === 'exists').length)

    const filteredBranchList = computed(() => {
      const s = state.branchModal.search.toLowerCase()
      return s ? state.branchModal.branches.filter(b => b.branch.toLowerCase().includes(s)) : state.branchModal.branches
    })

    // ===== Helpers =====
    function escHtml(str) {
      if (!str) return ''
      const div = document.createElement('div')
      div.textContent = str
      return div.innerHTML
    }

    function truncateBranch(name, maxLen = 40) {
      if (!name || name.length <= maxLen) return name
      return name.substring(0, maxLen) + '...'
    }

    function getProjectInfo(name) { return state.projectNames.find(p => p.name === name) }

    function getColorIdx(name) {
      const idx = state.projectNames.findIndex(p => p.name === name)
      return idx >= 0 ? idx % 30 : 0
    }

    function buildMrUrl(mrBase, branchName, targetBranch) {
      if (!mrBase) return ''
      const target = targetBranch || state.launchBranch || 'master_launched'
      let url = mrBase.replace(/\/+$/, '')
      if (url.includes('/merge_requests/new')) url = url.replace(/\?.*$/, '')
      else if (url.includes('/merge_requests')) url = url.replace(/\/merge_requests.*$/, '/merge_requests/new')
      else url += '/-/merge_requests/new'
      return url + '?merge_request[source_branch]=' + encodeURIComponent(branchName) + '&merge_request[target_branch]=' + encodeURIComponent(target)
    }

    function getDailyBranchName() {
      const now = new Date()
      const mm = String(now.getMonth() + 1).padStart(2, '0')
      const dd = String(now.getDate()).padStart(2, '0')
      return 'master_' + mm + dd
    }

    function buildBranchUrl(mrBase, refBranch) {
      if (!mrBase) return ''
      const ref = refBranch || 'master'
      const branchName = getDailyBranchName()
      let url = mrBase.replace(/\/+$/, '')
      if (url.includes('/merge_requests')) url = url.replace(/\/merge_requests.*$/, '/branches/new')
      else url += '/-/branches/new'
      return url + '?ref=' + encodeURIComponent(ref) + '&branch_name=' + encodeURIComponent(branchName)
    }

    function formatReleaseTime(date) {
      const d = date || new Date()
      const p = v => String(v).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }

    function findItemTargetBranch(projectName) {
      for (const item of state.items) {
        if (item.targetBranches && item.targetBranches[projectName]) return item.targetBranches[projectName]
      }
      return null
    }

    function getProjectLaunchBranch(projectName, item) {
      const itemTarget = (item?.targetBranches && item.targetBranches[projectName]) || findItemTargetBranch(projectName)
      const daily = state.dailyBranchCheck
      // 批量检测启动后，只有当前项目真实存在当日分支才切换到它；
      // 其他项目不能被同名全局值带着走，否则前端也会错误使用 master_MMDD。
      if (daily.date === getTodayStr() && daily.started) {
        if (daily.projects[projectName]?.status === 'exists') return daily.branch
        const fixedGlobal = /^master_\d{4}$/.test(daily.fallbackLaunchBranch || '') ? '' : daily.fallbackLaunchBranch
        const fixedItemTarget = /^master_\d{4}$/.test(itemTarget || '') ? '' : itemTarget
        return fixedGlobal || fixedItemTarget || 'master_launched'
      }
      return state.launchBranch || itemTarget || 'master_launched'
    }

    function getReleasedTargets() {
      const targets = {}
      state.items.filter(i => i.status === 'releasing').forEach(item => {
        if (item.targetBranches) Object.entries(item.targetBranches).forEach(([k, v]) => { targets[k] = v })
      })
      return targets
    }

    function getReleasedBranchSet() {
      const set = new Set()
      state.items.filter(i => i.status === 'released').forEach(item => {
        if (item.projects) item.projects.forEach(p => { if (p.name && p.branch) set.add(p.name + '\x00' + p.branch.trim()) })
        if (item.syncBranches) item.syncBranches.forEach(sb => { if (sb.project && sb.branch) set.add(sb.project + '\x00' + sb.branch.trim()) })
      })
      return set
    }

    function statusLabel(s) {
      return { new: '新建', pending: '待发版', releasing: '发版中', released: '已发版' }[s] || s
    }

    function statusClass(s) {
      return { new: 'status-new', pending: 'status-pending', releasing: 'status-releasing', released: 'status-released' }[s] || ''
    }

    // ===== Persistence =====
    function getFullData() {
      return {
        projectNames: state.projectNames,
        items: state.items,
        branchesCache: state.branchesCache,
        launchBranch: state.launchBranch,
        // v2：人工判断与集成配置要跟着导出走 —— 换机器或清了浏览器缓存后，
        // 不用把「哪些分支标记为无需需求」「上次同步哪个空间」重新做一遍。
        // 分支索引（branchIndex）刻意不导出：它是从 git 重算出来的派生数据，
        // 导出去只会变成一份过期快照，反而让人误以为分支现状就是这样。
        branchTriage: state.branchTriage,
        branchLinks: state.branchLinks,
        meegleConfig: state.meegleConfig,
        indexConfig: state.indexConfig,
      }
    }

    function setFullData(data) {
      if (data && Array.isArray(data.projectNames)) state.projectNames = data.projectNames
      if (data && Array.isArray(data.items)) state.items = data.items
      if (data && data.branchesCache && typeof data.branchesCache === 'object') state.branchesCache = data.branchesCache
      if (data && typeof data.launchBranch === 'string') state.launchBranch = data.launchBranch
      // 旧版导出文件没有这几个字段：缺失时保持现状，不要把已有处置清空
      if (data && data.branchTriage && typeof data.branchTriage === 'object') state.branchTriage = data.branchTriage
      if (data && data.branchLinks && typeof data.branchLinks === 'object') state.branchLinks = data.branchLinks
      if (data && data.meegleConfig && typeof data.meegleConfig === 'object') {
        state.meegleConfig = { ...state.meegleConfig, ...data.meegleConfig }
      }
      if (data && data.indexConfig && typeof data.indexConfig === 'object') {
        state.indexConfig = { ...state.indexConfig, ...data.indexConfig }
      }
      // 导入/加载后立即落盘，否则刷新一次这些新字段就丢了
      saveBranchTriage()
      saveMeegleConfig()
    }

    function saveToLocalStorage() {
      localStorage.setItem('todo_project_names', JSON.stringify(state.projectNames))
      localStorage.setItem('todo_release_data', JSON.stringify(state.items))
    }

    function saveBranchCache() {
      for (const key of Object.keys(state.branchesCache)) {
        if (state.branchesCache[key].branches) {
          state.branchesCache[key].branches = state.branchesCache[key].branches.filter(b => b.branch && b.branch !== 'origin' && !b.branch.startsWith('origin/'))
        }
      }
      localStorage.setItem('todo_branch_cache', JSON.stringify(state.branchesCache))
    }

    function saveLaunchBranch() {
      localStorage.setItem('todo_launch_branch', state.launchBranch)
      toast(state.launchBranch ? '上线分支已设为：' + state.launchBranch : '已清除上线分支')
    }

    // ===== Toast =====
    let toastTimer = null
    function toast(msg) {
      state.toastMsg = msg
      state.toastShow = true
      clearTimeout(toastTimer)
      // 时长跟着文案长度走：1.6s 只能读完十几个字，长提示（如排序退出说明）一闪而过等于没提示
      toastTimer = setTimeout(() => { state.toastShow = false }, Math.min(1600 + String(msg).length * 60, 5000))
    }

    // ===== Copy =====
    async function copyText(text) {
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
        toast('\u2713 ' + text)
      } catch {
        const ta = document.createElement('textarea')
        ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px'
        document.body.appendChild(ta); ta.select()
        document.execCommand('copy'); document.body.removeChild(ta)
        toast('\u2713 ' + text)
      }
    }

    // ===== 版本与一键更新 =====
    //
    // 页面就是这个 git 仓库里的静态文件，「在项目目录里 git pull」等于更新应用。
    // 所以同事只需要点页头的版本号：有新版就拉、拉完刷新；引擎代码变了则提示重启服务。

    function saveUpdateNotice() {
      localStorage.setItem(LS_UPDATE_NOTICE, JSON.stringify({
        date: getTodayStr(),
        hasUpdate: !!state.appVersion.hasUpdate,
        remoteLatest: state.appVersion.remoteLatest || null,
        restartRequired: !!state.appVersion.restartRequired,
        restartCommit: state.appVersion.restartCommit || '',
        restartPreviousPid: state.appVersion.restartPreviousPid || 0,
      }))
    }

    function loadUpdateNotice() {
      try {
        const saved = JSON.parse(localStorage.getItem(LS_UPDATE_NOTICE))
        if (!saved) return
        // 重启提示跨日期保留；绿色更新提示只复用当天的检查结果，隔天仍重新查询。
        if (saved.restartRequired) {
          state.appVersion.restartRequired = true
          state.appVersion.restartCommit = saved.restartCommit || ''
          state.appVersion.restartPreviousPid = saved.restartPreviousPid || 0
        }
        if (saved.date === getTodayStr()) {
          state.appVersion.hasUpdate = !!saved.hasUpdate
          state.appVersion.remoteLatest = saved.remoteLatest || null
        }
      } catch {}
    }

    async function loadAppVersion() {
      try {
        const res = await fetch(apiUrl('/api/version'))
        const data = await res.json()
        if (data.code) return
        const restartPreviousPid = state.appVersion.restartPreviousPid
        state.appVersion = { ...state.appVersion, ...data, checkedAt: Date.now() }
        // git pull 后旧进程也能读到新提交，只有 PID 变化才能证明引擎真的重启过。
        if (state.appVersion.restartRequired && restartPreviousPid && data.pid && data.pid !== restartPreviousPid) {
          state.appVersion.restartRequired = false
          state.appVersion.restartCommit = ''
          state.appVersion.restartPreviousPid = 0
          state.appVersion.hasUpdate = false
          saveUpdateNotice()
        }
      } catch {}
    }

    async function checkUpdate(checkOnly = false) {
      if (state.updateBusy) return
      state.updateBusy = true
      try {
        const res = await fetch(apiUrl('/api/update/check'))
        const d = await res.json()
        if (d.code) throw new Error(d.error || d.code)
        if (d.local) state.appVersion = { ...state.appVersion, ...d.local }
        if (!d.configured) { if (!checkOnly) toast(d.hint || '还没有配置远端仓库，无法检查更新'); return }
        if (d.reachable === false) { if (!checkOnly) toast(d.error || '拉取失败'); return }
        state.appVersion.hasUpdate = !!d.hasUpdate
        state.appVersion.remoteLatest = d.remoteLatest || null
        saveUpdateNotice()
        if (!d.hasUpdate) {
          if (!checkOnly) toast(`已是最新版本 ${d.local.commit}${d.dirty ? '（本地有未提交改动）' : ''}`)
          return
        }
        // 自动检查只提示，不拉代码；用户点击绿色徽标才执行更新。
        if (checkOnly) {
          toast(`发现新版本 ${d.remoteLatest?.commit || ''}，点击右上角绿色「有更新」即可更新`)
          return
        }
        const r2 = await fetch(apiUrl('/api/update/apply'), { method: 'POST' })
        const d2 = await r2.json()
        if (d2.code) throw new Error(d2.error || d2.code)
        state.appVersion = { ...state.appVersion, commit: d2.to, subject: d2.subject, hasUpdate: false }
        if (d2.engineChanged) {
          state.appVersion.restartRequired = true
          state.appVersion.restartCommit = d2.to
          state.appVersion.restartPreviousPid = state.appVersion.pid || 0
          saveUpdateNotice()
          toast(`已更新到 ${d2.to}，包含引擎改动：请重启 start-server.bat；重启前右上角会一直提示`)
          return
        }
        state.appVersion.restartRequired = false
        state.appVersion.restartCommit = ''
        state.appVersion.restartPreviousPid = 0
        saveUpdateNotice()
        toast(`已更新到 ${d2.to}，正在刷新页面...`)
        setTimeout(() => location.reload(), 1200)
      } catch (e) {
        if (!checkOnly) toast(`检查更新失败：${e.message}`)
      } finally {
        state.updateBusy = false
      }
    }

    function autoCheckUpdate() {
      try {
        const saved = JSON.parse(localStorage.getItem(LS_UPDATE_NOTICE))
        if (saved?.date === getTodayStr()) return
      } catch {}
      checkUpdate(true)
    }

    // ===== 备份到项目目录（引擎写盘）=====
    //
    // 「导出」走浏览器下载，得自己挑目录、事后也想不起来存哪了；
    // 备份固定写到项目下的 backup/，路径由引擎给出，换机器拷走整个文件夹即可。

    /** 立刻备份一份到项目目录，返回引擎回执（含绝对路径）。quiet 用于覆盖性操作前的自动留底：不弹 toast 打扰 */
    async function backupToProject(quiet) {
      try {
        const res = await fetch(apiUrl('/api/backup'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: getFullData() }),
        })
        const data = await res.json()
        if (data.code) throw new Error(data.error || data.code)
        state.backupDialog.dir = data.dir
        if (!quiet) toast(`已备份 ${data.items} 条到 ${data.name}`)
        return data
      } catch (e) {
        if (!quiet) toast(`备份失败：${e.message}（引擎没起或端口不对？）`)
        return null
      }
    }

    async function loadBackups() {
      state.backupDialog.loading = true
      state.backupDialog.error = ''
      try {
        const res = await fetch(apiUrl('/api/backup/list'))
        const data = await res.json()
        if (data.code) throw new Error(data.error || data.code)
        state.backupDialog.dir = data.dir
        state.backupDialog.files = data.files || []
      } catch (e) {
        state.backupDialog.error = `读取备份目录失败：${e.message}`
      }
      state.backupDialog.loading = false
    }

    function openBackupDialog() {
      state.backupDialog.visible = true
      state.backupDialog.pendingRestore = ''
      state.backupDialog.pendingDelete = ''
      loadBackups()
    }

    /** 删除备份文件：和恢复一样是不可逆动作，所以也点两次确认 */
    async function deleteBackup(file) {
      if (state.backupDialog.pendingDelete !== file.name) {
        state.backupDialog.pendingDelete = file.name
        toast(`再点一次「确认删除」会把 ${file.name} 从磁盘删掉`)
        return
      }
      state.backupDialog.pendingDelete = ''
      try {
        const res = await fetch(apiUrl('/api/backup/delete?name=' + encodeURIComponent(file.name)), { method: 'POST' })
        const data = await res.json()
        if (data.code) throw new Error(data.error || data.code)
        toast(`已删除 ${data.name}`)
        await loadBackups()
      } catch (e) {
        toast(`删除失败：${e.message}`)
      }
    }

    /** 恢复是一次覆盖性写入，所以要点两次：第一次只是把该行变成「确认恢复」 */
    async function restoreBackup(file) {
      if (state.backupDialog.pendingRestore !== file.name) {
        state.backupDialog.pendingRestore = file.name
        toast(`再点一次「确认恢复」会用 ${file.name} 覆盖当前数据`)
        return
      }
      state.backupDialog.pendingRestore = ''
      // 覆盖前先静默留底：恢复错了（选错那份）能靠这份自动备份回到恢复前
      const safety = await backupToProject(true)
      try {
        const res = await fetch(apiUrl('/api/backup/read?name=' + encodeURIComponent(file.name)))
        const data = await res.json()
        if (data.code) throw new Error(data.error || data.code)
        setFullData(data)
        saveToLocalStorage()
        localStorage.setItem('todo_launch_branch', state.launchBranch || '')
        saveBranchCache()
        state.editingIds = {}
        state.addingItems = []
        state.addingCounter = 0
        state.editProjectIdx = -1
        state.backupDialog.visible = false
        toast(`已从 ${file.name} 恢复 ${state.items.length} 条需求` + (safety ? '（恢复前数据已自动备份）' : ''))
      } catch (e) {
        toast(`恢复失败：${e.message}`)
      }
    }

    async function revealBackupDir() {
      try {
        const res = await fetch(apiUrl('/api/backup/reveal'), { method: 'POST' })
        const data = await res.json()
        if (data.code) throw new Error(data.error || data.code)
        toast('已打开备份目录')
      } catch (e) {
        toast(`打开备份目录失败：${e.message}`)
      }
    }

    // ===== Export/Import =====
    function exportToFile() {
      const now = new Date()
      const ts = [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0'),
        String(now.getHours()).padStart(2,'0'), String(now.getMinutes()).padStart(2,'0'), String(now.getSeconds()).padStart(2,'0')].join('')
      const filename = `todoList-发版需求-${ts}.json`
      const blob = new Blob([JSON.stringify(getFullData(), null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      a.click()
      URL.revokeObjectURL(a.href)
      toast(`已导出 ${filename}`)
    }

    function importFromFile(e) {
      const file = e.target.files[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = async () => {
        try {
          const data = JSON.parse(reader.result)
          // 覆盖前先静默留底：导入没有二次确认，选错文件时全靠这份自动备份找回（引擎没起就算了，别挡导入）
          const safety = await backupToProject(true)
          setFullData(data)
          saveToLocalStorage()
          saveLaunchBranch()
          saveBranchCache()
          state.editingIds = {}
          state.addingItems = []
          state.addingCounter = 0
          state.editProjectIdx = -1
          toast('已导入 ' + state.items.length + ' 条需求' + (safety ? '（导入前数据已自动备份）' : ''))
        } catch (err) { toast('导入失败：JSON 格式错误') }
      }
      reader.readAsText(file)
      e.target.value = ''
    }

    // ===== Project Manager =====
    function addProject() {
      const name = state.newProjectName.trim()
      if (!name) return
      if (state.projectNames.some(p => p.name === name)) { state.newProjectName = ''; toast('项目已存在'); return }
      state.projectNames.push({ name, mr: state.newProjectMr.trim(), localPath: state.newProjectPath.trim() })
      state.newProjectName = ''; state.newProjectMr = ''; state.newProjectPath = ''
      saveToLocalStorage(); toast('已添加 ' + name)
    }

    function removeProject(i) {
      const name = state.projectNames[i].name
      state.projectNames.splice(i, 1)
      if (state.editProjectIdx === i) state.editProjectIdx = -1
      else if (state.editProjectIdx > i) state.editProjectIdx--
      // 项目删了，它的分支索引不能留着：否则已删项目的分支还会继续参与
      // 需求匹配与「未登记分支」聚合，界面上会冒出已经不存在的项目
      if (state.branchIndex[name]) { delete state.branchIndex[name]; saveBranchIndex() }
      saveToLocalStorage(); toast('已移除 ' + name)
    }

    function saveProjectEdit() {
      const newName = state.editProjectName.trim()
      if (!newName) { toast('请输入项目名称'); return }
      const oldName = state.projectNames[state.editProjectIdx].name
      if (newName !== oldName && state.projectNames.some(p => p.name === newName)) { toast('项目名称已存在'); return }
      state.projectNames[state.editProjectIdx] = { name: newName, mr: state.editProjectMr.trim(), localPath: state.editProjectPath.trim() }
      state.editProjectIdx = -1
      saveToLocalStorage(); toast('已更新 ' + newName)
    }

    // Watch editProjectIdx to load edit fields
    watch(() => state.editProjectIdx, (i) => {
      if (i >= 0 && i < state.projectNames.length) {
        const p = state.projectNames[i]
        state.editProjectName = p.name
        state.editProjectMr = p.mr || ''
        state.editProjectPath = p.localPath || ''
      }
    })

    // ===== Item Actions =====
    function startAdding() {
      state.addingItems.push({
        id: '__add_' + state.addingCounter++,
        name: '', link: '', status: 'new',
        _editProjects: [{ name: '', branch: '', notes: '' }],
        _editSyncBranches: [{ project: '', branch: '', notes: '' }]
      })
      // expand pending
    }

    function saveAdding(ai) {
      if (!ai.name.trim()) { toast('请输入需求名称'); return }
      const newItem = {
        id: newId(), name: ai.name, link: ai.link, status: 'new',
        projects: ai._editProjects.filter(p => p.name).map(p => ({ name: p.name, branch: p.branch, notes: p.notes || '' })),
        syncBranches: ai._editSyncBranches.filter(s => s.branch).map(s => ({ project: s.project, branch: s.branch, notes: s.notes || '' })),
        _justAdded: true
      }
      state.items.unshift(newItem)
      state.addingItems = state.addingItems.filter(a => a.id !== ai.id)
      saveToLocalStorage()
      toast('已添加：' + newItem.name)
      nextTick(() => { setTimeout(() => { newItem._justAdded = false }, 350) })
    }

    function startEdit(item) {
      if (item.status === 'releasing' || item.status === 'released') {
        toast('发版中/已发版不支持编辑'); return
      }
      item._editName = item.name
      item._editLink = item.link || ''
      item._editProjects = (item.projects && item.projects.length ? item.projects.map(p => ({...p})) : [{ name: '', branch: '', notes: '' }])
      item._editSyncBranches = (item.syncBranches && item.syncBranches.length ? item.syncBranches.map(s => ({...s})) : [{ project: '', branch: '', notes: '' }])
      state.editingIds[item.id] = true
    }

    function saveEdit(item) {
      if (!item._editName.trim()) { toast('请输入需求名称'); return }
      item.name = item._editName
      item.link = item._editLink
      item.projects = item._editProjects.filter(p => p.name).map(p => ({ name: p.name, branch: p.branch, notes: p.notes || '' }))
      item.syncBranches = item._editSyncBranches.filter(s => s.branch).map(s => ({ project: s.project, branch: s.branch, notes: s.notes || '' }))
      delete state.editingIds[item.id]
      saveToLocalStorage()
      toast('已保存')
    }

    function cancelEdit(item) {
      if (item) delete state.editingIds[item.id]
    }

    function toggleItemSelected(id) {
      state.selectedIds = state.selectedIds.includes(id)
        ? state.selectedIds.filter(selectedId => selectedId !== id)
        : [...state.selectedIds, id]
    }

    function clearBatchSelection() { state.selectedIds = [] }

    function batchSetPending() {
      const selected = state.items.filter(i => state.selectedIds.includes(i.id) && i.status === 'new')
      if (!selected.length) { toast('请先勾选新建需求'); return }
      selected.forEach(item => { item.status = 'pending'; delete item.releaseTime })
      state.selectedIds = []
      saveToLocalStorage()
      toast('已批量设为待发版（' + selected.length + ' 条）')
    }

    function completeBatchRelease(ids, targetBranches) {
      const selected = state.items.filter(i => ids.includes(i.id) && i.status === 'pending')
      if (!selected.length) { toast('所选需求已不在待发版状态'); return }
      const releaseTime = formatReleaseTime()
      selected.forEach(item => {
        const names = new Set()
        if (item.projects) item.projects.forEach(p => { if (p.name) names.add(p.name) })
        if (item.syncBranches) item.syncBranches.forEach(sb => { if (sb.project) names.add(sb.project) })
        const ownTargets = {}
        names.forEach(name => { if (targetBranches[name]) ownTargets[name] = targetBranches[name] })
        item.status = 'releasing'
        item.releaseTime = releaseTime
        item.targetBranches = ownTargets
      })
      state.selectedIds = []
      saveToLocalStorage()
      toast('已批量开始发版（' + selected.length + ' 条）')
    }

    function batchReleaseSelected() {
      const selected = state.items.filter(i => state.selectedIds.includes(i.id) && i.status === 'pending')
      if (!selected.length) { toast('请先勾选待发版需求'); return }
      const ids = selected.map(i => i.id)
      const targets = getReleasedTargets()
      if (!state.launchBranch) {
        const seen = new Set()
        selected.forEach(item => {
          if (item.projects) item.projects.forEach(p => { if (p.name && !targets[p.name]) seen.add(p.name) })
          if (item.syncBranches) item.syncBranches.forEach(sb => { if (sb.project && !targets[sb.project]) seen.add(sb.project) })
        })
        const projects = [...seen].map(name => ({ name, target: '' }))
        if (projects.length) {
          state.launchDialog = { item: { _isBatch: true, ids }, label: '批量发版：' + selected.length + ' 条需求', projects }
          return
        }
      }
      completeBatchRelease(ids, targets)
    }

    function changeStatus(item, newStatus) {
      if (newStatus === 'releasing') {
        item.releaseTime = formatReleaseTime()
      } else if (newStatus === 'released') {
        item.releaseTime = formatReleaseTime()
      } else if (newStatus === 'pending') {
        delete item.releaseTime
      }
      item.status = newStatus
      state.selectedIds = state.selectedIds.filter(id => id !== item.id)
      saveToLocalStorage()
      toast('已' + statusLabel(newStatus) + '：' + item.name)
    }

    function releaseItem(item) {
      if (!state.launchBranch) {
        // Check if we need to show launch dialog
        const existingTargets = getReleasedTargets()
        const seen = new Set()
        if (item.projects) item.projects.forEach(p => { if (p.name && !seen.has(p.name) && !existingTargets[p.name]) seen.add(p.name) })
        if (item.syncBranches) item.syncBranches.forEach(sb => { if (sb.project && !seen.has(sb.project) && !existingTargets[sb.project]) seen.add(sb.project) })
        const projects = [...seen].map(name => ({ name, target: '' }))
        if (projects.length > 0) {
          state.launchDialog = { item: item, label: '需求：' + item.name, projects }
          return
        }
      }
      const targets = getReleasedTargets()
      item.targetBranches = targets
      changeStatus(item, 'releasing')
    }

    function confirmLaunch() {
      const targetBranches = { ...getReleasedTargets() }
      let allFilled = true
      state.launchDialog.projects.forEach(p => {
        if (!p.target.trim()) allFilled = false
        else targetBranches[p.name] = p.target.trim()
      })
      if (!allFilled) { toast('请填写所有项目的目标分支'); return }
      const item = state.launchDialog.item
      state.launchDialog.item = null
      if (item._isBatch) {
        completeBatchRelease(item.ids || [], targetBranches)
      } else if (item) {
        item.targetBranches = targetBranches
        changeStatus(item, 'releasing')
      }
    }

    function releaseAllToDone() {
      const releasing = state.items.filter(i => i.status === 'releasing')
      if (!releasing.length) { toast('没有发版中的需求'); return }
      const releaseTime = formatReleaseTime()
      releasing.forEach(i => { i.status = 'released'; i.releaseTime = releaseTime })
      saveToLocalStorage()
      toast('已全部完成发版（' + releasing.length + ' 条）')
    }

    let dailyBranchTimer = null
    let dailyCheckInFlight = false
    let dailyCheckRunId = 0
    let dailyCheckAbort = null

    function saveDailyBranchCheck() {
      localStorage.setItem(LS_DAILY_BRANCH_CHECK, JSON.stringify(state.dailyBranchCheck))
    }

    function ensureCurrentDailyBranchCheck() {
      if (state.dailyBranchCheck.date === getTodayStr() && state.dailyBranchCheck.branch === getDailyBranchName()) return
      state.dailyBranchCheck = {
        date: getTodayStr(), branch: getDailyBranchName(), started: false, active: false,
        checking: false, stopAt: 0, lastCheckedAt: '', fallbackLaunchBranch: '', projects: {}
      }
      clearInterval(dailyBranchTimer)
      dailyBranchTimer = null
      dailyCheckRunId++
      if (dailyCheckAbort) dailyCheckAbort.abort()
      dailyCheckAbort = null
      dailyCheckInFlight = false
      saveDailyBranchCheck()
    }

    function loadDailyBranchCheck() {
      try {
        const saved = JSON.parse(localStorage.getItem(LS_DAILY_BRANCH_CHECK))
        if (saved && saved.date === getTodayStr() && saved.branch === getDailyBranchName()) {
          state.dailyBranchCheck = { ...state.dailyBranchCheck, ...saved, checking: false }
          state.dailyBranchCheck.active = !!saved.active && saved.stopAt > Date.now()
          Object.values(state.dailyBranchCheck.projects || {}).forEach(p => {
            if (p.status === 'checking') p.status = 'waiting'
          })
        }
      } catch {}
      ensureCurrentDailyBranchCheck()
    }

    function dailyStatusLabel(status) {
      return {
        unchecked: '未检测', waiting: '等待检测', checking: '检测中',
        exists: '已建立', missing: '未建立', error: '检测失败'
      }[status] || '未检测'
    }

    function openBatchBranchDialog() {
      ensureCurrentDailyBranchCheck()
      const projects = releasingProjects.value.filter(p => p.nbUrl)
      if (!projects.length) { toast('发版项目未配置可用的 MR 地址'); return }
      state.batchBranchDialog = {
        visible: true,
        branch: getDailyBranchName(),
        projects: projects.map(p => ({ name: p.name, nbUrl: p.nbUrl }))
      }
    }

    async function openAllDailyBranchPages() {
      const projects = [...state.batchBranchDialog.projects]
      const blocked = []
      // 先走普通浏览器入口；被拦截的交给本机引擎补开，不能让一次批量操作只打开第一个项目。
      projects.forEach(p => { if (!window.open(p.nbUrl, '_blank')) blocked.push(p) })
      state.batchBranchDialog.visible = false
      startDailyBranchCheck()
      let opened = projects.length - blocked.length
      let failed = 0
      await Promise.all(blocked.map(async p => {
        try {
          const res = await fetch(apiUrl('/api/system/open-external'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: p.nbUrl })
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.code) throw new Error(data.error || '系统浏览器打开失败')
          opened++
        } catch { failed++ }
      }))
      if (failed) toast('已打开 ' + opened + ' 个页面，' + failed + ' 个补开失败，可在看板单独打开')
      else toast(blocked.length ? '已打开全部 ' + projects.length + ' 个页面（系统浏览器补开 ' + blocked.length + ' 个）' : '已打开 ' + projects.length + ' 个新建分支页面')
    }

    function stopDailyBranchCheck() {
      state.dailyBranchCheck.active = false
      state.dailyBranchCheck.checking = false
      // 停止不仅取消下一轮：当前请求也立即失效，旧序列不能再写看板或覆盖公共上线分支。
      dailyCheckRunId++
      if (dailyCheckAbort) dailyCheckAbort.abort()
      dailyCheckAbort = null
      dailyCheckInFlight = false
      clearInterval(dailyBranchTimer)
      dailyBranchTimer = null
      saveDailyBranchCheck()
    }

    function scheduleDailyBranchCheck() {
      clearInterval(dailyBranchTimer)
      dailyBranchTimer = setInterval(() => {
        if (!state.dailyBranchCheck.active || Date.now() >= state.dailyBranchCheck.stopAt) {
          stopDailyBranchCheck()
          return
        }
        runDailyBranchCheck()
      }, 10000)
    }

    function startDailyBranchCheck() {
      ensureCurrentDailyBranchCheck()
      const daily = state.dailyBranchCheck
      if (state.launchBranch !== daily.branch) daily.fallbackLaunchBranch = state.launchBranch
      daily.started = true
      daily.active = true
      daily.stopAt = Date.now() + 10 * 60 * 1000
      saveDailyBranchCheck()
      scheduleDailyBranchCheck()
      runDailyBranchCheck()
    }

    async function runDailyBranchCheck() {
      ensureCurrentDailyBranchCheck()
      const daily = state.dailyBranchCheck
      if (dailyCheckInFlight || !daily.started) return
      if (!releasingProjects.value.length) { stopDailyBranchCheck(); return }
      const runId = ++dailyCheckRunId
      const controller = new AbortController()
      dailyCheckAbort = controller
      dailyCheckInFlight = true
      daily.checking = true
      let detected = false
      try {
        // 已建立也必须重查：远端分支可能被删除，跳过旧成功项会把过期状态一直留在看板上。
        const pending = releasingProjects.value
        for (const project of pending) {
          if (runId !== dailyCheckRunId || !daily.active) return
          const info = getProjectInfo(project.name)
          const repo = deriveRepoUrl(info?.mr)
          const previous = daily.projects[project.name] || {}
          if (!repo && !info?.localPath) {
            daily.projects[project.name] = { status: 'error', error: '未配置仓库地址或本地路径', checkedAt: Date.now() }
            continue
          }
          daily.projects[project.name] = { ...previous, status: 'checking', error: '' }
          try {
            const query = '?repo=' + encodeURIComponent(repo)
              + '&path=' + encodeURIComponent(info.localPath || '')
              + '&branch=' + encodeURIComponent(daily.branch)
            const res = await fetch(apiUrl('/api/git/branch-exists') + query, { cache: 'no-store', signal: controller.signal })
            const data = await res.json()
            if (runId !== dailyCheckRunId || !daily.active) return
            if (data.code) throw new Error(data.error || data.code)
            daily.projects[project.name] = {
              status: data.exists ? 'exists' : 'missing', error: '', checkedAt: Date.now()
            }
            if (data.exists) detected = true
          } catch (e) {
            if (runId !== dailyCheckRunId || !daily.active) return
            daily.projects[project.name] = { status: 'error', error: e.message || '检测失败', checkedAt: Date.now() }
          }
          saveDailyBranchCheck()
        }
        if (runId !== dailyCheckRunId || !daily.active) return
        daily.lastCheckedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false })
        // 分支名由当天日期确定，任一仓库真实出现后就能确定公共值；
        // 各项目是否已建立仍由看板独立表达，不能用公共值代替逐项目检测。
        if (detected && state.launchBranch !== daily.branch) {
          state.launchBranch = daily.branch
          saveLaunchBranch()
        }
        if (releasingProjects.value.every(p => p.checkStatus === 'exists') || Date.now() >= daily.stopAt) {
          stopDailyBranchCheck()
        }
      } finally {
        if (runId === dailyCheckRunId) {
          daily.checking = false
          dailyCheckInFlight = false
          dailyCheckAbort = null
          saveDailyBranchCheck()
        }
      }
    }

    function handleDailyBranchFocus() {
      if (state.dailyBranchCheck.started && state.dailyBranchCheck.active) runDailyBranchCheck()
    }

    function showConfirm(item) { state.confirmDialog = { item } }

    function doDelete() {
      if (!state.confirmDialog.item) return
      const item = state.confirmDialog.item
      const name = item.name
      state.items = state.items.filter(i => i !== item)
      state.selectedIds = state.selectedIds.filter(id => id !== item.id)
      state.confirmDialog.item = null
      saveToLocalStorage()
      toast('已删除：' + name)
    }

    // ===== Branch click =====
    function clickBranch(item, proj, field) {
      const name = field === 'project' ? proj.name : proj.name // proj is {name, branch} from template
      // Actually proj here is the project entry directly for 'project' field
      const projectName = proj.name
      const branch = proj.branch
      const statusTarget = item.status === 'new' ? 'test' : item.status === 'pending' ? 'uat' : null
      const target = statusTarget || getProjectLaunchBranch(projectName, item)
      const info = getProjectInfo(projectName)
      copyText(branch)
      if (info && info.mr) {
        setTimeout(() => { window.open(buildMrUrl(info.mr, branch, target), '_blank') }, 250)
      }
    }

    // ===== Note Dialog =====
    function openNoteDialog(item, projIndex, field, editable) {
      const list = field === 'project' ? item.projects : item.syncBranches
      const entry = list && list[projIndex]
      if (!entry) return
      const name = field === 'project' ? (entry.name || '') : (entry.project || '')
      const branch = entry.branch || ''
      const notes = entry.notes || ''
      const label = name ? (name + (branch ? ' / ' + truncateBranch(branch, 30) : '')) : (branch || '未知')
      state.noteDialog = {
        visible: true, label, project: name, branch, notes, readonly: !editable,
        target: { item, projIndex, field, isEditMode: false }
      }
      if (editable) nextTick(() => { const ta = document.querySelector('#noteTextareaEl'); if (ta) ta.focus() })
    }

    function openInlineNoteForEdit(ep) {
      const notes = ep.notes || ''
      const projName = ep.name || ep.project || ''
      const branchName = ep.branch || ''
      const label = projName ? (projName + (branchName ? ' / ' + truncateBranch(branchName, 30) : '')) : (branchName || '未知')
      state.noteDialog = {
        visible: true, label, project: projName, branch: branchName, notes, readonly: false,
        target: { editEntry: ep, isEditMode: true }
      }
      nextTick(() => { const ta = document.querySelector('#noteTextareaEl'); if (ta) ta.focus() })
    }

    function closeNote() {
      state.noteDialog.visible = false
    }

    function saveNote() {
      const t = state.noteDialog.target
      if (!t) return
      const notes = state.noteDialog.notes.trim()
      if (t.isEditMode) {
        // Editing an edit-row entry
        if (t.editEntry) t.editEntry.notes = notes
      } else {
        const item = t.item
        const list = t.field === 'project' ? item.projects : item.syncBranches
        if (list && list[t.projIndex]) list[t.projIndex].notes = notes
        saveToLocalStorage()
      }
      closeNote()
      toast(notes ? '备注已保存' : '备注已清除')
    }

    // ===== Context Menu =====
    function showCtxMenu(e, item, projIndex, field) {
      const list = field === 'project' ? item.projects : item.syncBranches
      const entry = list && list[projIndex]
      if (!entry) return
      const hasNotes = !!(entry.notes && entry.notes.trim())
      const mw = 140; const mh = hasNotes ? 70 : 35
      let x = e.clientX, y = e.clientY
      if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8
      if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8
      state.ctxMenu = { visible: true, x: Math.max(8, x), y: Math.max(8, y), item: entry, dataItem: item, projIndex, field }
    }

    function ctxEditNote() {
      const m = state.ctxMenu
      state.ctxMenu.visible = false
      if (m.dataItem && m.projIndex >= 0) openNoteDialog(m.dataItem, m.projIndex, m.field, true)
    }

    function ctxClearNote() {
      const m = state.ctxMenu
      state.ctxMenu.visible = false
      if (m.item) {
        m.item.notes = ''
        saveToLocalStorage()
        toast('备注已清除')
      }
    }

    function closeCtxMenu() { state.ctxMenu.visible = false }

    // ===== Project Dropdown =====
    function showProjDropdown(entry, field, e) {
      const rect = e.target.getBoundingClientRect()
      state.projDropdown = {
        visible: true,
        x: rect.left, y: rect.bottom + 2, w: rect.width,
        filtered: state.projectNames.map(p => ({ name: p.name, selected: p.name === entry[field] })),
        target: entry, field
      }
    }

    function hideProjDropdown() {
      setTimeout(() => { state.projDropdown.visible = false }, 150)
    }

    function filterDropdown(entry, field, val) {
      const q = val.toLowerCase()
      state.projDropdown.filtered = state.projectNames
        .filter(p => p.name.toLowerCase().includes(q))
        .map(p => ({ name: p.name, selected: p.name === entry[field] }))
    }

    function selectProjDropdown(p) {
      if (state.projDropdown.target && state.projDropdown.field) {
        state.projDropdown.target[state.projDropdown.field] = p.name
      }
      state.projDropdown.visible = false
    }

    // ===== Branch Lookup =====
    async function openBranchLookup(ep, ctx) {
      const projectName = (ep.name || ep.project || '').trim()
      if (!projectName) { toast('请先输入项目名'); return }
      const project = state.projectNames.find(p => p.name === projectName)
      if (!project || !project.localPath) { toast('该项目未配置本地路径'); return }

      const cache = state.branchesCache[projectName]
      if (cache && cache.branches && cache.branches.length > 0) {
        const filtered = cache.branches.filter(b => b.branch && b.branch !== 'origin' && !b.branch.startsWith('origin/'))
        state.branchModal = {
          visible: true, project: projectName, branches: filtered, search: '',
          targetInput: { entry: ep, field: 'branch' },
          releasedSet: getReleasedBranchSet()
        }
        return
      }

      try {
        const resp = await fetch(apiUrl('/api/git-user'))
        if (!resp.ok) { toast('请先启动服务器: node server.js'); return }
      } catch { toast('请先启动服务器: node server.js'); return }

      toast('正在获取分支...')

      let gitUser = null
      try {
        const userRes = await fetch(apiUrl('/api/git-user'))
        const userData = await userRes.json()
        gitUser = userData.user
      } catch {}

      let branches = []
      try {
        const url = apiUrl(`/api/branches?path=${encodeURIComponent(project.localPath)}&user=${encodeURIComponent(gitUser || '')}`)
        const res = await fetch(url)
        const data = await res.json()
        if (data.branches) {
          branches = data.branches
          state.branchesCache[projectName] = { branches: data.branches, timestamp: Date.now() }
          saveBranchCache()
        }
      } catch {}

      state.branchModal = {
        visible: true, project: projectName, branches, search: '',
        targetInput: { entry: ep, field: ctx === 'sync' ? 'branch' : 'branch' },
        releasedSet: getReleasedBranchSet()
      }
    }

    function selectBranchFill(branch) {
      const clean = branch.replace(/\s/g, '')
      if (state.branchModal.targetInput) {
        const t = state.branchModal.targetInput
        if (t.entry) t.entry.branch = clean
      }
      state.branchModal.visible = false
      toast('已填充: ' + clean)
    }

    // ===== All Branches Fetch =====
    async function fetchAllBranches() {
      const projectsWithPath = state.projectNames.filter(p => p.localPath)
      if (!projectsWithPath.length) { toast('没有配置本地路径的项目'); return }

      try {
        const resp = await fetch(apiUrl('/api/git-user'))
        if (!resp.ok) throw new Error()
      } catch { toast('请先启动服务器: node server.js'); return }

      let gitUser = null
      try {
        const userRes = await fetch(apiUrl('/api/git-user'))
        const userData = await userRes.json()
        gitUser = userData.user
      } catch {}

      toast('正在获取分支...')
      state.allBranchesModal = { visible: true, projects: [], search: '', loading: true, releasedSet: getReleasedBranchSet() }

      const results = []
      for (const project of projectsWithPath) {
        try {
          const url = apiUrl(`/api/branches?path=${encodeURIComponent(project.localPath)}&user=${encodeURIComponent(gitUser || '')}`)
          const res = await fetch(url)
          const data = await res.json()
          if (data.error) {
            results.push({ name: project.name, branches: [], error: data.error })
          } else if (data.branches && data.branches.length > 0) {
            state.branchesCache[project.name] = { branches: data.branches, timestamp: Date.now() }
            results.push({ name: project.name, branches: data.branches, error: null })
          } else {
            results.push({ name: project.name, branches: [], error: null })
          }
        } catch (e) {
          results.push({ name: project.name, branches: [], error: '获取失败: ' + e.message })
        }
      }
      saveBranchCache()
      state.allBranchesModal = { visible: true, projects: results, search: '', loading: false, releasedSet: getReleasedBranchSet() }
    }

    // ===== Auto Fetch =====
    async function autoFetchBranches() {
      const lastDate = localStorage.getItem('todo_last_branch_fetch_date')
      const today = getTodayStr()
      if (lastDate === today) return

      const projectsWithPath = state.projectNames.filter(p => p.localPath)
      if (!projectsWithPath.length) return

      try {
        const resp = await fetch(apiUrl('/api/git-user'))
        if (!resp.ok) return
      } catch { return }

      let gitUser = null
      try {
        const userRes = await fetch(apiUrl('/api/git-user'))
        const userData = await userRes.json()
        gitUser = userData.user
      } catch {}

      state.branchProgress = { visible: true, done: 0, total: projectsWithPath.length }
      let done = 0
      for (const project of projectsWithPath) {
        try {
          const url = apiUrl(`/api/branches?path=${encodeURIComponent(project.localPath)}&user=${encodeURIComponent(gitUser || '')}`)
          const res = await fetch(url)
          const data = await res.json()
          if (!data.error && data.branches) {
            state.branchesCache[project.name] = { branches: data.branches, timestamp: Date.now() }
          }
        } catch {}
        done++
        state.branchProgress.done = done
      }
      saveBranchCache()
      localStorage.setItem('todo_last_branch_fetch_date', today)
      setTimeout(() => { state.branchProgress.visible = false }, 800)
    }

    // ===== Daily Reminder =====
    function getTodayStr() {
      const d = new Date()
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }

    function checkDailyReminder() {
      const lastDate = localStorage.getItem('todo_last_remind_date')
      if (lastDate !== getTodayStr()) state.showReminder = true
    }

    function dismissReminder() {
      state.showReminder = false
      localStorage.setItem('todo_last_remind_date', getTodayStr())
    }

    /**
     * 提醒里的「导出保存」。
     *
     * 优先写进项目 backup/ 目录：这个入口就是为了「别丢」，而下载文件还要用户自己挑目录；
     * 引擎没起（或备份失败）时退回原来的下载导出，保证这条路径永远能存下一份。
     */
    async function exportAndDismiss() {
      const saved = await backupToProject()
      if (!saved) exportToFile()
      dismissReminder()
    }

    let guideScrollTimer = null
    function updatePageGuideRect() {
      if (!state.pageGuide.active) return
      const step = currentGuideStep.value
      const target = document.querySelector(step.selector) || (step.fallback && document.querySelector(step.fallback))
      if (!target) return
      const r = target.getBoundingClientRect()
      const pad = 6
      const left = Math.max(6, r.left - pad)
      const top = Math.max(6, r.top - pad)
      state.pageGuide.rect = {
        left,
        top,
        width: Math.max(20, Math.min(r.width + pad * 2, window.innerWidth - left - 6)),
        height: Math.max(20, Math.min(r.height + pad * 2, window.innerHeight - top - 6)),
      }
    }

    function positionPageGuide() {
      const step = currentGuideStep.value
      const target = document.querySelector(step.selector) || (step.fallback && document.querySelector(step.fallback))
      if (!target) return
      updatePageGuideRect()
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      clearTimeout(guideScrollTimer)
      guideScrollTimer = setTimeout(updatePageGuideRect, 350)
    }

    function startPageGuide() {
      state.pageGuide.step = 0
      state.pageGuide.active = true
      nextTick(positionPageGuide)
    }

    function closePageGuide() {
      state.pageGuide.active = false
      clearTimeout(guideScrollTimer)
    }

    function nextPageGuide() {
      if (state.pageGuide.step >= guideSteps.length - 1) { closePageGuide(); return }
      state.pageGuide.step++
      nextTick(positionPageGuide)
    }

    function prevPageGuide() {
      if (state.pageGuide.step <= 0) return
      state.pageGuide.step--
      nextTick(positionPageGuide)
    }

    // ===== Keyboard =====
    function handleKeydown(e) {
      if (state.pageGuide.active) {
        if (e.key === 'Escape') closePageGuide()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); startAdding() }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); document.querySelector('.search-wrap input')?.focus() }
      if (e.key === 'Escape') {
        closeCtxMenu()
        if (state.noteDialog.visible) closeNote()
        if (state.confirmDialog.item) state.confirmDialog.item = null
        if (state.launchDialog.item) state.launchDialog.item = null
        if (state.branchModal.visible) state.branchModal.visible = false
        if (state.allBranchesModal.visible) state.allBranchesModal.visible = false
        if (state.syncDialog.visible) state.syncDialog.visible = false
        if (state.syncSettings.visible) state.syncSettings.visible = false
        if (state.backupDialog.visible) state.backupDialog.visible = false
        if (state.triagedDialog.visible) state.triagedDialog.visible = false
        if (state.searchQuery) state.searchQuery = ''
      }
    }

    // ===== v2：分支索引与需求↔分支关联 =====
    //
    // 关联不靠分支名，靠「分支 first-parent 独占提交里的需求ID」：
    // 融合分支（一个分支服务多个需求）通常不带需求ID，靠名字永远匹配不到。
    // 索引由引擎算好（/api/git/branch-index），前端只做反查与展示。

    function branchKey(project, branch) { return project + '\u0000' + branch }

    /**
     * 从 MR 地址推导仓库地址。
     * 项目里已经维护了 MR 地址，绝大多数情况下不必再让人填一遍仓库地址。
     */
    function deriveRepoUrl(mr) {
      if (!mr) return ''
      let s = String(mr).trim().split('#')[0].split('?')[0].replace(/\/+$/, '')
      if (!/^https?:\/\//i.test(s)) return ''
      const cutNew = s.indexOf('/-/merge_requests')
      const cutOld = s.indexOf('/merge_requests')
      if (cutNew >= 0) s = s.slice(0, cutNew)
      else if (cutOld >= 0) s = s.slice(0, cutOld)
      s = s.replace(/\/+$/, '')
      return /\.git$/.test(s) ? s : s + '.git'
    }

    function saveBranchIndex() {
      try { localStorage.setItem(LS_BRANCH_INDEX, JSON.stringify(state.branchIndex)) } catch {}
    }

    function saveBranchTriage() {
      try { localStorage.setItem(LS_BRANCH_TRIAGE, JSON.stringify(state.branchTriage)) } catch {}
    }

    function saveIndexConfig() {
      try { localStorage.setItem(LS_INDEX_CONFIG, JSON.stringify(state.indexConfig)) } catch {}
    }

    /** 切换「只看我的分支」后必须重算一次，否则界面上还是旧口径的结果 */
    function setOnlyMine(val) {
      state.indexConfig.onlyMine = !!val
      saveIndexConfig()
      refreshBranchIndex(true)
    }

    /** 缺 timestamp 一律视为过期：历史脏数据不能被当成新鲜结果继续用 */
    function indexStale(entry) {
      return !entry || !entry.timestamp || (Date.now() - entry.timestamp) > INDEX_TTL_MS
    }

    function hasFreshIndex() {
      const projects = state.projectNames.filter(p => p.localPath && deriveRepoUrl(p.mr))
      if (!projects.length) return false
      return projects.every(p => !indexStale(state.branchIndex[p.name]))
    }

    /**
     * 刷新分支索引。
     *
     * 只有「配了 MR 地址 + 配了本地路径」的项目才可能算出需求ID：反查要用本地提交历史，
     * 没 clone 就没得算。这种项目直接跳过并提示，而不是静默返回空结果让人以为「没有关联」。
     */
    async function refreshBranchIndex(force) {
      if (state.indexBusy) { toast('正在刷新分支索引，请稍候'); return }

      const targets = state.projectNames.filter(p => p.localPath && deriveRepoUrl(p.mr))
      if (!targets.length) { toast('没有同时配置 MR 地址与本地路径的项目，无法反查需求ID'); return }

      state.indexBusy = true
      state.indexProgress = { visible: true, done: 0, total: targets.length }
      let ok = 0

      for (const p of targets) {
        try {
          const onlyMine = state.indexConfig.onlyMine !== false
          const query = `?path=${encodeURIComponent(p.localPath)}&repo=${encodeURIComponent(deriveRepoUrl(p.mr))}`
            + `&onlyMine=${onlyMine ? '1' : '0'}${force ? '&refresh=1' : ''}`
          const res = await fetch(apiUrl('/api/git/branch-index') + query)
          const data = await res.json()
          if (data.code) throw new Error(data.error || data.code)

          const branches = {}
          for (const b of data.branches) {
            branches[b.name] = {
              ids: b.ids, commits: b.commits, lastDate: b.lastDate,
              merged: b.merged, skipped: b.skipped, owner: b.owner || '',
            }
          }
          state.branchIndex[p.name] = {
            base: data.base,
            branches,
            unregistered: (data.unregistered || []).map(u => u.name),
            unregisteredOwners: Object.fromEntries((data.unregistered || []).map(u => [u.name, u.owner || ''])),
            onlyMine: !!data.onlyMine,
            notMine: data.notMine || 0,
            remoteFiltered: !!data.remoteFiltered,
            remoteOnly: data.remoteOnly || [],
            timestamp: Date.now()
          }
          ok++
        } catch (e) {
          toast(`[${p.name}] 索引失败：${e.message}`)
        }
        state.indexProgress.done++
      }

      state.indexBusy = false
      saveBranchIndex()
      setTimeout(() => { state.indexProgress.visible = false }, 800)
      toast(`分支索引已刷新（${ok}/${targets.length} 个项目）`)
    }

    /** 该分支上除当前需求外还覆盖哪些需求ID —— 用于「还服务 N 个需求」的影响面提示 */
    function branchOtherIds(projectName, branchName, selfId) {
      const entry = state.branchIndex[projectName]
      const info = entry && entry.branches[branchName]
      if (!info || !info.ids) return []
      return info.ids.filter(id => id !== selfId)
    }

    /**
     * 取一条需求自身的飞书需求ID。
     *
     * 优先用同步写入的 source.workItemId；老数据（手工录入的）没有该字段，
     * 就从需求链接里提 —— 飞书需求详情链接天然以 work_item_id 结尾
     * （/xxx/story/detail/7000000012）。不这样做的话，影响面提示对历史需求全部失效，
     * 而历史需求恰恰是最容易漏发的那批。
     */
    function selfWorkItemId(item) {
      if (item.source && item.source.workItemId) return item.source.workItemId
      const m = String(item.link || '').match(/(^|[^0-9])([0-9]{10})([^0-9]|$)/)
      return m ? m[2] : ''
    }

    /**
     * 影响面：某条需求行的分支还覆盖哪些别的需求。
     * 融合分支很容易只被登记到一个需求名下（分支名只写了一个ID，代码里其实覆盖好几个），
     * 发版时漏掉的就是这些「隐形的同行者」，所以要在列表里直接提示出来。
     */
    function impactIds(item, entry) {
      const projectName = entry.name || entry.project || ''
      const branchName = entry.branch || ''
      if (!projectName || !branchName) return []
      return branchOtherIds(projectName, branchName, selfWorkItemId(item))
    }

    /** 因「不是自己创建」被过滤掉的分支总数，用于在界面上说明当前口径 */
    const indexNotMineTotal = computed(() =>
      Object.values(state.branchIndex).reduce((n, e) => n + (e.notMine || 0), 0))

    /**
     * 索引诊断：这几种情况会让「未登记分支」和匹配结果失真，必须显示出来。
     *
     * 尤其是 remoteFailed：远端分支列表没取到时（凭据/协议问题）不会报错，
     * 只是退化成「本地 ref 全算数」，本地那些远端已删除的旧分支会全部变成
     * 「未登记分支」—— 静默降级比报错危险得多。
     */
    const indexDiagnostics = computed(() => {
      let remoteFailed = 0
      let skipped = 0
      let remoteOnly = 0
      for (const e of Object.values(state.branchIndex)) {
        if (e.remoteFiltered === false) remoteFailed++
        for (const b of Object.values(e.branches || {})) if (b.skipped) skipped++
        remoteOnly += (e.remoteOnly || []).length
      }
      return { remoteFailed, skipped, remoteOnly }
    })

    /**
     * 未登记分支：有独占提交、但反查不到任何需求ID。
     * 发版时最容易漏掉的就是这些 —— 需求还没出、或者一堆优化都做在一个分支里。
     */
    const unregisteredGroups = computed(() => {
      const byName = new Map()
      for (const [project, entry] of Object.entries(state.branchIndex)) {
        for (const name of entry.unregistered || []) {
          if (state.branchTriage[branchKey(project, name)]) continue
          const info = (entry.branches || {})[name] || {}
          const g = byName.get(name) || { name, projects: [], totalCommits: 0, lastDate: '' }
          g.projects.push({ project, commits: info.commits || 0, lastDate: info.lastDate || '' })
          g.totalCommits += info.commits || 0
          if ((info.lastDate || '') > g.lastDate) g.lastDate = info.lastDate
          byName.set(name, g)
        }
      }
      return [...byName.values()].sort((a, b) => b.totalCommits - a.totalCommits)
    })

    /**
     * 处置一个未登记分支。
     * 按分支名一次处置它出现的所有项目：同名分支常横跨多个仓库
     * （如 feat/mdm二期分支 同时在 aps/scm/ops），逐个项目点三次是纯浪费。
     */
    function triageBranchGroup(group, action) {
      for (const p of group.projects) {
        state.branchTriage[branchKey(p.project, group.name)] = { action, at: Date.now() }
      }
      saveBranchTriage()
      toast(action === 'exempt' ? `已标记「无需需求」：${group.name}` : `已忽略：${group.name}`)
    }

    function restoreBranchTriage(group) {
      for (const e of group.entries) delete state.branchTriage[e.key]
      saveBranchTriage()
      toast('已恢复提示')
    }

    /**
     * 已处置分支：按项目汇总 + 详情弹窗。
     *
     * 为什么改成按项目聚合：原来是一长串「分支（已忽略）恢复 分支（已忽略）恢复…」，
     * 既看不出哪个项目积压得多，也没法一条条看。详情里按**最后提交时间倒序**（新的在前），
     * 并且**最后提交超过半年的直接不列**——那些分支已经不构成发版风险，留着只会占视线。
     */
    const TRIAGE_STALE_DAYS = 183
    function triageCutoff() {
      const d = new Date(Date.now() - TRIAGE_STALE_DAYS * 24 * 3600 * 1000)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    const triagedProjects = computed(() => {
      const cutoff = triageCutoff()
      const map = new Map()
      for (const [key, rec] of Object.entries(state.branchTriage)) {
        const parts = key.split('\u0000')
        const project = parts[0]
        const branch = parts[1] || key
        // 没配本地路径的项目取不到分支信息（也就没有日期）——这种保守留着，别把记录藏没了
        const info = ((state.branchIndex[project] || {}).branches || {})[branch] || {}
        const lastDate = info.lastDate || ''
        if (lastDate && lastDate < cutoff) continue
        if (!matchUnregKeyword(branch, [project])) continue
        const g = map.get(project) || { project, entries: [], exempt: 0, ignored: 0 }
        if (rec.action === 'exempt') g.exempt += 1; else g.ignored += 1
        // 索引里没有这条时提交数是「未知」而不是 0：报个假数字会让人以为分支没内容
        g.entries.push({ key, project, branch, action: rec.action, lastDate, commits: info.commits ?? null })
        map.set(project, g)
      }
      const list = [...map.values()]
      list.forEach(g => g.entries.sort((a, b) => String(b.lastDate).localeCompare(String(a.lastDate))))
      return list.sort((a, b) => b.entries.length - a.entries.length || a.project.localeCompare(b.project))
    })

    function openTriagedDetail(group) {
      state.triagedDialog = { visible: true, project: group.project, entries: group.entries.slice() }
    }

    /** 详情弹窗里单条恢复：恢复后它会回到「未登记分支」重新参与判断 */
    function restoreOneTriage(entry) {
      delete state.branchTriage[entry.key]
      saveBranchTriage()
      state.triagedDialog.entries = state.triagedDialog.entries.filter(e => e.key !== entry.key)
      toast(`已恢复：${entry.branch}`)
      if (!state.triagedDialog.entries.length) state.triagedDialog.visible = false
    }

    /** 卡片上「涉及面」的标注口径：本需求的项目分支 + 一同发版分支，超过 3 个算广 */
    const WIDE_ITEM_THRESHOLD = 3
    function branchTotal(item) {
      return ((item.projects || []).length) + ((item.syncBranches || []).length)
    }
    const isWideItem = (item) => branchTotal(item) > WIDE_ITEM_THRESHOLD
    const wideItemTitle = (item) =>
      `涉及 ${branchTotal(item)} 个项目分支（含发版 ${(item.projects || []).length} / 同发 ${(item.syncBranches || []).length}）——改动面较广，发版前先确认影响面`

    /** 已处置的分支（折叠区展示 + 可恢复） */
    const triagedGroups = computed(() => {
      const byName = new Map()
      for (const [key, rec] of Object.entries(state.branchTriage)) {
        const parts = key.split('\u0000')
        const name = parts[1] || key
        const g = byName.get(name) || { name, entries: [], action: rec.action }
        g.entries.push({ project: parts[0], key })
        byName.set(name, g)
      }
      return [...byName.values()]
    })

    /**
     * 未登记分支的筛选：分支名与项目名都参与匹配。
     * 未登记分支往往有几十条、横跨多个仓库，按项目名找「某仓库还剩哪些没登记」比翻分支名快。
     */
    function matchUnregKeyword(name, projects) {
      const kw = state.unregKeyword.trim().toLowerCase()
      if (!kw) return true
      return name.toLowerCase().includes(kw) || projects.some(p => (p || '').toLowerCase().includes(kw))
    }
    const filteredUnregGroups = computed(() =>
      unregisteredGroups.value.filter(g => matchUnregKeyword(g.name, g.projects.map(p => p.project))))
    // 已处置区也一起过滤：否则搜一个已处置的分支会「什么都没搜到」，还得自己去折叠区翻
    const filteredTriagedGroups = computed(() =>
      triagedGroups.value.filter(g => matchUnregKeyword(g.name, g.entries.map(e => e.project))))

    // ===== v2：飞书项目需求同步 =====
    //
    // 同步是「消掉手工贴标题+链接」的主力：一次拉一批、去重、并按需求ID自动挂上分支。
    // 关键前提：一个空间里「需求管理」类工作项是按业务域拆成多张表的
    // （实测 your_space 有 OMS/SCM/TMS/BMS/BD/仓库/优化/架构运维/AI 共 10 张），
    // 所以类型是多选，只查一张会静默漏掉其他域的全部需求。

    // {statusFilter} 由服务端按「该类型实际存在的状态」生成（见 server.js meegleQueryAll）。
    // 旧配置里存的模板没有这个占位符，会在 onMounted 自动升级 —— 否则老配置升级后过滤会静默失效。
    const DEFAULT_MQL = 'SELECT `work_item_id`,`name`,`work_item_status` FROM `{space}`.`{type}`{statusFilter}'
    const LEGACY_MQL = 'SELECT `work_item_id`,`name`,`work_item_status` FROM `{space}`.`{type}`'

    /**
     * 排除状态由服务端按「类型 × 该类型的状态枚举」取交集后应用：
     * 各类型的状态集不一样（实测 story 有「已上线」、oms 没有），前端不能拼成一个
     * 全局 WHERE 片段下发 —— 写到没有该状态的类型上会直接报 metadata error。
     */
    function setExcludeStatuses(text) {
      state.meegleConfig.excludeStatuses = String(text || '')
        .split(/[，,]/)
        .map(s => s.trim())
        .filter(Boolean)
    }

    function saveMeegleConfig() {
      try { localStorage.setItem(LS_MEEGLE_CONFIG, JSON.stringify(state.meegleConfig)) } catch {}
    }

    /** 提取文本里的 10 位需求ID（带数字边界，避免 1234567890 命中 11234567890） */
    function extractReqIds(text) {
      const out = []
      const re = /(^|[^0-9])([0-9]{10})([^0-9]|$)/g
      let m
      const s = String(text || '')
      while ((m = re.exec(s)) !== null) {
        if (!out.includes(m[2])) out.push(m[2])
        re.lastIndex -= 1 // 边界字符可能同时属于下一段的起始，回退一格避免漏配
      }
      return out
    }

    /**
     * 已有需求的 workItemId 集合。
     * 预览列表每行都要判「是否已导入」，逐行对全部需求跑一遍 selfWorkItemId（内含正则）
     * 是 O(行数 × 需求数)：几百行 × 几百条，每敲一个筛选字符都白跑十万次正则。
     */
    const existingWorkItemIds = computed(() => {
      const set = new Set()
      for (const it of state.items) {
        const id = selfWorkItemId(it)
        if (id) set.add(id)
      }
      return set
    })

    function isExistingRequirement(workItemId) {
      return existingWorkItemIds.value.has(workItemId)
    }

    /**
     * 需求ID → 分支 的反向索引（由分支索引翻转而来）。
     * 一次遍历覆盖两条来源：L1（独占提交里的需求ID，能识别融合分支）、
     * L2（分支名里的需求ID，兜住提交信息没写规范的）。
     * 预计算成 Map 是为了避免在预览列表里对上千行逐行扫描所有分支。
     */
    const reqToBranchesMap = computed(() => {
      const map = new Map()
      const push = (id, entry) => {
        if (!map.has(id)) map.set(id, [])
        const arr = map.get(id)
        if (!arr.some(x => x.project === entry.project && x.branch === entry.branch)) arr.push(entry)
      }
      for (const [project, idx] of Object.entries(state.branchIndex)) {
        for (const [branch, info] of Object.entries(idx.branches || {})) {
          if (info.merged) continue
          for (const id of info.ids || []) push(id, { project, branch, via: 'L1', commits: info.commits })
          for (const id of extractReqIds(branch)) push(id, { project, branch, via: 'L2', commits: info.commits })
        }
      }
      return map
    })

    /**
     * 同一项目命中多个分支时只留一条主分支：
     * 优先 L1（提交证据比名字可靠），同级取独占提交更少的（越专一越可能是本需求的分支）。
     * 其余分支保留在 otherBranches 里展示，不静默丢弃。
     */
    function pickPrimaryMatches(matches) {
      const byProject = new Map()
      for (const m of matches || []) {
        const cur = byProject.get(m.project)
        if (!cur) { byProject.set(m.project, { ...m, otherBranches: [] }); continue }
        const better = (m.via === 'L1' && cur.via !== 'L1')
          || (m.via === cur.via && (m.commits || 0) < (cur.commits || 0))
        if (better) {
          byProject.set(m.project, { ...m, otherBranches: [cur.branch, ...cur.otherBranches] })
        } else {
          cur.otherBranches.push(m.branch)
        }
      }
      return [...byProject.values()]
    }

    function matchesOf(workItemId) {
      return reqToBranchesMap.value.get(workItemId) || []
    }

    /**
     * 需求行的「自动匹配」建议。
     *
     * 分支索引算出来的关联结果原先只在同步预览里出现，需求行上只显示手工挂的分支 ——
     * 于是一个覆盖本需求、但需求没手工挂它的分支（融合分支最典型：它带着好几个ID，
     * 只挂在其中一两条需求名下）在页面上完全不可见，既不在未登记分支（它有ID），
     * 也不在任何需求行上。这里把它补成需求行上的一条可点建议。
     *
     * 已经挂在需求上的分支不再重复提示，避免同一行出现两条一样的分支。
     */
    function autoSuggestions(item) {
      const id = selfWorkItemId(item)
      if (!id) return []
      const assigned = [
        ...(item.projects || []).map(p => `${p.name}\u0000${p.branch || ''}`),
        ...(item.syncBranches || []).map(p => `${p.project}\u0000${p.branch || ''}`),
      ]
      return pickPrimaryMatches(matchesOf(id))
        .filter(m => !assigned.includes(`${m.project}\u0000${m.branch}`))
    }

    /**
     * 点建议即把该分支挂到本需求。
     *
     * 同一项目已经挂了别的分支时**追加一行**，不覆盖也不要求用户自己切换：
     * 一条需求的代码同时落在同一仓库的两条分支上（融合分支 merge 了按需求命名的分支）
     * 是真实存在的形态，两个分支都要留在清单里；覆盖等于把人工判断冲掉，
     * 而提示「请自己换」等于让人多点两次还得先删掉旧行。
     */
    function adoptSuggestion(item, s) {
      const list = item.projects || (item.projects = [])
      const blank = list.find(p => p.name === s.project && !p.branch)
      if (blank) blank.branch = s.branch
      else list.push({ name: s.project, branch: s.branch, notes: '' })
      saveToLocalStorage()
      toast(`已挂上 ${s.project} · ${s.branch}`)
    }

    async function loadMeegleStatus() {
      try {
        const res = await fetch(apiUrl('/api/meegle/status'))
        const data = await res.json()
        state.meegleStatus = data.code ? { authenticated: false, host: '', error: data.error } : data
      } catch (e) {
        state.meegleStatus = { authenticated: false, host: '', error: e.message }
      }
      return state.meegleStatus
    }

    async function openSyncSettings() {
      state.syncSettings.visible = true
      state.syncSettings.loading = true
      state.syncSettings.error = ''
      // 不 await：登录状态只用于展示，不该拖住空间列表；状态到了模板会自己刷新
      loadMeegleStatus()
      try {
        const res = await fetch(apiUrl('/api/meegle/spaces'))
        const data = await res.json()
        if (data.code) throw new Error(data.error || data.code)
        state.syncSettings.spaces = data.spaces || []
        if (!state.meegleConfig.projectKey && state.syncSettings.spaces.length) {
          const first = state.syncSettings.spaces[0]
          state.meegleConfig.projectKey = first.projectKey
          state.meegleConfig.simpleName = first.simpleName
          state.meegleConfig.spaceName = first.name
        }
        if (state.meegleConfig.projectKey) await loadTypes()
      } catch (e) {
        state.syncSettings.error = e.message
      }
      state.syncSettings.loading = false
    }

    async function loadTypes() {
      if (!state.meegleConfig.projectKey) return
      try {
        const res = await fetch(apiUrl('/api/meegle/types?projectKey=' + encodeURIComponent(state.meegleConfig.projectKey)))
        const data = await res.json()
        if (data.code) throw new Error(data.error || data.code)
        state.syncSettings.types = data.types || []
        // 默认勾选所有「需求管理/优化」类，排除缺陷、版本、迭代、任务等非需求类型
        if (!state.meegleConfig.typeApiNames.length) {
          state.meegleConfig.typeApiNames = state.syncSettings.types
            .filter(t => !t.disabled && /需求管理|优化/.test(t.name))
            .map(t => t.apiName)
        }
      } catch (e) {
        state.syncSettings.error = e.message
      }
    }

    function selectSpace(projectKey) {
      const s = state.syncSettings.spaces.find(x => x.projectKey === projectKey)
      state.meegleConfig.projectKey = projectKey
      state.meegleConfig.simpleName = s ? s.simpleName : projectKey
      state.meegleConfig.spaceName = s ? s.name : ''
      state.meegleConfig.typeApiNames = []
      loadTypes()
    }

    function toggleType(apiName) {
      const list = state.meegleConfig.typeApiNames
      const i = list.indexOf(apiName)
      if (i >= 0) list.splice(i, 1)
      else list.push(apiName)
    }

    function saveSyncSettings() {
      saveMeegleConfig()
      state.syncSettings.visible = false
      toast('同步设置已保存')
    }

    /** 顶部「同步飞书项目」入口：未登录就明确提示，不要让人对着空弹窗猜 */
    async function openSyncDialog() {
      if (!state.meegleConfig.projectKey || !state.meegleConfig.typeApiNames.length) {
        toast('请先在「同步设置」里选择空间与工作项类型')
        openSyncSettings()
        return
      }
      const st = await loadMeegleStatus()
      if (!st.authenticated) {
        // 不写 --host：各版本 CLI 对参数的接受程度不一致，同事那一版会把 host 当成命令，
        // 报 unknown command "project" for "meegle"。让 CLI 自己交互式选空间最稳。
        toast(st.error
          ? '飞书项目不可用：' + st.error
          : '未登录飞书项目，请在终端执行 meegle auth login（不带参数，按提示选 ' + (st.host || 'project.feishu.cn') + '）')
        return
      }
      // 类型元数据必须先拿到：MQL 的表名用的是 typeKey，而除了 story 之外的
      // 类型（oms/tms/bms…）typeKey 是一串哈希，与 apiName 并不相同。
      // 拿 apiName 顶替会查错表 —— 要么报错，要么查到别的类型的数据。
      if (!state.syncSettings.types.length) await loadTypes()
      if (!state.syncSettings.types.length) {
        toast('未能加载工作项类型，请先打开「同步设置」确认空间选择')
        openSyncSettings()
        return
      }

      // 分支索引是「能不能匹配到分支」的前提。索引没算就直接开预览，会让每一行都显示
      // 「未匹配到分支」，用户会以为是自己项目的问题 —— 这里先把索引补算上。
      if (!hasFreshIndex()) {
        const eligible = state.projectNames.filter(p => p.localPath && deriveRepoUrl(p.mr))
        if (eligible.length) await refreshBranchIndex(false)
      }

      state.syncDialog = { visible: true, loading: true, error: '', perType: [], errors: [], keyword: '', onlyUnregistered: false }
      state.syncSelection = {}
      state.syncCollapsed = {}
      try {
        await fetchMeegleItems()
      } catch (e) {
        state.syncDialog.error = e.message
      }
      state.syncDialog.loading = false
    }

    async function fetchMeegleItems() {
      const cfg = state.meegleConfig
      const types = state.syncSettings.types.filter(t => cfg.typeApiNames.includes(t.apiName))

      const res = await fetch(apiUrl('/api/meegle/query'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectKey: cfg.projectKey,
          simpleName: cfg.simpleName,
          types,
          mqlTemplate: cfg.mqlTemplate || DEFAULT_MQL,
          excludeStatuses: cfg.excludeStatuses || [],
          maxPerType: cfg.maxPerType || 200,
        }),
      })
      const data = await res.json()
      if (data.code) throw new Error(data.error || data.code)
      state.syncRaw = data.items || []
      state.syncDialog.perType = data.perType || []
      state.syncDialog.errors = data.errors || []
    }

    /** 预览行：标记是否为新增，并算好会挂上哪些分支 */
    const syncRows = computed(() => {
      const kw = (state.syncDialog.keyword || '').toLowerCase()
      const rows = []
      for (const r of state.syncRaw) {
        const isNew = !isExistingRequirement(r.workItemId)
        if (state.syncDialog.onlyUnregistered && !isNew) continue
        if (kw && !(r.name || '').toLowerCase().includes(kw) && !r.workItemId.includes(kw)) continue
        rows.push({ ...r, isNew, matches: pickPrimaryMatches(matchesOf(r.workItemId)) })
      }
      return rows
    })

    const syncSelectedCount = computed(() => Object.values(state.syncSelection).filter(Boolean).length)

    /**
     * 已勾选但被当前筛选隐藏的行数。
     * 导入按选中集合走，所以这些行照样会被导入；不写出来用户会以为筛选=取消勾选。
     */
    const syncHiddenSelectedCount = computed(() => {
      const visible = new Set(syncRows.value.map(r => r.workItemId))
      return Object.keys(state.syncSelection).filter(id => state.syncSelection[id] && !visible.has(id)).length
    })

    /**
     * 「为什么没匹配到分支」的说明。
     *
     * 逐行显示「未匹配到分支」会把一个全局前置条件问题伪装成单条需求的事实 ——
     * 用户看到 7000000012 明明在 pms-web 有分支却显示未匹配，第一反应只会是工具坏了。
     * 这里把真正的原因（没配项目 / 没配本地路径 / 索引没算 / 索引没覆盖全部项目）讲出来。
     */
    const syncIndexHint = computed(() => {
      const all = state.projectNames
      const eligible = all.filter(p => p.localPath && deriveRepoUrl(p.mr))
      const indexed = Object.keys(state.branchIndex)

      if (!all.length) {
        return '还没有配置任何项目，因此无法反查需求对应的分支。请展开「项目管理」添加项目'
          + '（需要「MR 地址」+「本地路径」），再点「刷新分支索引」。'
          + '如果你之前用的是旧版（端口 1949），旧版数据不在当前端口的浏览器存储里 ——'
          + '可以停掉旧版服务后重启本工具（端口相同即数据可见），或在旧版「导出」后于本页「导入」。'
      }
      if (!eligible.length) {
        return `已配置 ${all.length} 个项目，但没有一个同时具备「MR 地址」和「本地路径」，无法反查分支。`
          + '反查要用本地提交历史，两者缺一不可。'
      }
      if (!indexed.length) {
        return `分支索引还没生成（将覆盖 ${eligible.length} 个项目），所以现在每条需求都显示未匹配到分支。`
          + '请点顶部「刷新分支索引」。'
      }
      if (indexed.length < eligible.length) {
        const missing = eligible.map(p => p.name).filter(n => !indexed.includes(n))
        return `分支索引只覆盖了 ${indexed.length}/${eligible.length} 个项目。`
          + `以下项目未参与匹配：${missing.join('、')}。`
      }
      return ''
    })

    function toggleSyncRow(workItemId) {
      state.syncSelection[workItemId] = !state.syncSelection[workItemId]
    }

    function selectAllNew() {
      const next = {}
      for (const r of syncRows.value) if (r.isNew) next[r.workItemId] = true
      state.syncSelection = next
      toast(`已选中 ${Object.keys(next).length} 条新增需求`)
    }

    /**
     * 按状态分组。
     *
     * 一次拉回来上百条混在一起，很难判断「这批要发哪些」。按状态切开后可以整组勾选：
     * 比如只导「开发中 + 已提测」，把还在 UAT 的留到下一批。
     */
    // 按研发阶段从早到晚排列。匹配用「取最靠后的命中项」而不是第一个命中：
    // 这样「生产测试验证」会归到「生产」而不是更早的「测试」，「UAT测试」也排在「测试中」之后。
    // 顺序不完美的少数状态只会影响展示顺序，不影响任何判断，所以不去追求语义完美。
    const STATUS_ORDER_HINTS = [
      '未开始', '开始', '受理', '预研', '调研', 'prd', '设计',
      '待需求评审', '评审', '待排期', '分配版本', '版本评审',
      '待开发', '开发', '提测', '待测试', '测试', 'uat', '验收',
      '待上线', '发版', '发布', '生产', '上线', '结束', '终止', '关闭', '挂起',
    ]
    function statusRank(status) {
      const s = String(status || '').toLowerCase()
      let rank = -1
      for (let i = 0; i < STATUS_ORDER_HINTS.length; i++) {
        if (s.includes(STATUS_ORDER_HINTS[i])) rank = i
      }
      return rank < 0 ? STATUS_ORDER_HINTS.length : rank
    }

    const syncGroups = computed(() => {
      const byStatus = new Map()
      for (const r of syncRows.value) {
        const key = r.status || '（无状态）'
        if (!byStatus.has(key)) byStatus.set(key, [])
        byStatus.get(key).push(r)
      }
      return [...byStatus.entries()]
        .map(([status, rows]) => ({
          status,
          rows,
          total: rows.length,
          newCount: rows.filter(r => r.isNew).length,
          selected: rows.filter(r => state.syncSelection[r.workItemId]).length,
        }))
        .sort((a, b) => {
          const d = statusRank(a.status) - statusRank(b.status)
          return d !== 0 ? d : b.total - a.total
        })
    })

    /** 整组勾选/取消 —— 分组的主要价值就在这里 */
    function toggleGroup(group) {
      const allSelected = group.newCount > 0 && group.selected >= group.newCount
      const next = { ...state.syncSelection }
      for (const r of group.rows) {
        if (!r.isNew) continue
        if (allSelected) delete next[r.workItemId]
        else next[r.workItemId] = true
      }
      state.syncSelection = next
    }

    /** 收起/展开某个状态分组。收起只影响显示，不影响已勾选的项 */
    function toggleGroupCollapse(status) {
      state.syncCollapsed = { ...state.syncCollapsed, [status]: !state.syncCollapsed[status] }
    }

    /** 导入选中项：只建新需求，已存在的默认不动（保护本地已人工调整过的数据） */
    function applySync() {
      // 按**选中集合**取，而不是按 syncRows 取：syncRows 被关键词与「只看未导入」过滤过，
      // 勾选后再输入筛选词会让「按钮写着导入选中 12 条、实际只导 3 条」，且毫无提示。
      // 过滤只该影响看得见什么，不该影响已经勾了什么。
      const byId = new Map(state.syncRaw.map(r => [r.workItemId, r]))
      const picked = Object.keys(state.syncSelection)
        .filter(id => state.syncSelection[id])
        .map(id => byId.get(id))
        .filter(r => r && !isExistingRequirement(r.workItemId))
        // syncRaw 里只有原始字段，行级算出来的 matches 得在这里补上（旧实现是直接取预览行）
        .map(r => ({ ...r, matches: pickPrimaryMatches(matchesOf(r.workItemId)) }))
      if (!picked.length) { toast('请先勾选要导入的新需求'); return }

      let n = 0
      for (const r of picked) {
        const item = {
          id: newId(),
          name: r.name,
          link: r.link,
          status: 'new',
          projects: r.matches.map(m => ({ name: m.project, branch: m.branch, notes: '' })),
          syncBranches: [],
          source: {
            provider: 'meegle',
            projectKey: state.meegleConfig.projectKey,
            simpleName: state.meegleConfig.simpleName,
            workItemType: r.workItemType,
            workItemId: r.workItemId,
            syncedAt: Date.now(),
          },
          _justAdded: true,
        }
        state.items.unshift(item)
        n++
        nextTick(() => setTimeout(() => { item._justAdded = false }, 350))
      }
      saveToLocalStorage()
      state.syncDialog.visible = false
      state.syncSelection = {}
      toast(`已导入 ${n} 条需求`)
    }

    // ===== Lifecycle =====
    document.addEventListener('keydown', handleKeydown)
    document.addEventListener('click', () => { if (state.ctxMenu.visible) closeCtxMenu() })
    window.addEventListener('focus', handleDailyBranchFocus)
    window.addEventListener('resize', updatePageGuideRect)
    window.addEventListener('scroll', updatePageGuideRect, true)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) handleDailyBranchFocus() })

    onMounted(async () => {
      // 端口必须在任何接口调用之前确定，否则会打到别的进程上（旧引擎不写端口文件，退回默认值）
      await resolveApiPort()

      // v2 的这几个键始终从 localStorage 读：toDo.json 里没有它们，
      // 不能因为「已从 json 加载」就跳过，否则人工处置记录每次刷新都会丢。
      // 必须排在 loadFromJsonFile 之前：setFullData 结尾会无条件回写这几个键，
      // 那时 state 里还是初始值 {}，会把本地真实记录覆盖成空。
      try { state.branchIndex = JSON.parse(localStorage.getItem(LS_BRANCH_INDEX)) || {} } catch { state.branchIndex = {} }
      try { state.branchLinks = JSON.parse(localStorage.getItem(LS_BRANCH_LINKS)) || {} } catch { state.branchLinks = {} }
      try { state.branchTriage = JSON.parse(localStorage.getItem(LS_BRANCH_TRIAGE)) || {} } catch { state.branchTriage = {} }
      try {
        const ic = JSON.parse(localStorage.getItem(LS_INDEX_CONFIG))
        if (ic && typeof ic === 'object') state.indexConfig = { ...state.indexConfig, ...ic }
      } catch {}
      try {
        const cfg = JSON.parse(localStorage.getItem(LS_MEEGLE_CONFIG))
        if (cfg && typeof cfg === 'object') state.meegleConfig = { ...state.meegleConfig, ...cfg }
        // 旧默认模板没有 {statusFilter} 占位符，直接用会让「排除已完成状态」静默失效，
        // 所以只在「确认是旧的默认模板」时才升级，用户自定义过的模板不动
        if (state.meegleConfig.mqlTemplate === LEGACY_MQL) state.meegleConfig.mqlTemplate = DEFAULT_MQL
      } catch {}

      // Load data
      const loaded = await loadFromJsonFile()
      if (!loaded) {
        try { state.projectNames = JSON.parse(localStorage.getItem('todo_project_names')) || [] } catch { state.projectNames = [] }
        try { state.items = JSON.parse(localStorage.getItem('todo_release_data')) || [] } catch { state.items = [] }
        try { state.branchesCache = JSON.parse(localStorage.getItem('todo_branch_cache')) || {} } catch { state.branchesCache = {} }
        state.launchBranch = localStorage.getItem('todo_launch_branch') || ''
      }

      loadDailyBranchCheck()
      if (state.dailyBranchCheck.active) {
        scheduleDailyBranchCheck()
        runDailyBranchCheck()
      }

      // 卡片区的浏览状态（折叠 / 分组开合）要早点读：晚于首帧渲染会出现"先展开再折起"的闪动
      loadCardUiState()
      bindImpactPop()

      checkDailyReminder()
      autoFetchBranches()
      loadUpdateNotice()
      loadAppVersion().finally(autoCheckUpdate)
    })

    async function loadFromJsonFile() {
      try {
        const resp = await fetch('./' + JSON_FILENAME, { cache: 'no-store' })
        if (resp.ok) {
          const data = await resp.json()
          setFullData(data)
          return true
        }
      } catch {}
      return false
    }

    function toggleSection(key) {
      state.sectionExpanded[key] = !state.sectionExpanded[key]
      saveSectionExpanded()
    }

    // ===== v2: 需求卡片的折叠 / 排序 / 影响面气泡 =====
    //
    // 为什么折叠状态要分「折叠集合」和「已发版展开集合」两个：折叠的默认值按状态不同
    // （待发版/发版中默认展开、已发版默认折叠），只存"例外"就不用给新数据做初始化。
    // 这三个键都刻意不进导出文件：它们是本机的浏览偏好，不是需求数据本身。

    const itemKey = (item) => item.id
    /** 当前正在拖的卡片 id。刻意用闭包变量而不是 state：拖动过程中改响应式状态会触发重渲染，
     *  正在拖的 DOM 节点被换掉后浏览器会取消拖拽（实测过）。 */
    let dragId = null
    /** 拖拽时锁定的落点（拖拽过程只写这两个闭包变量 + class，不碰响应式状态） */
    let dropKey = null
    let dropAfter = false
    /** 「待发版」这一个分组里既有 pending 也有 new，排序要按分组口径走，不能只认 pending */
    const inPendingGroup = (it) => it.status === 'pending' || it.status === 'new'
    /** 一个分组包含哪些需求：待发版里同时装着 new 和 pending（和 sections 的口径一致） */
    const itemsOfSection = (key) => state.items.filter(i => (key === 'pending' ? (i.status === 'pending' || i.status === 'new') : i.status === key))

    function isItemCollapsed(item) {
      // 搜索时强制展开：搜到了却看不见内容，比"记住折叠"更让人困惑
      if (state.searchQuery) return false
      return item.status === 'released' ? !state.expandedReleased.has(item.id) : state.collapsedItems.has(item.id)
    }

    function toggleItemCollapse(item) {
      if (item.status === 'released') {
        state.expandedReleased.has(item.id) ? state.expandedReleased.delete(item.id) : state.expandedReleased.add(item.id)
      } else {
        state.collapsedItems.has(item.id) ? state.collapsedItems.delete(item.id) : state.collapsedItems.add(item.id)
      }
      saveCollapsed()
    }

    function expandSectionCards(key) {
      itemsOfSection(key).forEach(i => {
        if (i.status === 'released') state.expandedReleased.add(i.id); else state.collapsedItems.delete(i.id)
      })
      // 展开卡片时顺带把分组打开：已发版默认是收起的，只展开卡片等于什么都没看见
      state.sectionExpanded[key] = true
      saveCollapsed(); saveSectionExpanded()
    }

    function collapseSectionCards(key) {
      itemsOfSection(key).forEach(i => {
        if (i.status === 'released') state.expandedReleased.delete(i.id); else state.collapsedItems.add(i.id)
      })
      saveCollapsed()
    }

    /** 卡片头的摘要：这条需求挂了几个分支、有没有一同发版 */
    function branchCountLabel(item) {
      const n = (item.projects || []).length
      const m = (item.syncBranches || []).length
      if (!n) return '未关联分支'
      return `${n} 分支` + (m ? ` · 同发 ${m}` : '')
    }

    /** 排序模式：只针对待发版。进去先把卡片折起来，一屏能看更多、拖动目标也更好判断 */
    function toggleSortMode() {
      state.sortMode = !state.sortMode
      if (state.sortMode) {
        // 折的是"整个分组"（pending + new），和手柄的渲染口径一致，
        // 否则 new 的卡片会既带手柄又折不起来、拖了还没反应
        itemsOfSection('pending').forEach(i => state.collapsedItems.add(i.id))
        saveCollapsed()
        toast('已进入排序模式：卡片已折起，拖动 ⠿ 手柄调整顺序，调完点「完成排序」')
      } else {
        toast('已退出排序模式（顺序已保存）。卡片保持折起，想展开点分组旁的「卡片展开」')
      }
    }

    function onDragStart(e, item) {
      if (!state.sortMode || !inPendingGroup(item)) return
      dragId = item.id
      const card = e.currentTarget && e.currentTarget.closest('.req-card')
      if (card) card.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', item.id)   // Firefox 需要有数据才真的开始拖
    }

    /** 指针附近最近的一张卡片。
     *  为什么要在「容器」上接收拖拽而不是在每张卡片上：两列排布时卡片之间有缝，
     *  松手落在缝里、或落在列表下方空白处，卡片级的 drop 就没有接收者，整次拖拽被丢弃
     *  （用户实测"拖了没效果"就是这个）。这里按「点到矩形的距离」吸附最近的一张。 */
    function nearestCard(gridEl, x, y) {
      let best = null, bestD = Infinity
      for (const el of gridEl.querySelectorAll('.req-card')) {
        const r = el.getBoundingClientRect()
        const dx = Math.max(r.left - x, 0, x - r.right)
        const dy = Math.max(r.top - y, 0, y - r.bottom)
        const d = dx * dx + dy * dy
        if (d < bestD) { bestD = d; best = el }
      }
      return best
    }

    function clearDropIndicator() {
      document.querySelectorAll('.req-card.drop-before, .req-card.drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'))
    }

    function onGridDragOver(e) {
      if (!dragId) return
      const from = state.items.find(i => i.id === dragId)
      // 只在「待发版」这个分组内排序：跨分组不接受（改状态请用状态按钮，拖拽不兼职干这个）
      if (!from || !inPendingGroup(from)) return
      // 只动 class、不碰响应式状态：一旦在这里改 state，Vue 会重渲染列表并换掉正在拖的节点，
      // 浏览器随即取消这次拖拽（实测过）
      clearDropIndicator()
      dropKey = null
      const card = nearestCard(e.currentTarget, e.clientX, e.clientY)
      if (!card) return
      const target = state.items.find(i => i.id === card.dataset.key)
      if (!target || target.id === dragId || !inPendingGroup(target)) return
      e.preventDefault()   // 必须：不 preventDefault，浏览器不允许 drop（缝隙上尤其明显）
      const r = card.getBoundingClientRect()
      dropAfter = e.clientY >= r.top + r.height / 2
      dropKey = target.id
      card.classList.add(dropAfter ? 'drop-after' : 'drop-before')
    }

    function onGridDrop(e) {
      const fromId = dragId
      dragId = null
      clearDropIndicator()
      if (!fromId || !dropKey) return
      const from = state.items.find(i => i.id === fromId)
      const target = state.items.find(i => i.id === dropKey)
      dropKey = null
      if (!from || !target || from === target || !inPendingGroup(from) || !inPendingGroup(target)) return
      e.preventDefault()
      const fromIdx = state.items.indexOf(from)
      const [moved] = state.items.splice(fromIdx, 1)
      // 重新取一次目标下标：上面 splice 之后原下标可能已经移动
      let toIdx = state.items.indexOf(target)
      if (dropAfter) toIdx += 1
      state.items.splice(toIdx, 0, moved)
      saveToLocalStorage()   // 顺序就是 items 的数组顺序，存下来自然就记住了
      toast(`已调整顺序：${moved.name.slice(0, 14)}`)
    }

    function onDragEnd() {
      dragId = null
      dropKey = null
      clearDropIndicator()
      document.querySelectorAll('.req-card.dragging').forEach(el => el.classList.remove('dragging'))
    }

    /** 影响面：把这条分支覆盖的**别的**需求解析成「需求名 + 飞书链接」 */
    function impactList(item, p) {
      return impactIds(item, p).map(id => {
        const it = state.items.find(x => selfWorkItemId(x) === id)
        return { id, name: it ? it.name : '（未登记名称）', link: (it && it.link) || '' }
      })
    }

    let impactTimer = null
    function showImpactPop(e, item, p) {
      clearTimeout(impactTimer)
      const list = impactList(item, p)
      if (!list.length) return
      const projectName = p.name || p.project || ''
      const branch = p.branch || ''
      const idx = (state.branchIndex[projectName] || {}).branches || {}
      const meta = idx[branch]
      const pop = document.getElementById('impactPop')
      pop.innerHTML =
        (branch ? `<div class="p-head">${escHtml(branch)}</div>` : '')
        + (meta && meta.commits ? `<div class="p-meta">${meta.commits} 个独占提交${meta.lastDate ? ' · 最近提交 ' + meta.lastDate : ''}</div>` : '')
        + `<div class="p-sep"></div><div class="p-title">这条分支还覆盖 ${list.length} 个需求（点一行打开飞书详情）</div>`
        + list.map(r => r.link
          ? `<a class="p-item" href="${escHtml(r.link)}" target="_blank"><span class="pid">${r.id}</span><span class="ptitle">${escHtml(r.name)}</span><span class="parrow">↗</span></a>`
          : `<div class="p-item"><span class="pid">${r.id}</span><span class="ptitle">${escHtml(r.name)}</span></div>`).join('')
        + `<div class="p-foot">看的是提交记录里的需求ID（反查），所以能覆盖到"分支名里没写需求"的情况</div>`
      pop.style.display = 'block'
      pop.style.visibility = 'hidden'
      const r = e.currentTarget.getBoundingClientRect()
      const pr = pop.getBoundingClientRect()
      let top = r.top - pr.height - 10
      if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - pr.height - 8)
      pop.style.top = Math.max(8, top) + 'px'
      pop.style.left = Math.min(Math.max(8, r.left - 8), window.innerWidth - pr.width - 8) + 'px'
      pop.style.visibility = 'visible'
    }

    function hideImpactPop() {
      clearTimeout(impactTimer)
      // 给 180ms 让鼠标移进气泡里（里面的需求ID要能点）
      impactTimer = setTimeout(() => { const pop = document.getElementById('impactPop'); if (pop) pop.style.display = 'none' }, 180)
    }

    function bindImpactPop() {
      const pop = document.getElementById('impactPop')
      if (!pop) return
      pop.addEventListener('mouseenter', () => clearTimeout(impactTimer))
      pop.addEventListener('mouseleave', hideImpactPop)
    }

    function saveCollapsed() {
      localStorage.setItem(LS_COLLAPSED, JSON.stringify([...state.collapsedItems]))
      localStorage.setItem(LS_EXPANDED_RELEASED, JSON.stringify([...state.expandedReleased]))
    }

    function saveSectionExpanded() {
      localStorage.setItem(LS_SECTION_EXPANDED, JSON.stringify(state.sectionExpanded))
    }

    function loadCardUiState() {
      try { state.collapsedItems = new Set(JSON.parse(localStorage.getItem(LS_COLLAPSED)) || []) } catch { state.collapsedItems = new Set() }
      try { state.expandedReleased = new Set(JSON.parse(localStorage.getItem(LS_EXPANDED_RELEASED)) || []) } catch { state.expandedReleased = new Set() }
      try {
        const se = JSON.parse(localStorage.getItem(LS_SECTION_EXPANDED))
        if (se && typeof se === 'object') state.sectionExpanded = { ...state.sectionExpanded, ...se }
      } catch {}
    }

    function openMrUrl(url) {
      if (url) window.open(url, '_blank')
    }

    // ===== Return everything exposed to template =====
    return {
      state,
      sections, releasingProjects, filteredBranchList, batchSelection, dailyExistsCount,
      guideSteps, currentGuideStep, guideSpotlightStyle, guideTooltipStyle,
      escHtml, truncateBranch, selfWorkItemId, getProjectInfo, getColorIdx,
      buildMrUrl, buildBranchUrl, formatReleaseTime, newId,
      statusLabel, statusClass,
      copyText, exportToFile, importFromFile,
      backupToProject, openBackupDialog, loadBackups, restoreBackup, deleteBackup, revealBackupDir,
      addProject, removeProject, saveProjectEdit,
      startAdding, saveAdding, startEdit, saveEdit, cancelEdit,
      changeStatus, releaseItem, confirmLaunch, releaseAllToDone,
      toggleItemSelected, clearBatchSelection, batchSetPending, batchReleaseSelected,
      openBatchBranchDialog, openAllDailyBranchPages, startDailyBranchCheck,
      stopDailyBranchCheck, runDailyBranchCheck, dailyStatusLabel,
      startPageGuide, closePageGuide, nextPageGuide, prevPageGuide,
      showConfirm, doDelete,
      clickBranch,
      openNoteDialog, openInlineNoteForEdit, closeNote, saveNote,
      showCtxMenu, ctxEditNote, ctxClearNote, closeCtxMenu,
      showProjDropdown, hideProjDropdown, filterDropdown, selectProjDropdown,
      openBranchLookup, selectBranchFill, fetchAllBranches,
      dismissReminder, exportAndDismiss, saveLaunchBranch, toggleSection, openMrUrl,
      // v2：分支索引与关联
      refreshBranchIndex, branchOtherIds, impactIds, triageBranchGroup, restoreBranchTriage, deriveRepoUrl,
      setOnlyMine, autoSuggestions, adoptSuggestion,
      // v2：需求卡片的折叠 / 排序 / 影响面气泡
      itemKey, isItemCollapsed, toggleItemCollapse, expandSectionCards, collapseSectionCards,
      branchCountLabel, toggleSortMode,
      onDragStart, onGridDragOver, onGridDrop, onDragEnd,
      showImpactPop, hideImpactPop,
      // v2：飞书项目同步
      openSyncSettings, openSyncDialog, selectSpace, toggleType, saveSyncSettings, loadTypes,
      fetchMeegleItems, toggleSyncRow, selectAllNew, applySync, matchesOf, pickPrimaryMatches,
      setExcludeStatuses,
      // Aliases for template
      searchQuery: computed({ get: () => state.searchQuery, set: v => { state.searchQuery = v.toLowerCase() } }),
      sortMode: computed(() => state.sortMode),
      launchBranch: computed({ get: () => state.launchBranch, set: v => { state.launchBranch = v } }),
      items: computed(() => state.items),
      projectNames: computed(() => state.projectNames),
      editingIds: computed(() => state.editingIds),
      selectedIds: computed(() => state.selectedIds),
      batchBranchDialog: computed(() => state.batchBranchDialog),
      dailyBranchCheck: computed(() => state.dailyBranchCheck),
      pageGuide: computed(() => state.pageGuide),
      addingItems: computed({ get: () => state.addingItems, set: v => { state.addingItems = v } }),
      pmExpanded: computed({ get: () => state.pmExpanded, set: v => { state.pmExpanded = v } }),
      editProjectIdx: computed({ get: () => state.editProjectIdx, set: v => { state.editProjectIdx = v } }),
      editProjectName: computed({ get: () => state.editProjectName, set: v => { state.editProjectName = v } }),
      editProjectMr: computed({ get: () => state.editProjectMr, set: v => { state.editProjectMr = v } }),
      editProjectPath: computed({ get: () => state.editProjectPath, set: v => { state.editProjectPath = v } }),
      newProjectName: computed({ get: () => state.newProjectName, set: v => { state.newProjectName = v } }),
      newProjectMr: computed({ get: () => state.newProjectMr, set: v => { state.newProjectMr = v } }),
      newProjectPath: computed({ get: () => state.newProjectPath, set: v => { state.newProjectPath = v } }),
      toastMsg: computed(() => state.toastMsg),
      toastShow: computed(() => state.toastShow),
      showReminder: computed(() => state.showReminder),
      branchProgress: computed(() => state.branchProgress),
      confirmDialog: computed(() => state.confirmDialog),
      launchDialog: computed(() => state.launchDialog),
      noteDialog: computed(() => state.noteDialog),
      branchModal: computed(() => state.branchModal),
      allBranchesModal: computed(() => state.allBranchesModal),
      ctxMenu: computed(() => state.ctxMenu),
      projDropdown: computed(() => state.projDropdown),
      // v2 别名
      unregisteredGroups,
      triagedGroups,
      triagedProjects,
      openTriagedDetail,
      restoreOneTriage,
      triagedDialog: computed(() => state.triagedDialog),
      isWideItem,
      wideItemTitle,
      branchTotal,
      filteredUnregGroups,
      filteredTriagedGroups,
      branchIndex: computed(() => state.branchIndex),
      branchTriage: computed(() => state.branchTriage),
      indexBusy: computed(() => state.indexBusy),
      indexProgress: computed(() => state.indexProgress),
      unregExpanded: computed({ get: () => state.unregExpanded, set: v => { state.unregExpanded = v } }),
      unregKeyword: computed({ get: () => state.unregKeyword, set: v => { state.unregKeyword = v } }),
      indexDiagnostics,
      portShifted,
      apiPort: computed(() => api.port),
      loadAppVersion, checkUpdate,
      appVersion: computed(() => state.appVersion),
      updateBusy: computed(() => state.updateBusy),
      indexConfig: computed(() => state.indexConfig),
      indexNotMineTotal,
      // v2 飞书同步别名
      meegleConfig: computed(() => state.meegleConfig),
      meegleStatus: computed(() => state.meegleStatus),
      syncSettings: computed(() => state.syncSettings),
      syncDialog: computed(() => state.syncDialog),
      backupDialog: computed(() => state.backupDialog),
      syncRaw: computed(() => state.syncRaw),
      syncSelection: computed(() => state.syncSelection),
      syncRows,
      syncGroups,
      toggleGroup,
      toggleGroupCollapse,
      syncIndexHint,
      syncSelectedCount,
      syncHiddenSelectedCount,
      syncCollapsed: computed(() => state.syncCollapsed),
    }
  }
}).mount('#app')
