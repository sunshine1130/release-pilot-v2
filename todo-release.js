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
const api = { port: DEFAULT_API_PORT }

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
        // 已完成的需求不该出现在发版清单里。实测 ly_oms 的 story 表 805 条中
        // 已结束 335 + 已上线 412，真正还在流程中的只有 58 条 —— 不排除的话，
        // 拉回来的绝大部分是废数据，还会把 maxPerType 的额度占满。
        excludeStatuses: ['已结束', '已上线'],
      },
      syncSettings: { visible: false, loading: false, error: '', spaces: [], types: [] },
      syncDialog: { visible: false, loading: false, error: '', perType: [], errors: [], keyword: '', onlyUnregistered: false },
      syncRaw: [],
      syncSelection: {},
      // 状态分组里被手动收起的那些（默认全部展开：要勾选就得先看得见）
      syncCollapsed: {},
      // 分支索引只保留自己创建的分支：同事的分支混进未登记列表与匹配结果纯是噪声
      indexConfig: { onlyMine: true }
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
      if (releasing.length > 0) state.sectionExpanded.releasing = true
      return [
        { key: 'pending', title: '待发版', items: pending, expanded: state.sectionExpanded.pending, empty: '暂无待发版需求' },
        { key: 'releasing', title: '发版中', items: releasing, expanded: state.sectionExpanded.releasing, empty: '暂无发版中需求' },
        { key: 'released', title: '已发版', items: released, expanded: state.sectionExpanded.released, empty: '暂无已发版需求' }
      ]
    })

    const releasingProjects = computed(() => {
      const set = new Map()
      const releasing = state.items.filter(i => i.status === 'releasing')
      releasing.forEach(item => {
        if (item.projects) item.projects.forEach(p => { if (p.name && !set.has(p.name)) set.set(p.name, !!getProjectInfo(p.name)?.mr) })
        if (item.syncBranches) item.syncBranches.forEach(sb => { if (sb.project && !set.has(sb.project)) set.set(sb.project, !!getProjectInfo(sb.project)?.mr) })
      })
      return [...set.entries()].map(([name, hasMr]) => {
        const info = getProjectInfo(name)
        const srcBranch = state.launchBranch || findItemTargetBranch(name) || 'master_launched'
        return { name, url: hasMr && info ? buildMrUrl(info.mr, srcBranch, 'master') : null }
      })
    })

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

    function truncateUrl(url) {
      if (!url) return ''
      return url.length > 32 ? url.substring(0, 32) + '...' : url
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

    function buildBranchUrl(mrBase, refBranch) {
      if (!mrBase) return ''
      const ref = refBranch || 'master'
      const now = new Date()
      const mm = String(now.getMonth() + 1).padStart(2, '0')
      const dd = String(now.getDate()).padStart(2, '0')
      const branchName = 'master_' + mm + dd
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
      toastTimer = setTimeout(() => { state.toastShow = false }, 1600)
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
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result)
          setFullData(data)
          saveToLocalStorage()
          saveLaunchBranch()
          saveBranchCache()
          state.editingIds = {}
          state.addingItems = []
          state.addingCounter = 0
          state.editProjectIdx = -1
          toast('已导入 ' + state.items.length + ' 条需求')
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

    function changeStatus(item, newStatus) {
      if (newStatus === 'releasing') {
        item.releaseTime = formatReleaseTime()
      } else if (newStatus === 'released') {
        item.releaseTime = formatReleaseTime()
      } else if (newStatus === 'pending') {
        delete item.releaseTime
      }
      item.status = newStatus
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
        const pending = state.items.filter(i => i.status === 'pending')
        const releaseTime = formatReleaseTime()
        pending.forEach(i => { i.status = 'releasing'; i.releaseTime = releaseTime; i.targetBranches = targetBranches })
        saveToLocalStorage()
        toast('已全部开始发版（' + pending.length + ' 条）')
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

    function showConfirm(item) { state.confirmDialog = { item } }

    function doDelete() {
      if (!state.confirmDialog.item) return
      const item = state.confirmDialog.item
      const name = item.name
      state.items = state.items.filter(i => i !== item)
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
      const target = statusTarget || state.launchBranch || (item.targetBranches && item.targetBranches[projectName]) || null
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

    function exportAndDismiss() {
      exportToFile()
      dismissReminder()
    }

    // ===== Keyboard =====
    function handleKeydown(e) {
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
     * （/xxx/story/detail/7134246577）。不这样做的话，影响面提示对历史需求全部失效，
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
    // （实测 ly_oms 有 OMS/SCM/TMS/BMS/BD/仓库/优化/架构运维/AI 共 10 张），
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

    /** 提取文本里的 10 位需求ID（带数字边界，避免 7101366806 命中 17101366806） */
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

    function isExistingRequirement(workItemId) {
      return state.items.some(it => selfWorkItemId(it) === workItemId)
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

    /** 点建议即把该分支挂到本需求：同一项目已填了分支时不覆盖，只提示去右键菜单换 */
    function adoptSuggestion(item, s) {
      const list = item.projects || (item.projects = [])
      const same = list.find(p => p.name === s.project)
      if (!same) list.push({ name: s.project, branch: s.branch, notes: '' })
      else if (!same.branch) same.branch = s.branch
      else { toast(`${s.project} 下已有分支，请用右键菜单更换`); return }
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
        toast('未登录飞书项目，请在终端执行：meegle auth login --host ' + (st.host || 'project.feishu.cn'))
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
     * 「为什么没匹配到分支」的说明。
     *
     * 逐行显示「未匹配到分支」会把一个全局前置条件问题伪装成单条需求的事实 ——
     * 用户看到 7134246577 明明在 pms-web 有分支却显示未匹配，第一反应只会是工具坏了。
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
      const picked = syncRows.value.filter(r => state.syncSelection[r.workItemId] && r.isNew)
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

    onMounted(async () => {
      // 端口必须在任何接口调用之前确定，否则会打到别的进程上（旧引擎不写端口文件，退回默认值）
      await resolveApiPort()

      // Load data
      const loaded = await loadFromJsonFile()
      if (!loaded) {
        try { state.projectNames = JSON.parse(localStorage.getItem('todo_project_names')) || [] } catch { state.projectNames = [] }
        try { state.items = JSON.parse(localStorage.getItem('todo_release_data')) || [] } catch { state.items = [] }
        try { state.branchesCache = JSON.parse(localStorage.getItem('todo_branch_cache')) || {} } catch { state.branchesCache = {} }
        state.launchBranch = localStorage.getItem('todo_launch_branch') || ''
      }

      // v2 的三个键始终从 localStorage 读：toDo.json 里没有它们，
      // 不能因为「已从 json 加载」就跳过，否则人工处置记录每次刷新都会丢
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

      checkDailyReminder()
      autoFetchBranches()
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
    }

    function openMrUrl(url) {
      if (url) window.open(url, '_blank')
    }

    // ===== Return everything exposed to template =====
    return {
      state,
      sections, releasingProjects, filteredBranchList,
      escHtml, truncateBranch, truncateUrl, getProjectInfo, getColorIdx,
      buildMrUrl, buildBranchUrl, formatReleaseTime, newId,
      statusLabel, statusClass,
      copyText, exportToFile, importFromFile,
      addProject, removeProject, saveProjectEdit,
      startAdding, saveAdding, startEdit, saveEdit, cancelEdit,
      changeStatus, releaseItem, confirmLaunch, releaseAllToDone,
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
      // v2：飞书项目同步
      openSyncSettings, openSyncDialog, selectSpace, toggleType, saveSyncSettings, loadTypes,
      fetchMeegleItems, toggleSyncRow, selectAllNew, applySync, matchesOf, pickPrimaryMatches,
      setExcludeStatuses,
      // Aliases for template
      searchQuery: computed({ get: () => state.searchQuery, set: v => { state.searchQuery = v.toLowerCase() } }),
      launchBranch: computed({ get: () => state.launchBranch, set: v => { state.launchBranch = v } }),
      items: computed(() => state.items),
      projectNames: computed(() => state.projectNames),
      editingIds: computed(() => state.editingIds),
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
      filteredUnregGroups,
      filteredTriagedGroups,
      branchIndex: computed(() => state.branchIndex),
      branchTriage: computed(() => state.branchTriage),
      indexBusy: computed(() => state.indexBusy),
      indexProgress: computed(() => state.indexProgress),
      unregExpanded: computed({ get: () => state.unregExpanded, set: v => { state.unregExpanded = v } }),
      unregKeyword: computed({ get: () => state.unregKeyword, set: v => { state.unregKeyword = v } }),
      indexConfig: computed(() => state.indexConfig),
      indexNotMineTotal,
      // v2 飞书同步别名
      meegleConfig: computed(() => state.meegleConfig),
      meegleStatus: computed(() => state.meegleStatus),
      syncSettings: computed(() => state.syncSettings),
      syncDialog: computed(() => state.syncDialog),
      syncRaw: computed(() => state.syncRaw),
      syncSelection: computed(() => state.syncSelection),
      syncRows,
      syncGroups,
      toggleGroup,
      toggleGroupCollapse,
      syncIndexHint,
      syncSelectedCount,
      syncCollapsed: computed(() => state.syncCollapsed),
    }
  }
}).mount('#app')
