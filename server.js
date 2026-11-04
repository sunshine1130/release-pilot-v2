/**
 * 发版小助手 v2 · 本地引擎
 *
 * 职责边界：只做「取数据、转 JSON」，不含任何业务判断。
 * 去重、需求↔分支关联、未登记分支判定全部在前端 —— 因为只有前端持有全量数据，
 * 放在服务端会形成第二份状态，两边迟早不一致。
 *
 * 数据通道有两条，刻意保留双通道：
 *   1) 本地 git 通道（v1 既有）—— 有本地 clone 时最省事，还能拿到作者/日期
 *   2) GitLab 直读通道（v2 新增）—— 只需仓库地址，不用 clone、不用配本地路径
 * 两条通道互不替代：项目没 clone 时只有第二条可用。
 *
 * 运行：node server.js            （默认端口 1949，占用则自动 +1）
 *      NO_OPEN=1 node server.js   （不自动打开浏览器，便于自动化测试）
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const url = require('url')
const { execFile, exec } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const PORT = 1949
const BASE_DIR = __dirname
const SERVER_PORT_FILE = path.join(BASE_DIR, '.server-port')

/** git 调用默认超时；远端仓库凭据异常时不能让请求无限挂起 */
const GIT_TIMEOUT_MS = 15000
/** 单次 git 输出上限，与 v1 保持一致（大仓库的 for-each-ref 可能很大） */
const GIT_MAX_BUFFER = 50 * 1024 * 1024
/** 分支索引缓存 TTL：分支一直在长，实测同一条分支两天内需求覆盖就会变，不能永久缓存 */
const INDEX_TTL_MS = 10 * 60 * 1000
/** 单分支 first-parent 提交数上限，超过则跳过需求ID提取（避免超大集成分支拖垮刷新） */
const DEFAULT_MAX_COMMITS = 500
/** 单仓库参与索引的分支数上限，防止异常仓库把请求拖死 */
const DEFAULT_MAX_BRANCHES = 300

// ===== 通用响应 =====

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 统一错误出口：前端一律读 body.code 判定，不看 HTTP status（与公司后端习惯一致） */
function fail(res, code, message, status = 400) {
  json(res, { error: message, code }, status)
}

// ===== 进程内缓存 =====

const cacheStore = new Map()

function cacheGet(key, ttlMs) {
  const hit = cacheStore.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > ttlMs) {
    cacheStore.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key, value) {
  cacheStore.set(key, { value, at: Date.now() })
}

// ===== 外部进程调用 =====

/**
 * 执行 git 命令。
 *
 * 三个约束都是踩过的坑，不要简化：
 *   - 必须走 execFile 数组参数（绝不拼字符串），否则仓库名/分支名里的特殊字符会变成参数注入
 *   - 必须设 GIT_TERMINAL_PROMPT=0：远端缺凭据时 git 会交互式等待输入，请求会永久挂起
 *   - 必须带 timeout：网络异常时同样会挂住
 */
async function runGit(args, cwd, timeoutMs = GIT_TIMEOUT_MS) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout
  } catch (err) {
    throw normalizeGitError(err)
  }
}

function normalizeGitError(err) {
  const stderr = String(err.stderr || '')
  if (err.code === 'ENOENT') {
    return { code: 'GIT_NOT_FOUND', message: '未检测到 git，请先安装 Git for Windows' }
  }
  if (err.killed || err.signal === 'SIGTERM') {
    return { code: 'GIT_TIMEOUT', message: `git 调用超时（${GIT_TIMEOUT_MS}ms）` }
  }
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(stderr)) {
    return { code: 'GIT_AUTH_REQUIRED', message: '该仓库需要凭据，且当前进程不允许交互式输入' }
  }
  return { code: 'GIT_FAILED', message: stderr.trim().split('\n')[0] || err.message }
}

/**
 * 定位 meegle CLI 的真实入口脚本。
 *
 * 不能直接 spawn meegle.cmd：Windows 上执行 .cmd 必须过 cmd.exe，而 cmd 会把
 * 参数里的 % 当变量展开。MQL 里 LIKE '%xxx%' 和反引号都常出现，一过 shell 就被改坏。
 * 这里改为用 node 直接跑 CLI 的入口 js，参数原样传递。
 */
function resolveMeegleEntry() {
  const candidates = [
    process.env.MEEGLE_JS,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm/node_modules/@lark-project/meegle/bin/meegle.js') : null,
    'C:/Program Files/nodejs/node_global/node_modules/@lark-project/meegle/bin/meegle.js',
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {}
  }
  return null
}

/** 执行 meegle CLI；拿不到入口脚本时退回 .cmd（能用但有 shell 转义风险，仅作兜底） */
async function runMeegle(args, timeoutMs = 90000) {
  const entry = resolveMeegleEntry()
  const [bin, argv] = entry
    ? [process.execPath, [entry, ...args]]
    : [process.platform === 'win32' ? 'meegle.cmd' : 'meegle', args]

  try {
    const { stdout } = await execFileAsync(bin, argv, {
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      shell: !entry && process.platform === 'win32',
    })
    return stdout
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw { code: 'MEEGLE_CLI_MISSING', message: '未检测到 meegle CLI，请先安装并登录飞书项目' }
    }
    if (err.killed || err.signal === 'SIGTERM') {
      throw { code: 'MEEGLE_TIMEOUT', message: `meegle 调用超时（${timeoutMs}ms）` }
    }
    const stderr = String(err.stderr || err.message || '')
    throw { code: 'MEEGLE_QUERY_FAILED', message: extractMeegleError(stderr) || 'meegle 调用失败' }
  }
}

// ===== 飞书项目（Meegle） =====

/** CLI 输出可能夹带日志前缀，截到第一个 { 或 [ 再解析 */
function safeJsonParse(text) {
  const s = String(text)
  const i = s.search(/[[{]/)
  if (i < 0) return null
  try {
    return JSON.parse(s.slice(i))
  } catch {
    return null
  }
}

/**
 * 从 CLI 输出里挖出可读的错误原因。
 *
 * CLI 失败时会把整段 JSON 错误写到 stderr，第一行只有一个 `{`；
 * 直接取首行会得到一个毫无信息量的「{」，排查时完全没用（实测踩过）。
 * 所以优先解析 JSON 取 message，其次挑一条有内容的行。
 */
function extractMeegleError(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  const parsed = safeJsonParse(text)
  if (parsed) {
    const e = parsed.error || parsed.err_msg
    if (typeof e === 'string' && e) return e
    if (e && typeof e === 'object') return e.message || e.code || JSON.stringify(e)
  }
  const line = text
    .split('\n')
    .map(l => l.trim())
    .find(l => l && l !== '{' && l !== '}' && l !== '[' && l !== ']')
  return (line || text).slice(0, 400)
}

async function meegleJson(args) {
  const out = await runMeegle([...args, '--format', 'json'])
  const data = safeJsonParse(out)
  if (data === null) throw { code: 'MEEGLE_QUERY_FAILED', message: '飞书项目返回内容无法解析为 JSON' }
  // CLI 把业务失败也包在正常退出里，必须看 err_msg / error 字段
  const err = data.err_msg || data.error
  if (err) throw { code: 'MEEGLE_QUERY_FAILED', message: extractMeegleError(JSON.stringify(err)) || '飞书项目返回错误' }
  return data
}

/**
 * 取某类型「需求状态」的可选值。
 *
 * 这一步不能省：状态名是**每个工作项类型各自一套**的，MQL 里写了该类型不存在的状态值
 * 会直接报 metadata error（Code 3011），而不是匹配为空。实测 story 有 34 个状态（含「已上线」），
 * oms 只有 17 个、没有「已上线」—— 共用一份排除清单必然炸掉其中一个类型。
 * 状态枚举极少变动，缓存 1 小时。
 */
async function meegleStatusOptions(projectKey, typeApiName) {
  const cacheKey = `statusopt:${projectKey}:${typeApiName}`
  const hit = cacheGet(cacheKey, 60 * 60 * 1000)
  if (hit) return hit
  const data = await meegleJson([
    'workitem', 'meta-fields',
    '--project-key', projectKey,
    '--work-item-type', typeApiName,
    '--field-keys', '["work_item_status"]',
  ])
  const field = ((data.data && data.data.list) || data.list || [])[0] || {}
  const names = (field.option || []).map(o => o.option_name).filter(Boolean)
  cacheSet(cacheKey, names)
  return names
}

async function meegleStatus() {
  const data = await meegleJson(['auth', 'status'])
  return data
}

async function meegleSpaces() {
  const data = await meegleJson(['project', 'search'])
  const list = (data.data && data.data.projects) || data.projects || []
  return list.map(p => ({ projectKey: p.project_key, simpleName: p.simple_name, name: p.name }))
}

async function meegleTypes(projectKey) {
  const data = await meegleJson(['workitem', 'meta-types', '--project-key', projectKey])
  const list = (data.data && data.data.list) || data.list || []
  return list.map(t => ({ apiName: t.api_name, typeKey: t.type_key, name: t.name, disabled: t.is_disable === 1 }))
}

/** 从 moql_field_list 里取字段值：结构是 { value_type, value: { string_value | long_value | key_label_value_list } } */
function readMoqlField(fieldList, key) {
  const f = (fieldList || []).find(x => x.key === key)
  if (!f || !f.value) return null
  const v = f.value
  if (v.string_value !== undefined) return v.string_value
  if (v.long_value !== undefined) return v.long_value
  if (v.key_label_value_list) return v.key_label_value_list.map(x => x.label).filter(Boolean).join(' / ')
  return null
}

async function meegleQueryPage({ projectKey, mql, sessionId, groupId, pageNum }) {
  if (mql) {
    return meegleJson(['workitem', 'query', '--project-key', projectKey, '--mql', mql])
  }
  // 翻页时不能再传 --mql，否则服务端会当成新查询重跑、翻页参数被忽略
  return meegleJson([
    'workitem', 'query',
    '--project-key', projectKey,
    '--session-id', sessionId,
    '--group-pagination-list', JSON.stringify([{ group_id: groupId, page_num: pageNum }]),
  ])
}

/**
 * 跨多个工作项类型拉需求。
 *
 * 为什么要跨类型：一个空间里「需求管理」类工作项是**按业务域拆成独立表**的
 * （实测 ly_oms 有 OMS/SCM/TMS/BMS/BD/仓库/优化/架构运维/AI 共 10 个），
 * 只查其中一张会静默漏掉其他域的全部需求 —— 而这正是发版要收集的东西。
 */
async function meegleQueryAll({ projectKey, simpleName, types, mqlTemplate, excludeStatuses, maxPerType }) {
  const items = []
  const perType = []
  const errors = []
  const pageSize = 50

  // 用户想排除的状态（如「已结束」「已上线」）。是否真的能用于某个类型，
  // 要跟该类型自己的状态枚举取交集后再决定 —— 见 meegleStatusOptions 的说明。
  const wanted = (Array.isArray(excludeStatuses) ? excludeStatuses : [])
    .map(s => String(s).trim())
    .filter(Boolean)

  for (const t of types) {
    let applied = []
    if (wanted.length) {
      try {
        const options = await meegleStatusOptions(projectKey, t.apiName)
        // options 为空说明没取到枚举，此时宁可不过滤，也不要硬套导致整类型查询失败
        applied = options.length ? wanted.filter(s => options.includes(s)) : []
      } catch {
        applied = []
      }
    }
    const statusFilter = applied.length
      ? ` WHERE \`work_item_status\` NOT IN (${applied.map(s => `'${s.replace(/['"\\]/g, '')}'`).join(',')})`
      : ''

    const mql = String(mqlTemplate)
      .replace(/\{space\}/g, simpleName)
      .replace(/\{type\}/g, t.typeKey)
      .replace(/\{statusFilter\}/g, statusFilter)
    try {
      const first = await meegleQueryPage({ projectKey, mql })
      const groups = (first.list && first.list[0] && first.list[0].group_infos) || [{ group_id: '1' }]
      const groupId = groups[0] && groups[0].group_id ? groups[0].group_id : '1'
      const count = (first.list && first.list[0] && first.list[0].count) || 0
      const sessionId = first.session_id

      let fetched = 0
      const collect = page => {
        const data = page.data || {}
        for (const key of Object.keys(data)) {
          for (const row of data[key] || []) {
            const workItemId = readMoqlField(row.moql_field_list, 'work_item_id')
            if (workItemId === null) continue
            items.push({
              workItemId: String(workItemId),
              name: readMoqlField(row.moql_field_list, 'name') || '',
              status: readMoqlField(row.moql_field_list, 'work_item_status') || '',
              workItemType: t.apiName,
              workItemTypeName: t.name,
              link: `https://project.feishu.cn/${simpleName}/${t.apiName}/detail/${workItemId}`,
            })
            fetched++
          }
        }
      }
      collect(first)

      const maxPages = Math.min(Math.ceil(count / pageSize), Math.ceil(maxPerType / pageSize))
      for (let page = 2; page <= maxPages && fetched < maxPerType; page++) {
        const next = await meegleQueryPage({ projectKey, sessionId, groupId, pageNum: page })
        const before = fetched
        collect(next)
        if (fetched === before) break // 拿不到新数据就停，避免无意义翻页
      }

      perType.push({ apiName: t.apiName, name: t.name, count, fetched, excluded: applied })
    } catch (e) {
      // 单个类型失败不影响其他类型：某个域没权限时不该让整次同步全废
      errors.push({ apiName: t.apiName, name: t.name, message: e.message || String(e) })
    }
  }

  return { items, perType, errors }
}

async function handleMeegleStatus(req, res) {
  try {
    json(res, await meegleStatus())
  } catch (err) {
    fail(res, err.code || 'MEEGLE_QUERY_FAILED', err.message || '无法获取飞书项目登录状态', 500)
  }
}

async function handleMeegleSpaces(req, res) {
  try {
    json(res, { spaces: await meegleSpaces() })
  } catch (err) {
    fail(res, err.code || 'MEEGLE_QUERY_FAILED', err.message || '无法获取飞书项目空间列表', 500)
  }
}

async function handleMeegleTypes(req, res, query) {
  const projectKey = query.get('projectKey')
  if (!projectKey) return fail(res, 'BAD_REQUEST', '缺少 projectKey 参数')
  try {
    json(res, { types: await meegleTypes(projectKey) })
  } catch (err) {
    fail(res, err.code || 'MEEGLE_QUERY_FAILED', err.message || '无法获取工作项类型', 500)
  }
}

async function handleMeegleQuery(req, res) {
  const body = await readJsonBody(req)
  const { projectKey, simpleName, types, mqlTemplate, excludeStatuses, maxPerType } = body || {}
  if (!projectKey) return fail(res, 'BAD_REQUEST', '缺少 projectKey')
  if (!Array.isArray(types) || !types.length) return fail(res, 'BAD_REQUEST', '至少选择一种工作项类型')
  if (!mqlTemplate || !/\{type\}/.test(mqlTemplate)) {
    return fail(res, 'BAD_REQUEST', 'MQL 模板必须包含 {space} 与 {type} 占位符')
  }
  try {
    const result = await meegleQueryAll({
      projectKey,
      simpleName: simpleName || projectKey,
      types,
      mqlTemplate,
      excludeStatuses,
      maxPerType: Number(maxPerType) > 0 ? Number(maxPerType) : 200,
    })
    json(res, result)
  } catch (err) {
    fail(res, err.code || 'MEEGLE_QUERY_FAILED', err.message || '拉取飞书需求失败', 500)
  }
}

/** 读取 POST body；限制大小防止异常请求把内存打满 */
function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise(resolve => {
    let raw = ''
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limitBytes) {
        resolve(null)
        req.destroy()
        return
      }
      raw += chunk
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

// ===== 分支过滤与需求ID提取 =====

/**
 * 环境/临时分支排除规则。
 *
 * 刻意不用「任意前缀 + 环境词」这种通用写法：那会把 latest（la+test）、
 * contrast 之类的正常分支误判成环境分支。实测需要排除的是下面这些固定形态，
 * 新形态出现时在这里补一条，比放宽正则安全。
 */
const ENV_BRANCH_PATTERNS = [
  /^(master|test|dev|main|release|staging|hotfix|uat)(\b|_)/i, // v1 既有规则
  /^(mdm)?(dev|uat|test|touat)$/i, // 实测每仓都存在的环境分支：mdmdev/mdmuat/mdmtest/mdmtouat
  /_old$/i,
  /_copy$/i,
  /^(copy|复制)分支$/,
]

function isEnvBranch(name) {
  return ENV_BRANCH_PATTERNS.some(re => re.test(name))
}

/**
 * 从提交标题里提取需求ID。
 *
 * 必须带数字边界：不同长度的 ID 可能互为子串（如 7101366806 出现在 17101366806 里），
 * 不加边界会关联到别人身上。
 */
const REQ_ID_RE = /(^|[^0-9])([0-9]{10})([^0-9]|$)/g

function extractReqIds(text) {
  const ids = []
  const seen = new Set()
  for (const line of String(text).split('\n')) {
    REQ_ID_RE.lastIndex = 0
    let m
    while ((m = REQ_ID_RE.exec(line)) !== null) {
      const id = m[2]
      if (!seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
  }
  return ids
}

// ===== GitLab 直读通道 =====

function normalizeRepoUrl(repo) {
  if (!repo) return null
  const trimmed = String(repo).trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) return null
  return trimmed
}

async function listRemoteBranches(repo, match) {
  const target = normalizeRepoUrl(repo)
  if (!target) throw { code: 'GIT_REPO_INVALID', message: 'repo 必须是 http(s):// 开头的仓库地址' }
  // '--' 之后的参数一律当位置参数，避免仓库地址被 git 当成选项
  const args = ['ls-remote', '--heads', '--', target]
  if (match) args.push(match)
  const out = await runGit(args, BASE_DIR)
  return out
    .split('\n')
    .map(line => line.split('\t')[1])
    .filter(Boolean)
    .map(ref => ref.replace(/^refs\/heads\//, ''))
}

// ===== 需求↔分支反查（L1） =====

/**
 * 计算「分支 → 覆盖的需求ID」索引。
 *
 * 算法要点（全部是实测教训，改动前请先看 docs/技术文档-关联算法规格.md）：
 *   1. 基线固定为发布主线。实测「在所有主线里取独占提交最少者」是错的 ——
 *      会把基线选到已经吸收了该分支的 dev 上，单个分支从 256 个提交塌缩成 1 个，需求ID 全丢。
 *   2. 必须用 --first-parent。分支之间会互相 merge（如 feat/7101366806 merge 了 feat/mdm三期分支），
 *      不加会把兄弟分支的工作算成自己的。
 *   3. 必须排除基线区间（mb..branch）。直接 log 整个分支会把从 dev/master 继承的上游提交
 *      全算进来，实测一条分支能冒出 9 个别人的需求ID。
 *   4. 独占提交为 0 说明已完全并入主线，不参与关联（否则会把历史分支全捞出来）。
 */
async function computeBranchIndex(cwd, base, maxCommits, maxBranches, remoteNames) {
  if (!fs.existsSync(cwd)) throw { code: 'GIT_PATH_MISSING', message: `本地路径不存在：${cwd}` }
  if (!fs.existsSync(path.join(cwd, '.git'))) throw { code: 'GIT_NOT_REPO', message: `不是 git 仓库：${cwd}` }

  const baseRef = `origin/${base}`
  try {
    await runGit(['rev-parse', '--verify', '--quiet', baseRef], cwd)
  } catch {
    throw { code: 'GIT_BASE_MISSING', message: `仓库中没有 ${baseRef}，请确认发布主线名称` }
  }

  // 只需要分支名、完整 ref 和 tip 的日期（日期顺手取出来，省掉每分支一次 git log -1）
  const refsOut = await runGit(
    ['for-each-ref', '--format=%(refname:short)|%(refname)|%(authordate:short)', 'refs/remotes/origin', 'refs/heads'],
    cwd,
  )

  // 同名分支可能同时存在于本地与远端：优先用 origin/ 那份（远端才是发版依据）
  const refByName = new Map()
  let localOnly = 0
  for (const line of refsOut.split('\n')) {
    const [short, full, date] = line.trim().split('|')
    if (!short || !full) continue
    if (short === 'origin' || short === 'origin/HEAD') continue
    const name = short.replace(/^origin\//, '')
    if (isEnvBranch(name)) continue
    // 本地 origin/* 是「上次 fetch 时的快照」，远端删掉的分支会一直留着：
    // 实测 pms-web 本地 99 个 ref 里 74 个在远端已不存在。这些幽灵分支会混进
    // 未登记列表和关联结果，所以拿到远端真实列表时必须以它为准做交集。
    if (remoteNames && !remoteNames.has(name)) {
      localOnly++
      continue
    }
    const prev = refByName.get(name)
    if (!prev || full.startsWith('refs/remotes/origin/')) refByName.set(name, { ref: full, date: date || '' })
  }

  const branches = []
  const unregistered = []
  let scanned = 0

  for (const [name, info] of refByName) {
    if (scanned >= maxBranches) break
    scanned++
    const { ref, date: lastDate } = info

    // 每个分支只跑一次 git。
    //
    // 区间用 `origin/master..ref` 而不是 merge-base 求出的分叉点，两者结果等价：
    // --first-parent 只沿第一父链前进，而分叉点本身在 master 上可达，遍历到它就被
    // 自然排除，因此与 `mb..ref --first-parent` 完全一致。实测多个分支的提交集合与
    // 提取出的需求ID逐一相同，却省掉了 merge-base 和 rev-list 两次进程调用
    // （28 个分支从 85 次调用降到 29 次，实测耗时约减半）。
    //
    // -n 多取一条是为了判断是否超过上限：既不把超大分支的整段历史拉进内存，
    // 也不会把「刚好等于上限」的分支误判为超限。
    let out
    try {
      out = await runGit(
        ['log', '--first-parent', '-n', String(maxCommits + 1), '--format=%s', `${baseRef}..${ref}`],
        cwd,
      )
    } catch {
      continue // ref 已删除或不可解析 —— 跳过该分支，不算错误
    }

    const lines = out.split('\n').filter(Boolean)

    if (lines.length === 0) {
      // 相对发布主线没有任何独占提交 = 改动已全部进入主线，不参与关联
      branches.push({ name, ids: [], commits: 0, lastDate, merged: true, skipped: false })
      continue
    }

    if (lines.length > maxCommits) {
      // commits 留 null 是有意的：这里根本没数完，报一个数字会是编造的。
      // 前端据此显示「未分析」，与「确实没有需求ID」区分开。
      branches.push({ name, ids: [], commits: null, lastDate, merged: false, skipped: true })
      continue
    }

    const ids = extractReqIds(out)
    branches.push({ name, ids, commits: lines.length, lastDate, merged: false, skipped: false })
    if (ids.length === 0) unregistered.push({ name, commits: lines.length, lastDate })
  }

  branches.sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''))
  unregistered.sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''))

  // 远端存在但本地没有 ref 的分支：分析不了，但要报出来（提示该 fetch 了），
  // 否则会表现为「这条分支明明在 GitLab 上，工具却说没有」。
  const remoteOnly = remoteNames
    ? [...remoteNames].filter(n => !refByName.has(n)).slice(0, 50)
    : []

  return {
    branches,
    unregistered,
    scanned,
    total: refByName.size,
    localOnly, // 被远端列表过滤掉的本地 ref 条数（含 refs/heads 与 refs/remotes 的重复项，仅作诊断用）
    remoteOnly, // 远端有、本地没有的分支名
  }
}

// ===== v1 既有接口（行为保持不变，改动前请确认前端依赖） =====

/** 近 1 个月（v1 函数名叫 getThreeMonthsAgo 但实际减 1 个月，这里保留原行为不改） */
function oneMonthAgoStr() {
  const date = new Date()
  date.setMonth(date.getMonth() - 1)
  return date.toISOString().split('T')[0]
}

async function handleGitUser(req, res) {
  try {
    const out = await execFileAsync('git', ['config', 'user.name'], { encoding: 'utf8', windowsHide: true })
    json(res, { user: out.stdout.trim() })
  } catch {
    json(res, { user: null, error: '无法获取git用户名' })
  }
}

async function handleLocalBranches(req, res, query) {
  const localPath = query.get('path')
  const gitUser = query.get('user')
  if (!localPath) return fail(res, 'BAD_REQUEST', '缺少项目路径参数')

  const fullPath = path.resolve(localPath)
  if (!fs.existsSync(fullPath)) return json(res, { error: '路径不存在', path: fullPath })
  if (!fs.existsSync(path.join(fullPath, '.git'))) return json(res, { error: '不是git仓库', path: fullPath })

  let refOutput
  try {
    refOutput = await runGit(
      [
        'for-each-ref',
        'refs/remotes/origin/',
        'refs/heads/',
        '--format=%(refname:short)|%(objectname:short)|%(authorname)|%(authordate:short)|%(subject)',
        '--sort=-authordate',
        '--count=300',
      ],
      fullPath,
    )
  } catch (err) {
    return json(res, { error: err.message || '无法获取分支列表', path: fullPath })
  }

  const dateStr = oneMonthAgoStr()
  const seen = new Set()
  const branches = []

  for (const line of refOutput.split('\n')) {
    const parts = line.split('|')
    if (parts.length < 5) continue
    const [refName, hash, author, date] = parts.map((s, i) => (i < 4 ? s.trim() : s))
    const message = parts.slice(4).join('|').trim()

    if (isEnvBranch(refName)) continue
    if (refName === 'origin' || refName.startsWith('origin/')) continue
    if (date < dateStr) continue
    if (gitUser && author !== gitUser) continue
    if (seen.has(refName)) continue
    seen.add(refName)

    branches.push({ branch: refName, author, date, message, isRemote: refName.includes('/') })
    void hash
  }

  json(res, { path: fullPath, branches })
}

// ===== v2 新增接口 =====

async function handleRemoteBranches(req, res, query) {
  const repo = query.get('repo')
  const localPath = query.get('path')

  // 二选一：给了 repo 走直读，否则退回本地通道（保持前端可渐进迁移）
  if (!repo) {
    if (localPath) return handleLocalBranches(req, res, query)
    return fail(res, 'BAD_REQUEST', '需要 repo 或 path 参数之一')
  }

  const target = normalizeRepoUrl(repo)
  if (!target) return fail(res, 'GIT_REPO_INVALID', 'repo 必须是 http(s):// 开头的仓库地址')

  const match = query.get('match') || ''
  const force = query.get('refresh') === '1'
  const cacheKey = `branches:${target}:${match}`
  const started = Date.now()

  if (!force) {
    const hit = cacheGet(cacheKey, INDEX_TTL_MS)
    // elapsedMs 必须反映本次请求的真实开销：直接回放上次的耗时会让人误以为缓存没生效
    if (hit) return json(res, { ...hit, cached: true, elapsedMs: Date.now() - started })
  }

  try {
    const names = await listRemoteBranches(target, match)
    const payload = {
      repo: target,
      source: 'ls-remote',
      branches: names
        .filter(n => !isEnvBranch(n))
        .map(n => ({ name: n })),
      cached: false,
      elapsedMs: Date.now() - started,
      computedAt: Date.now(),
    }
    cacheSet(cacheKey, payload)
    json(res, payload)
  } catch (err) {
    fail(res, err.code || 'GIT_FAILED', err.message || '获取远端分支失败', err.code === 'GIT_TIMEOUT' ? 504 : 400)
  }
}

async function handleBranchIndex(req, res, query) {
  const localPath = query.get('path')
  if (!localPath) return fail(res, 'BAD_REQUEST', '缺少 path 参数')

  const fullPath = path.resolve(localPath)
  const repo = normalizeRepoUrl(query.get('repo'))
  const base = query.get('base') || 'master'
  const maxCommits = Number(query.get('maxCommits')) || DEFAULT_MAX_COMMITS
  const maxBranches = Number(query.get('maxBranches')) || DEFAULT_MAX_BRANCHES
  const force = query.get('refresh') === '1'
  // repo 必须进缓存键：带远端过滤与不带的结果不同，两者不能互相命中
  const cacheKey = `index:${fullPath}:${base}:${maxCommits}:${repo || ''}`
  const started = Date.now()

  if (!force) {
    const hit = cacheGet(cacheKey, INDEX_TTL_MS)
    if (hit) return json(res, { ...hit, cached: true, elapsedMs: Date.now() - started })
  }

  try {
    let remoteNames = null
    if (repo) {
      try {
        remoteNames = new Set((await listRemoteBranches(repo)).filter(n => !isEnvBranch(n)))
      } catch {
        // 远端不可达时降级为纯本地分析：提交分析本身不依赖网络，
        // 不该因为拉不到远端分支列表就让整个索引失败
      }
    }

    const result = await computeBranchIndex(fullPath, base, maxCommits, maxBranches, remoteNames)
    const payload = {
      path: fullPath,
      repo: repo || '',
      base: `origin/${base}`,
      remoteFiltered: !!remoteNames,
      ...result,
      cached: false,
      elapsedMs: Date.now() - started,
      computedAt: Date.now(),
    }
    cacheSet(cacheKey, payload)
    json(res, payload)
  } catch (err) {
    const status = err.code === 'GIT_PATH_MISSING' || err.code === 'GIT_NOT_REPO' || err.code === 'GIT_BASE_MISSING' ? 400 : 500
    fail(res, err.code || 'GIT_FAILED', err.message || '计算分支索引失败', status)
  }
}

// ===== 路由表 =====

const ROUTES = {
  'GET /api/git-user': handleGitUser,
  'GET /api/branches': handleLocalBranches,
  'GET /api/git/branches': handleRemoteBranches,
  'GET /api/git/branch-index': handleBranchIndex,
  'GET /api/meegle/status': handleMeegleStatus,
  'GET /api/meegle/spaces': handleMeegleSpaces,
  'GET /api/meegle/types': handleMeegleTypes,
  'POST /api/meegle/query': handleMeegleQuery,
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/todo-release.html' : pathname
  filePath = decodeURIComponent(filePath)
  filePath = path.join(BASE_DIR, filePath)

  // 防目录穿越：必须落在 BASE_DIR 之内
  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'text/plain' })
  res.end(fs.readFileSync(filePath))
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true)
  const pathname = parsed.pathname

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  const handler = ROUTES[`${req.method} ${pathname}`]
  if (handler) {
    try {
      await handler(req, res, new URLSearchParams(parsed.query))
    } catch (err) {
      // 兜底：任何未预期异常都要转成结构化错误，否则前端只会看到连接中断
      if (!res.headersSent) fail(res, err.code || 'INTERNAL_ERROR', err.message || '服务内部错误', 500)
    }
    return
  }

  serveStatic(req, res, pathname)
})

/**
 * 端口漂移修复：v1 在 1949 被占用时会静默换到 1950，
 * 但前端把 1949 写死了，结果是所有请求打空且没有任何提示。
 * 这里把实际端口落盘，前端读该文件即可对上。
 */
function writePortFile(port) {
  try {
    fs.writeFileSync(SERVER_PORT_FILE, String(port), 'utf8')
  } catch {
    /* 落盘失败不影响服务本身，前端还有 1949 默认值兜底 */
  }
}

function startServer(port) {
  server.listen(port, () => {
    writePortFile(port)
    console.log(`\n========================================`)
    console.log(`发版小助手 v2 本地引擎已启动`)
    console.log(`========================================`)
    console.log(`\n地址: http://localhost:${port}`)
    console.log(`端口文件: ${SERVER_PORT_FILE}`)
    console.log(`\n按 Ctrl+C 停止服务器\n`)

    // NO_OPEN=1 供自动化测试使用：起服务但不要弹浏览器
    if (process.env.NO_OPEN === '1') return

    const cmd =
      process.platform === 'win32'
        ? `start "" http://localhost:${port}`
        : process.platform === 'darwin'
          ? `open http://localhost:${port}`
          : `xdg-open http://localhost:${port}`
    exec(cmd, err => {
      if (err) console.log(`请手动打开: http://localhost:${port}`)
    })
  })

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`端口 ${port} 已被占用，尝试端口 ${port + 1} ...`)
      server.close()
      startServer(port + 1)
    } else {
      console.error('服务器启动失败:', err.message)
      process.exit(1)
    }
  })
}

startServer(PORT)
