const { createApp, reactive, computed, watch, nextTick, onMounted } = Vue
const API_PORT = 1949
const JSON_FILENAME = 'toDo.json'

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
      sectionExpanded: { pending: true, releasing: false, released: false }
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
      return { projectNames: state.projectNames, items: state.items, branchesCache: state.branchesCache, launchBranch: state.launchBranch }
    }

    function setFullData(data) {
      if (data && Array.isArray(data.projectNames)) state.projectNames = data.projectNames
      if (data && Array.isArray(data.items)) state.items = data.items
      if (data && data.branchesCache && typeof data.branchesCache === 'object') state.branchesCache = data.branchesCache
      if (data && typeof data.launchBranch === 'string') state.launchBranch = data.launchBranch
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
        const resp = await fetch('http://localhost:' + API_PORT + '/api/git-user')
        if (!resp.ok) { toast('请先启动服务器: node server.js'); return }
      } catch { toast('请先启动服务器: node server.js'); return }

      toast('正在获取分支...')

      let gitUser = null
      try {
        const userRes = await fetch('http://localhost:' + API_PORT + '/api/git-user')
        const userData = await userRes.json()
        gitUser = userData.user
      } catch {}

      let branches = []
      try {
        const url = `http://localhost:${API_PORT}/api/branches?path=${encodeURIComponent(project.localPath)}&user=${encodeURIComponent(gitUser || '')}`
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
        const resp = await fetch('http://localhost:' + API_PORT + '/api/git-user')
        if (!resp.ok) throw new Error()
      } catch { toast('请先启动服务器: node server.js'); return }

      let gitUser = null
      try {
        const userRes = await fetch('http://localhost:' + API_PORT + '/api/git-user')
        const userData = await userRes.json()
        gitUser = userData.user
      } catch {}

      toast('正在获取分支...')
      state.allBranchesModal = { visible: true, projects: [], search: '', loading: true, releasedSet: getReleasedBranchSet() }

      const results = []
      for (const project of projectsWithPath) {
        try {
          const url = `http://localhost:${API_PORT}/api/branches?path=${encodeURIComponent(project.localPath)}&user=${encodeURIComponent(gitUser || '')}`
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
        const resp = await fetch('http://localhost:' + API_PORT + '/api/git-user')
        if (!resp.ok) return
      } catch { return }

      let gitUser = null
      try {
        const userRes = await fetch('http://localhost:' + API_PORT + '/api/git-user')
        const userData = await userRes.json()
        gitUser = userData.user
      } catch {}

      state.branchProgress = { visible: true, done: 0, total: projectsWithPath.length }
      let done = 0
      for (const project of projectsWithPath) {
        try {
          const url = `http://localhost:${API_PORT}/api/branches?path=${encodeURIComponent(project.localPath)}&user=${encodeURIComponent(gitUser || '')}`
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
        if (state.searchQuery) state.searchQuery = ''
      }
    }

    // ===== Lifecycle =====
    document.addEventListener('keydown', handleKeydown)
    document.addEventListener('click', () => { if (state.ctxMenu.visible) closeCtxMenu() })

    onMounted(async () => {
      // Load data
      const loaded = await loadFromJsonFile()
      if (!loaded) {
        try { state.projectNames = JSON.parse(localStorage.getItem('todo_project_names')) || [] } catch { state.projectNames = [] }
        try { state.items = JSON.parse(localStorage.getItem('todo_release_data')) || [] } catch { state.items = [] }
        try { state.branchesCache = JSON.parse(localStorage.getItem('todo_branch_cache')) || {} } catch { state.branchesCache = {} }
        state.launchBranch = localStorage.getItem('todo_launch_branch') || ''
      }
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
      projDropdown: computed(() => state.projDropdown)
    }
  }
}).mount('#app')
