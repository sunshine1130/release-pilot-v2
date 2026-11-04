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
/** 进程内缓存条目上限：键含 path/repo 等外部输入，不设上限会一直涨 */
const CACHE_MAX_ENTRIES = 200

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
  // 键里带 path/repo/match 等外部传入的值，长期运行会只增不减；超上限按插入顺序清最旧的
  if (cacheStore.size >= CACHE_MAX_ENTRIES && !cacheStore.has(key)) {
    for (const k of cacheStore.keys()) {
      cacheStore.delete(k)
      if (cacheStore.size < CACHE_MAX_ENTRIES) break
    }
  }
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
    throw normalizeGitError(err, timeoutMs)
  }
}

function normalizeGitError(err, timeoutMs = GIT_TIMEOUT_MS) {
  const stderr = String(err.stderr || '')
  if (err.code === 'ENOENT') {
    return { code: 'GIT_NOT_FOUND', message: '未检测到 git，请先安装 Git for Windows' }
  }
  if (err.killed || err.signal === 'SIGTERM') {
    return { code: 'GIT_TIMEOUT', message: `git 调用超时（${timeoutMs}ms）` }
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

/** 执行 meegle CLI。拿不到入口脚本就直接报错，绝不退回 .cmd + shell —— 见下方注释 */
async function runMeegle(args, timeoutMs = 90000) {
  const entry = resolveMeegleEntry()
  // 拿不到入口脚本时**不退回** meegle.cmd + shell:true：shell 模式下 Node 不转义参数，
  // 而 MQL/项目KEY 都来自请求体，一个 `&`、`|` 或 `%VAR%` 就能拼出任意命令。
  // 装了别的包管理器（nvm/volta/pnpm）导致路径不在候选里时，明确报错让用户设 MEEGLE_JS。
  if (!entry) {
    throw {
      code: 'MEEGLE_CLI_MISSING',
      message: '未找到 meegle CLI 入口脚本，请安装 @lark-project/meegle，或用环境变量 MEEGLE_JS 指向 bin/meegle.js',
    }
  }

  try {
    const { stdout } = await execFileAsync(process.execPath, [entry, ...args], {
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
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
 * （实测 your_space 有 OMS/SCM/TMS/BMS/BD/仓库/优化/架构运维/AI 共 10 个），
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
  if (!mqlTemplate || !/\{type\}/.test(mqlTemplate) || !/\{space\}/.test(mqlTemplate)) {
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
 * 必须带数字边界：不同长度的 ID 可能互为子串（如 1234567890 出现在 11234567890 里），
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
  try {
    return parseLsRemote(await runGit(args, BASE_DIR))
  } catch (err) {
    // 项目里的 MR 地址可能是 http://（手工填过），而这类内网 GitLab 常常只认 https 的凭据；
    // 直接失败会让「远端分支列表」静默为空，本地已删除的旧分支就全成了未登记分支。
    // 换协议再试一次，成本只有一次 ls-remote。
    const alt = target.replace(/^http:\/\//i, 'https://')
    if (alt === target) throw err
    try {
      const altArgs = ['ls-remote', '--heads', '--', alt]
      if (match) altArgs.push(match)
      return parseLsRemote(await runGit(altArgs, BASE_DIR))
    } catch {
      throw err
    }
  }
}

function parseLsRemote(out) {
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
 *   2. 必须用 --first-parent。分支之间会互相 merge（如 feat/7000000010 merge 了 feat/mdm三期分支），
 *      不加会把兄弟分支的工作算成自己的。
 *   3. 必须排除基线区间（mb..branch）。直接 log 整个分支会把从 dev/master 继承的上游提交
 *      全算进来，实测一条分支能冒出 9 个别人的需求ID。
 *   4. 独占提交为 0 说明已完全并入主线，不参与关联（否则会把历史分支全捞出来）。
 */
/**
 * 取当前仓库的提交身份（user.name / user.email）。
 *
 * 用来判断一条分支是不是「我创建的」——同事的分支混进未登记列表和匹配结果里纯是噪声：
 * 实测 auth-web 的 6 条活跃分支全部属于其他同事，而
 * ops-web / pms-web / scm-web / aps-web 的分支清一色是自己。
 */
async function gitIdentity(cwd) {
  const cacheKey = `identity:${cwd}`
  const hit = cacheGet(cacheKey, 6 * 60 * 60 * 1000)
  if (hit) return hit
  const id = { name: '', email: '' }
  try {
    id.name = (await runGit(['config', 'user.name'], cwd)).trim()
  } catch {}
  try {
    id.email = (await runGit(['config', 'user.email'], cwd)).trim()
  } catch {}
  cacheSet(cacheKey, id)
  return id
}

/**
 * 判定分支的创建者。
 *
 * 取该分支独占提交里**最早的一条**（最靠近分叉点）的作者，而不是「提交最多的人」：
 * 分支的起点作者才是创建者；别人建的分支上我后来补过几个提交，不该整条算成我的。
 */
function isMineBy(entry, me) {
  if (!entry) return false
  if (me.name && entry.author === me.name) return true
  if (me.email && entry.email === me.email) return true
  return false
}

async function computeBranchIndex(cwd, base, maxCommits, maxBranches, remoteNames, onlyMine) {
  if (!fs.existsSync(cwd)) throw { code: 'GIT_PATH_MISSING', message: `本地路径不存在：${cwd}` }
  if (!fs.existsSync(path.join(cwd, '.git'))) throw { code: 'GIT_NOT_REPO', message: `不是 git 仓库：${cwd}` }

  const baseRef = `origin/${base}`
  try {
    await runGit(['rev-parse', '--verify', '--quiet', baseRef], cwd)
  } catch {
    throw { code: 'GIT_BASE_MISSING', message: `仓库中没有 ${baseRef}，请确认发布主线名称` }
  }

  // 只筛自己的分支时先取身份。拿不到身份就**不筛** —— 否则会把所有分支都判成
  // 「不是我的」而静默清空整个索引，比不筛危险得多。
  const me = onlyMine ? await gitIdentity(cwd) : null
  const filterByMine = !!(me && (me.name || me.email))

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
  let notMine = 0

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
      // 顺带带上作者：与取提交标题同一次调用，不额外增加进程开销
      out = await runGit(
        ['log', '--first-parent', '-n', String(maxCommits + 1), '--format=%an|%ae|%s', `${baseRef}..${ref}`],
        cwd,
      )
    } catch {
      continue // ref 已删除或不可解析 —— 跳过该分支，不算错误
    }

    // git log 默认由新到旧，所以数组最后一条就是分支最早的独占提交
    const entries = []
    for (const line of out.split('\n')) {
      if (!line) continue
      const i1 = line.indexOf('|')
      const i2 = line.indexOf('|', i1 + 1)
      if (i1 < 0 || i2 < 0) continue
      entries.push({ author: line.slice(0, i1), email: line.slice(i1 + 1, i2), subject: line.slice(i2 + 1) })
    }

    if (entries.length === 0) {
      // 相对发布主线没有任何独占提交 = 改动已全部进入主线，不参与关联
      branches.push({ name, ids: [], commits: 0, lastDate, merged: true, skipped: false, mine: null, owner: '' })
      continue
    }

    if (entries.length > maxCommits) {
      // commits 留 null 是有意的：这里根本没数完，报一个数字会是编造的。
      // 前端据此显示「未分析」，与「确实没有需求ID」区分开。
      branches.push({ name, ids: [], commits: null, lastDate, merged: false, skipped: true, mine: null, owner: '' })
      continue
    }

    const creator = entries[entries.length - 1]
    const mine = filterByMine ? isMineBy(creator, me) : null
    if (filterByMine && !mine) {
      notMine++
      continue
    }

    const ids = extractReqIds(entries.map(e => e.subject).join('\n'))
    const entry = {
      name, ids, commits: entries.length, lastDate, merged: false, skipped: false,
      mine, owner: creator.author || '',
    }
    branches.push(entry)
    if (ids.length === 0) unregistered.push({ name, commits: entries.length, lastDate, owner: entry.owner })
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
    onlyMine: filterByMine,
    notMine, // 因「不是自己创建」被过滤掉的分支数
    localOnly, // 被远端列表过滤掉的本地 ref 条数（含 refs/heads 与 refs/remotes 的重复项，仅作诊断用）
    remoteOnly, // 远端有、本地没有的分支名
  }
}

// ===== v1 既有接口（行为保持不变，改动前请确认前端依赖） =====

/** 近 1 个月（v1 函数名叫 getThreeMonthsAgo 但实际减 1 个月，这里保留原行为不改） */
function oneMonthAgoStr() {
  const date = new Date()
  const day = date.getDate()
  // 必须先归到 1 号再减月：直接 setMonth(-1) 在 31 号会让 3/31 变成 2/31，
  // JS 会顺延到 3/3，于是「近一个月」窗口被悄悄缩成 28 天
  date.setDate(1)
  date.setMonth(date.getMonth() - 1)
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  date.setDate(Math.min(day, lastDay))
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

    // isRemote 已删除：这个接口列的就是本地分支（origin/* 已被过滤），
    // 原来用「分支名含斜杠」判断远端，会把 feat/xxx 这类本地分支全标成远端，且前端从未使用
    branches.push({ branch: refName, author, date, message })
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
  // 默认只保留自己创建的分支：同事的分支混进来只会污染未登记列表与匹配结果
  const onlyMine = query.get('onlyMine') !== '0'
  const force = query.get('refresh') === '1'
  // repo 与 onlyMine 都必须进缓存键：它们不同则结果不同，不能互相命中
  const cacheKey = `index:${fullPath}:${base}:${maxCommits}:${maxBranches}:${repo || ''}:${onlyMine ? 'mine' : 'all'}`
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

    const result = await computeBranchIndex(fullPath, base, maxCommits, maxBranches, remoteNames, onlyMine)
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

// ===== 自更新：同事点一下就能拉到最新代码 =====
//
// 页面就是这个目录里的静态文件，所以「在项目目录里 git pull」就等于更新应用，
// 不必像谷歌插件那样另外做一套分发。两个前提必须讲清楚并体现在错误信息里：
//   1. 私有仓库第一次拉取要登录 GitHub；引擎不做交互式提示（会挂死），
//      所以首次要在项目目录里手工 pull 一次完成登录，之后引擎就能直接拉。
//   2. 引擎自己（server.js）在进程里已加载过：这次更新若动了引擎代码，
//      光刷新页面没用，必须重启 start-server.bat —— 接口要把这件事告诉前端。

/** 当前提交信息（版本徽标与更新比对都用它） */
async function readGitVersion(cwd, ref = 'HEAD') {
  const [hash, meta, branch, remote] = await Promise.all([
    runGit(['rev-parse', '--short', ref], cwd),
    runGit(['log', '-1', '--format=%H%n%ad%n%s', '--date=format:%Y-%m-%d %H:%M', ref], cwd),
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    runGit(['remote', 'get-url', 'origin'], cwd).catch(() => ''),
  ])
  const [full = '', date = '', subject = ''] = meta.trim().split('\n')
  return {
    commit: hash.trim(),
    full: full.trim(),
    date: date.trim(),
    subject: subject.trim(),
    branch: branch.trim(),
    remote: remote.trim(),
  }
}

async function handleVersion(req, res) {
  try {
    const v = await readGitVersion(BASE_DIR)
    const status = await runGit(['status', '--porcelain'], BASE_DIR)
    json(res, { ...v, dirty: status.trim().length > 0 })
  } catch (err) {
    fail(res, 'VERSION_FAILED', `读取版本失败：${err.message}`, 500)
  }
}

async function handleUpdateCheck(req, res) {
  const cwd = BASE_DIR
  try {
    try {
      await runGit(['rev-parse', '--is-inside-work-tree'], cwd)
    } catch {
      return json(res, { configured: false, hint: '这个目录不是 git 仓库，无法自动更新；请用 git clone 下来的一份。' })
    }
    const local = await readGitVersion(cwd)
    if (!local.remote) {
      return json(res, { configured: false, local, hint: '还没有配置远端仓库（git remote add origin …），无法检查更新。' })
    }

    // fetch 可能因为没登录 GitHub 而失败：这不是「没有更新」，要如实分开
    try {
      await runGit(['fetch', '--prune', 'origin'], cwd, 60000)
    } catch (err) {
      const auth = err.code === 'GIT_AUTH_REQUIRED'
      return json(res, {
        configured: true,
        reachable: false,
        local,
        error: auth
          ? '拉取需要 GitHub 登录（私有仓库）。请在本项目目录里先执行一次 git pull，按提示在浏览器里登录，之后这里就能直接更新。'
          : `拉取失败：${err.message}`,
      })
    }

    const upstream = `origin/${local.branch}`
    let remoteLatest = null
    try {
      remoteLatest = await readGitVersion(cwd, upstream)
    } catch {
      return json(res, {
        configured: true,
        reachable: true,
        local,
        hasUpdate: false,
        hint: `远端没有 ${upstream}，可能是还没推送过。`,
      })
    }
    const counts = await runGit(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], cwd)
    const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map(Number)
    const status = await runGit(['status', '--porcelain'], cwd)
    json(res, {
      configured: true,
      reachable: true,
      local,
      remoteLatest,
      ahead,
      behind,
      dirty: status.trim().length > 0,
      hasUpdate: behind > 0,
    })
  } catch (err) {
    fail(res, 'UPDATE_CHECK_FAILED', `检查更新失败：${err.message}`, 500)
  }
}

async function handleUpdateApply(req, res) {
  const cwd = BASE_DIR
  try {
    const local = await readGitVersion(cwd)
    const status = await runGit(['status', '--porcelain'], cwd)
    // 本地有未提交改动时拒绝：fast-forward 之外的情况硬拉会把人工改动卷进去
    if (status.trim().length > 0) {
      return fail(res, 'UPDATE_DIRTY', '本地有未提交的改动，先提交或还原再更新（避免更新把改动覆盖掉）', 409)
    }
    if (!local.remote) return fail(res, 'UPDATE_NO_REMOTE', '还没有配置远端仓库', 400)

    const upstream = `origin/${local.branch}`
    try {
      await runGit(['pull', '--ff-only', 'origin', local.branch], cwd, 60000)
    } catch (err) {
      const code = err.code === 'GIT_AUTH_REQUIRED' ? 'UPDATE_AUTH_REQUIRED' : 'UPDATE_FAILED'
      const message = err.code === 'GIT_AUTH_REQUIRED'
        ? '拉取需要 GitHub 登录：请在本项目目录里手工执行一次 git pull 完成登录后再点更新'
        : String(err.message || '').trim().split('\n')[0]
      return fail(res, code, message, 400)
    }

    const to = await readGitVersion(cwd)
    let files = []
    try {
      const diff = await runGit(['diff', '--name-only', `${local.full}..HEAD`], cwd)
      files = diff.trim().split('\n').filter(Boolean)
    } catch {}
    json(res, {
      ok: true,
      from: local.commit,
      to: to.commit,
      subject: to.subject,
      files,
      // 引擎代码变了就必须重启进程，刷新页面没用 —— 前端据此给不同提示
      engineChanged: files.some(f => f === 'server.js'),
    })
  } catch (err) {
    fail(res, 'UPDATE_APPLY_FAILED', `更新失败：${err.message}`, 500)
  }
}

// ===== 本地备份 =====
//
// 需求数据只存在浏览器的 localStorage 里：清缓存、换浏览器、换机器就没了，
// 「导出」还得自己挑目录。所以再提供一个把备份直接写进项目目录的通道 ——
// 备份跟代码放在一起，拷走整个文件夹就带走了数据，同时列出/恢复也由引擎负责。

const BACKUP_DIR = path.join(BASE_DIR, 'backup')
const BACKUP_KEEP = 200

function pad2(n) { return String(n).padStart(2, '0') }

function backupFileName(now = new Date()) {
  const ts = now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate())
    + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds())
  return `todoList-发版需求-${ts}.json`
}

/** 只接受本目录下的单个文件名，挡住 ../ 之类的路径穿越 */
function resolveBackupPath(name) {
  const base = path.basename(String(name || ''))
  if (!base || base !== name || !/\.json$/i.test(base)) return null
  const full = path.join(BACKUP_DIR, base)
  if (!full.startsWith(BACKUP_DIR + path.sep)) return null
  return full
}

async function handleBackupCreate(req, res) {
  // 备份体比普通请求大得多（需求多、备注长），单给这一条放宽上限
  const body = await readJsonBody(req, 32 * 1024 * 1024)
  const data = body && body.data
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
    return fail(res, 'BAD_REQUEST', '备份内容必须是导出格式的 JSON（至少包含 items 数组）')
  }
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const name = backupFileName()
    const full = path.join(BACKUP_DIR, name)
    const text = JSON.stringify(data, null, 2)
    fs.writeFileSync(full, text, 'utf8')
    json(res, {
      ok: true,
      dir: BACKUP_DIR,
      name,
      file: full,
      size: Buffer.byteLength(text),
      items: data.items.length,
      at: Date.now(),
    })
  } catch (err) {
    fail(res, 'BACKUP_WRITE_FAILED', `写备份失败：${err.message}`, 500)
  }
}

async function handleBackupList(req, res) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return json(res, { dir: BACKUP_DIR, files: [] })
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(n => /\.json$/i.test(n))
      .map(n => {
        const full = path.join(BACKUP_DIR, n)
        const stat = fs.statSync(full)
        let items = null
        // 顺手把需求条数读出来：列表里只看「哪天备份的、多少条」就该能判断选哪份恢复
        try { items = (JSON.parse(fs.readFileSync(full, 'utf8')).items || []).length } catch {}
        return { name: n, size: stat.size, mtime: stat.mtimeMs, items }
      })
      .sort((a, b) => b.mtime - a.mtime)
    json(res, { dir: BACKUP_DIR, files })
  } catch (err) {
    fail(res, 'BACKUP_LIST_FAILED', `读取备份目录失败：${err.message}`, 500)
  }
}

async function handleBackupRead(req, res, query) {
  const full = resolveBackupPath(query.get('name'))
  if (!full) return fail(res, 'BAD_REQUEST', 'name 必须是备份目录下的 .json 文件名')
  try {
    if (!fs.existsSync(full)) return fail(res, 'BACKUP_NOT_FOUND', '备份文件不存在', 404)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(fs.readFileSync(full))
  } catch (err) {
    fail(res, 'BACKUP_READ_FAILED', `读取备份失败：${err.message}`, 500)
  }
}

/** 在资源管理器里打开备份目录，省得用户照着手敲路径 */
async function handleBackupReveal(req, res) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    if (process.platform === 'win32') {
      // explorer 打开成功也常返回非 0，这里不判定退出码
      execFile('explorer.exe', [BACKUP_DIR], () => {})
    } else if (process.platform === 'darwin') {
      execFile('open', [BACKUP_DIR], () => {})
    } else {
      execFile('xdg-open', [BACKUP_DIR], () => {})
    }
    json(res, { ok: true, dir: BACKUP_DIR })
  } catch (err) {
    fail(res, 'BACKUP_REVEAL_FAILED', `打开备份目录失败：${err.message}`, 500)
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
  'POST /api/backup': handleBackupCreate,
  'GET /api/backup/list': handleBackupList,
  'GET /api/backup/read': handleBackupRead,
  'POST /api/backup/reveal': handleBackupReveal,
  'GET /api/version': handleVersion,
  'GET /api/update/check': handleUpdateCheck,
  'POST /api/update/apply': handleUpdateApply,
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
  // 解码必须兜住异常：URL 里出现非法转义（如 /%zz）时 decodeURIComponent 会抛 URIError，
  // 而它在 http handler 里是未捕获异常 → 整个引擎进程直接退出，页面全废
  try {
    filePath = decodeURIComponent(filePath)
  } catch {
    res.writeHead(400)
    res.end('Bad Request')
    return
  }
  filePath = path.resolve(BASE_DIR, filePath.replace(/^[/\\]+/, ''))

  // 防目录穿越：必须落在 BASE_DIR 之内。
  // 不能用 startsWith(BASE_DIR)：`..\发版小助手-v2-backup` 这类同名前缀的兄弟目录
  // 字符串上确实以 BASE_DIR 开头，会被放行；必须比到路径分隔符。
  if (filePath !== BASE_DIR && !filePath.startsWith(BASE_DIR + path.sep)) {
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

  // CORS 只放行本机来源：页面同源访问本来就用不到 CORS，
  // 而无条件 `*` 等于允许用户浏览器里打开的任何网页跨域读本引擎
  // （接口能列任意本地仓库的分支、还能以本人身份查飞书项目）。
  // 非本机 Origin 一律拒绝，连「发请求但不读响应」的盲打也一起挡掉 ——
  // meegle 兜底链路在拿不到 CLI 入口时会走 shell，盲打也可能造成命令注入。
  const origin = req.headers.origin
  const isLocalOrigin = !origin || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  if (!isLocalOrigin) {
    fail(res, 'FORBIDDEN_ORIGIN', '只接受来自本机页面的请求', 403)
    return
  }
  if (origin && origin !== 'null') {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
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
  // 只监听回环：接口能列任意本地仓库的分支、能按当前身份查飞书项目，
  // 绑 0.0.0.0 会把它们连同 git ls-remote 的 SSRF 面一起暴露给同网段
  server.listen(port, '127.0.0.1', () => {
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
      // 递归重试前必须先摘掉监听器：startServer 每次都会再注册一个 error 监听，
      // 不清掉的话第 N 次冲突会触发 N 个 handler，各自再起一轮，端口占用时呈放大式重试
      server.removeAllListeners('error')
      if (port >= PORT + 20) {
        console.error(`端口 ${PORT}~${port} 都被占用，请先关掉占用进程再启动`)
        process.exit(1)
      }
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
