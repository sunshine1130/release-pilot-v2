/**
 * v2 前端 UI 验证（真实浏览器驱动）
 *
 * 为什么必须跑这一层：接口能通不代表页面能用。这次改动里最典型的两个「接口全对但页面全错」
 * 风险是 ①端口读取失败导致所有请求打到别的进程、②模板引用了没导出的标识符导致静默不渲染，
 * 两者都不会在接口测试里暴露。
 *
 * 运行：node scripts/ui-verify.mjs
 * 前置：另开一个终端执行 `NO_OPEN=1 node server.js`
 *
 * Playwright 位置：本机没有全局安装，从既有自动化工程的 node_modules 里取，
 * 免得为了一个验证脚本把依赖塞进这个零依赖项目。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const require = createRequire(import.meta.url)
const PLAYWRIGHT_CANDIDATES = [
  'C:/项目/造数据知识库/scripts/pms-web-automation/node_modules/playwright',
  'C:/Users/leyang312/Documents/deepseek-harness/default-workspace/mgw-7029307841/node_modules/playwright',
  'playwright',
]

function loadPlaywright() {
  for (const p of PLAYWRIGHT_CANDIDATES) {
    try {
      return require(p)
    } catch {}
  }
  throw new Error('未找到 playwright，请检查 PLAYWRIGHT_CANDIDATES 里的路径')
}

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`)
}

function readPort() {
  const f = path.join(PROJECT_DIR, '.server-port')
  if (!fs.existsSync(f)) throw new Error('未找到 .server-port，请先用 NO_OPEN=1 node server.js 启动引擎')
  return Number(fs.readFileSync(f, 'utf8').trim())
}

const { chromium } = loadPlaywright()
const PORT = readPort()
const BASE = `http://localhost:${PORT}`

// 测试用的项目配置：ops-web 同时有 MR 地址与本地路径，才可能算出需求ID
const SEED_PROJECTS = [
  { name: 'ops-web', mr: 'https://git.joyintoy.cn/joyin/ops-web', localPath: 'C:\\项目\\ops-web' },
]
// 两条引用同一条融合分支的需求，刻意用两种不同的「我是谁」来源：
//   uitest1 走 source.workItemId（将来飞书同步写入的）
//   uitest2 没有 source，只有飞书链接（历史手工录入的老数据形态）
// 两条都必须出现影响面提示，否则等于只对新数据有效
const SEED_ITEMS = [
  {
    id: 'uitest1',
    name: 'UI验证-销售预测',
    link: 'https://project.feishu.cn/xxx/story/detail/7072591743',
    status: 'pending',
    projects: [{ name: 'ops-web', branch: 'feat/ops四需求合并分支', notes: '' }],
    syncBranches: [],
    source: { provider: 'meegle', workItemId: '7072591743' },
  },
  {
    id: 'uitest2',
    name: 'UI验证-老数据形态',
    link: 'https://project.feishu.cn/xxx/story/detail/7029460314',
    status: 'pending',
    projects: [{ name: 'ops-web', branch: 'feat/ops四需求合并分支', notes: '' }],
    syncBranches: [],
  },
  {
    // 这条不手工挂分支，只靠需求ID（从链接里提）等索引自动匹配 —— 验证「自动匹配」建议
    id: 'uitest4',
    name: 'UI验证-待挂分支',
    link: 'https://project.feishu.cn/xxx/story/detail/6984365400',
    status: 'pending',
    projects: [],
    syncBranches: [],
  },
  {
    // 这条的需求ID 落在飞书 oms 类型第一页，用来验证「已导入」标记
    id: 'uitest3',
    name: 'UI验证-已导入需求',
    link: 'https://project.feishu.cn/ly_oms/oms/detail/7154016953',
    status: 'new',
    projects: [],
    syncBranches: [],
  },
]

// 同步配置预置：真实空间 ly_oms，只选 story + oms 两类、每类只拉一页，
// 把验证控制在 4 次 meegle 调用以内
const MEEGLE_CONFIG = {
  projectKey: '6629becdcfea521fda9b97e4',
  simpleName: 'ly_oms',
  spaceName: '信息部工作汇总',
  typeApiNames: ['story', 'oms'],
  mqlTemplate: 'SELECT `work_item_id`,`name`,`work_item_status` FROM `{space}`.`{type}`',
  maxPerType: 50,
}

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()

const apiCalls = []
page.on('request', req => {
  if (req.url().includes('/api/')) apiCalls.push(req.url())
})

// 未捕获的 JS 异常是最危险的一类回归：页面看起来正常，但某个 computed 一抛错就整块不渲染
const jsErrors = []
page.on('pageerror', e => jsErrors.push(e.message))

// HTTP 层错误单独收：toDo.json 不存在时 404 是 v1 既有的正常分支，
// 但除此之外的任何 4xx/5xx 都要暴露出来，不能用「控制台有 404」一概而论
const httpErrors = []
page.on('response', r => { if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`) })

try {
  // ===== 0) 引擎自检（HTTP 层，走原始请求绕开浏览器的 URL 归一化）=====
  // 这几条都是「一条请求打死服务/读出目录外文件」级别的问题，必须每次回归都验
  const rawGet = (rawPath, headers = {}) =>
    new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: rawPath, headers }, res => {
        let body = ''
        res.on('data', c => { body += c })
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
      })
      req.on('error', e => resolve({ status: 0, body: String(e.message), headers: {} }))
    })

  // 非法百分号转义曾让 decodeURIComponent 抛 URIError 逃逸成 unhandled rejection → 进程退出
  const badEscape = await rawGet('/%zz')
  const stillAlive = await rawGet('/api/git-user')
  check('非法转义不再打死引擎（返回 400 且服务存活）',
    badEscape.status === 400 && stillAlive.status === 200,
    `非法转义 ${badEscape.status}，随后探活 ${stillAlive.status}`)

  // 目录穿越：造一个与 BASE_DIR 同名前缀的兄弟目录，前缀式校验会把它当成「目录内」
  const sibling = `${PROJECT_DIR}-verify-sibling`
  fs.mkdirSync(sibling, { recursive: true })
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'should-not-be-served')
  try {
    const escaped = await rawGet('/%2e%2e/' + encodeURIComponent(path.basename(sibling)) + '/secret.txt')
    check('同名前缀的兄弟目录不可读（目录穿越被挡）',
      escaped.status !== 200 && !escaped.body.includes('should-not-be-served'),
      `${escaped.status} ${escaped.body.slice(0, 40)}`)
  } finally {
    // 不能用 fs.rmSync(dir, {recursive:true}) —— 本机 Node 24.2.0 上它会静默杀死进程（exit 127，
    // 无任何错误输出），脚本会在这一行之后全部不执行。逐个删文件再 rmdir 是可靠的。
    try {
      fs.unlinkSync(path.join(sibling, 'secret.txt'))
      fs.rmdirSync(sibling)
    } catch {}
  }

  // 任意网页的跨域请求必须被拒：接口能列本地仓库分支、还能以本人身份查飞书项目
  const foreign = await rawGet('/api/git-user', { Origin: 'https://evil.example' })
  check('非本机来源的请求被拒绝', foreign.status === 403, `状态 ${foreign.status}`)
  const localOrigin = await rawGet('/api/git-user', { Origin: `http://localhost:${PORT}` })
  check('本机来源仍可用（localhost 与 127.0.0.1 都放行）', localOrigin.status === 200, `状态 ${localOrigin.status}`)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // 预置数据：项目配置 + 需求 + 关掉每日提醒（否则遮罩挡住点击）
  await page.evaluate(
    ({ projects, items }) => {
      const today = new Date()
      const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      localStorage.setItem('todo_project_names', JSON.stringify(projects))
      localStorage.setItem('todo_release_data', JSON.stringify(items))
      localStorage.setItem('todo_launch_branch', 'master_launched')
      localStorage.setItem('todo_last_remind_date', d)
      localStorage.setItem('todo_last_branch_fetch_date', d) // 阻止自动抓取，避免干扰
      localStorage.removeItem('todo_branch_index')
      localStorage.removeItem('todo_branch_triage')
    },
    { projects: SEED_PROJECTS, items: SEED_ITEMS },
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  // 1) 页面基本渲染
  check('页面标题渲染', await page.locator('h1.page-title').isVisible())
  check('需求行渲染', (await page.getByText('UI验证-销售预测').count()) > 0)

  // 2) 端口修复：页面必须打到本进程端口，而不是写死的 1949
  check(
    '启动时读取了 .server-port',
    apiCalls.length === 0 || !apiCalls.some(u => u.includes(':1949/')),
    `已捕获 ${apiCalls.length} 个 api 请求`,
  )

  // 3) 点「刷新分支索引」，等真实 git 分析完成
  // 未登记分支面板默认收起，展开态要通过 .collapse-body 的 class 判断 ——
  // 用卡片数判断会在「本来就没有卡片」时误点一下，反而把已展开的面板收起来
  const expandUnreg = async () => {
    if ((await page.locator('.unreg-panel .collapse-body.expanded').count()) === 0) {
      await page.locator('.unreg-panel .pm-header').click()
      await page.waitForTimeout(300)
    }
  }
  await page.getByRole('button', { name: /刷新分支索引/ }).click()
  check('未登记分支面板默认收起',
    (await page.locator('.unreg-panel .collapse-body.expanded').count()) === 0)
  await page.locator('.unreg-panel .hint', { hasText: '条分支查不到需求登记' }).waitFor({ timeout: 180000 })
  await expandUnreg()
  await page.getByText('feat/mdm二期分支').first().waitFor({ timeout: 60000 })

  check(
    '索引请求打到本引擎端口',
    apiCalls.some(u => u.includes(`localhost:${PORT}/api/git/branch-index`)),
    `端口 ${PORT}`,
  )
  check('未登记分支区出现 target 分支', (await page.getByText('feat/mdm二期分支').count()) > 0)
  check('未登记分支带项目标签', (await page.getByText(/ops-web · \d+/).count()) > 0)

  // 3b) 未登记分支搜索：分支名与项目名都能匹配，无命中时给明确空态（而不是「暂无未登记分支」）
  const unregSearch = page.locator('.unreg-panel .unreg-toolbar input')
  const unregCards = page.locator('.unreg-card')
  const totalUnreg = await unregCards.count()
  check('未登记分支提供搜索框', (await unregSearch.count()) === 1)
  await unregSearch.fill('mdm二期')
  await page.waitForTimeout(300)
  check('按分支名筛选',
    (await unregCards.count()) === 1 && (await unregSearch.inputValue()) === 'mdm二期',
    `命中 ${await unregCards.count()} 张 / 共 ${totalUnreg}`)
  check('搜索命中数在面板上可见',
    (await page.locator('.unreg-toolbar .hint').textContent() || '').includes(`1/${totalUnreg}`))
  await page.locator('.unreg-panel').screenshot({ path: path.join(PROJECT_DIR, 'docs', 'ui-verify-unreg-search.png') })

  await unregSearch.fill('ops-web')
  await page.waitForTimeout(300)
  const byProject = await unregCards.count()
  const allOpsOnly = await unregCards.evaluateAll(els =>
    els.every(el => [...el.querySelectorAll('.project-tag')].some(t => t.textContent.includes('ops-web'))))
  check('按项目名筛选', byProject > 0 && allOpsOnly, `命中 ${byProject} 张，且都含 ops-web 标签`)

  await unregSearch.fill('zzz-不存在的分支')
  await page.waitForTimeout(300)
  check('无命中时给出明确空态',
    (await unregCards.count()) === 0 && (await page.locator('.unreg-panel .empty-state', { hasText: '没有匹配的分支' }).isVisible()))
  check('无命中时不误报「暂无未登记分支」',
    (await page.locator('.unreg-panel .empty-state', { hasText: '暂无未登记分支' }).count()) === 0)

  await unregSearch.fill('')
  await page.waitForTimeout(300)
  check('清空搜索后恢复全量', (await unregCards.count()) === totalUnreg, `恢复为 ${totalUnreg} 张`)

  // 4) 影响面提示：期望值从实际索引算，不能写死。
  //    这条分支仍在长（实测 10-29 是 4 个ID、11-03 已经 6 个），写死数字必然过几天就红
  const expectedOthers = await page.evaluate(() => {
    const idx = JSON.parse(localStorage.getItem('todo_branch_index') || '{}')
    const entry = idx['ops-web'] && idx['ops-web'].branches && idx['ops-web'].branches['feat/ops四需求合并分支']
    return ((entry && entry.ids) || []).length - 1
  })
  const impacts = await page.getByText(/还覆盖 \d+ 个需求/).allTextContents()
  check('影响面提示数量正确（两条需求都命中）',
    expectedOthers > 0 && impacts.length === 2 && impacts.every(t => new RegExp(`还覆盖 ${expectedOthers} 个需求`).test(t)),
    `期望 ${expectedOthers}，实际：${impacts.map(t => t.trim()).join(' / ')}`)

  // 4b) 自动匹配建议：索引里查到、但需求没手工挂的分支必须在行上可见。
  //     否则「有ID、但ID不挂在这条需求上」的融合分支在页面上会彻底消失 ——
  //     它既进不了未登记分支（有ID），也不出现在任何需求行。
  const row4 = page.locator('tr', { hasText: 'UI验证-待挂分支' })
  const chips = row4.locator('.branch-suggest')
  await chips.first().waitFor({ timeout: 30000 })
  const chipText = (await chips.first().textContent() || '').trim()
  check('需求行显示自动匹配的建议分支',
    chipText.includes('ops-web') && chipText.includes('feat/ops四需求合并分支'), chipText)
  check('已手工挂过的分支不再重复建议',
    (await page.locator('tr', { hasText: 'UI验证-销售预测' }).locator('.branch-suggest').count()) === 0)
  // 截图前先把行滚到视口里：按 boundingBox 裁切时，行若在视口底部，裁出来只有几像素
  await row4.scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  const rowBox = await row4.boundingBox()
  if (rowBox) {
    const top = Math.max(0, rowBox.y - 60)
    await page.screenshot({
      path: path.join(PROJECT_DIR, 'docs', 'ui-verify-suggest.png'),
      clip: { x: 0, y: top, width: 1280, height: Math.min(240, 720 - top) },
    })
  }

  await chips.first().click()
  await page.waitForTimeout(400)
  check('点击建议即挂上分支（建议消失、分支出现）',
    (await row4.locator('.branch-suggest').count()) === 0 && (await row4.locator('.branch-tag').count()) > 0,
    (await row4.locator('.branch-text').first().textContent() || '').trim())
  const persisted = await page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem('todo_release_data') || '[]')
    const it = items.find(i => i.name === 'UI验证-待挂分支')
    return ((it && it.projects) || []).map(p => `${p.name}|${p.branch}`)
  })
  check('采用建议后落盘', persisted.includes('ops-web|feat/ops四需求合并分支'), persisted.join(' , '))

  // 4c) 同一项目已经挂了别的分支时，建议必须**追加一行**而不是要求用户自己去切换：
  //     一条需求的代码同时落在同仓库两条分支上是真实形态（融合分支 merge 了按需求命名的分支）
  const row2 = page.locator('tr', { hasText: 'UI验证-老数据形态' })
  const tagsBefore = await row2.locator('.branch-tag').count()
  await row2.locator('.branch-suggest').first().click()
  await page.waitForTimeout(400)
  const tagsAfter = (await row2.locator('.branch-text').allTextContents()).map(s => s.trim())
  check('已有分支时点建议是追加而不是让用户切换',
    tagsBefore === 1 && tagsAfter.length === 2 && tagsAfter.includes('feat/ops四需求合并分支'),
    `${tagsBefore} → ${tagsAfter.join(' + ')}`)
  check('追加同时给出实际挂上的提示',
    (await page.locator('.toast.show', { hasText: '已挂上 ops-web' }).count()) > 0)
  const persisted2 = await page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem('todo_release_data') || '[]')
    const it = items.find(i => i.name === 'UI验证-老数据形态')
    return ((it && it.projects) || []).map(p => `${p.name}|${p.branch}`)
  })
  check('追加后两个分支都在（原分支没被覆盖）',
    persisted2.includes('ops-web|feat/ops四需求合并分支') && persisted2.includes('ops-web|feat/7029460314销售预测迭代'),
    persisted2.join(' , '))
  await row2.screenshot({ path: path.join(PROJECT_DIR, 'docs', 'ui-verify-suggest-append.png') })

  // 5) 处置：点「无需需求」后该分支卡片消失
  //    断言必须落在卡片本身：getByText 会同时匹配到外层容器，用文本计数会误判
  const cardOf = n => page.locator('.unreg-card', { hasText: n })
  const beforeCount = await cardOf('feat/mdm二期分支').count()
  await cardOf('feat/mdm二期分支').getByRole('button', { name: '无需需求' }).click()
  await page.waitForTimeout(300)
  const afterCount = await cardOf('feat/mdm二期分支').count()
  check('处置后卡片移除', beforeCount === 1 && afterCount === 0, `卡片数 ${beforeCount} → ${afterCount}`)
  check('出现「已处置」记录', (await page.getByText(/已处置 \d+ 条/).count()) > 0)

  // 6) 持久化：刷新后仍然保持处置状态
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
  check('刷新后处置状态保持',
    (await cardOf('feat/mdm二期分支').count()) === 0 && (await page.getByText(/已处置 \d+ 条/).count()) > 0)

  // 7) 恢复（上一步 reload 过，面板回到默认收起态，点之前要先展开）
  await expandUnreg()
  await page.getByRole('link', { name: '恢复' }).first().click()
  await page.waitForTimeout(300)
  check('恢复后卡片回来', (await cardOf('feat/mdm二期分支').count()) === 1)

  // ===== 8) 飞书项目同步（真实调用 meegle CLI）=====
  // 两个弹窗共用 .sync-box，选择器必须按容器区分，否则 Playwright 严格模式会因多匹配报错
  const settingsBox = page.locator('.sync-box:not(.sync-box-wide)')
  const previewBox = page.locator('.sync-box-wide')
  // 「只看未导入」现在默认**不勾选**（不替用户做筛选决定），所以需要显式设置，
  // 不能再用「点一下就是取消」的写法 —— 那会把它反而勾上
  const onlyUnregBox = previewBox.locator('.sync-toolbar input[type=checkbox]')
  const setOnlyUnregistered = async want => {
    if ((await onlyUnregBox.isChecked()) !== want) {
      await previewBox.getByText('只看未导入').click()
      await page.waitForTimeout(300)
    }
  }

  await page.evaluate(
    ({ cfg, branchId }) => {
      localStorage.setItem('todo_meegle_config', JSON.stringify(cfg))
      // 合成一条覆盖某真实需求的跨需求分支，让「自动挂分支」这条链路可以被确定性断言
      // （真实索引里符合条件的分支不在飞书列表第一页）
      const idx = JSON.parse(localStorage.getItem('todo_branch_index') || '{}')
      idx['ops-web'] = idx['ops-web'] || { branches: {}, unregistered: [] }
      idx['ops-web'].branches['feat/测试-跨需求分支'] = {
        ids: [branchId], commits: 2, lastDate: '2026-11-03', merged: false,
      }
      localStorage.setItem('todo_branch_index', JSON.stringify(idx))
    },
    { cfg: MEEGLE_CONFIG, branchId: '7153729281' },
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  const totalBefore = (await page.locator('h1 .sub').textContent()) || ''

  await page.getByRole('button', { name: '同步飞书项目' }).click()
  await previewBox.locator('.sync-row').first().waitFor({ timeout: 240000 })
  const rowCount = await previewBox.locator('.sync-row').count()
  check('同步预览拉到飞书需求', rowCount > 0, `${rowCount} 行`)
  // 不该替用户做决定：既不预勾选需求，也不默认打开「只看未导入」筛选
  check('预览默认不勾选任何需求', (await previewBox.locator('.sync-row input:checked').count()) === 0)
  check('「只看未导入」默认不勾选', (await onlyUnregBox.isChecked()) === false)

  const summary = await previewBox.locator('.sync-summary-item').allTextContents()
  const okSummary = summary.filter(s => /\d+\/\d+/.test(s))
  check('按工作项类型汇总展示（两个类型都成功）', okSummary.length === 2, summary.join(' | ').slice(0, 160))
  // 状态名是每个类型各自一套的（story 有「已上线」、oms 没有），服务端必须按类型取交集后再过滤。
  // 这条断言同时覆盖「没有把不存在的状态写进 WHERE」——写错会直接报 metadata error。
  check('汇总里标注了各类型实际排除的状态',
    summary.some(s => s.includes('已排除')),
    summary.join(' | ').slice(0, 200))
  check('拉取无类型级错误', (await previewBox.locator('.sync-summary-err').count()) === 0)

  // 状态分组：一次拉上百条混在一起没法判断该发哪些，按状态切开才能整组勾选
  const groupNames = (await previewBox.locator('.sync-group-name').allTextContents()).map(s => s.trim())
  check('预览按状态分组', groupNames.length > 0, groupNames.join(' | '))
  check('已完成状态已被排除（不在预览里）',
    !groupNames.some(n => /已结束|已上线/.test(n)),
    groupNames.join(' | '))

  const firstGroup = previewBox.locator('.sync-group-header').first()
  const firstGroupName = (await firstGroup.locator('.sync-group-name').textContent() || '').trim()
  await firstGroup.getByRole('button', { name: '全选本组' }).click()
  await page.waitForTimeout(300)
  const groupSelected = await firstGroup.locator('.sync-group-sel').count()
  check('整组勾选生效', groupSelected > 0, `分组「${firstGroupName}」`)
  await firstGroup.getByRole('button', { name: '取消本组' }).click()
  await page.waitForTimeout(200)
  check('整组取消生效', (await firstGroup.locator('.sync-group-sel').count()) === 0)

  // 分组默认展开（一次上百条，默认全展开才能一眼看到内容），点分组头可收起
  const rowsBeforeCollapse = await previewBox.locator('.sync-row').count()
  check('分组默认展开', rowsBeforeCollapse > 1, `${rowsBeforeCollapse} 行`)
  await firstGroup.click()
  await page.waitForTimeout(200)
  const rowsCollapsed = await previewBox.locator('.sync-row').count()
  check('点击分组头收起', rowsCollapsed < rowsBeforeCollapse, `${rowsBeforeCollapse} → ${rowsCollapsed} 行`)
  // 收起态下按钮必须仍可用：@click.stop 的存在就是为了不让勾选动作顺带把分组展开
  await firstGroup.getByRole('button', { name: '全选本组' }).click()
  await page.waitForTimeout(300)
  check('收起态下仍能整组勾选', (await firstGroup.locator('.sync-group-sel').count()) > 0,
    `分组「${firstGroupName}」`)
  await firstGroup.getByRole('button', { name: '取消本组' }).click()
  await page.waitForTimeout(200)
  check('收起态下取消勾选不会展开', (await previewBox.locator('.sync-row').count()) === rowsCollapsed)
  await firstGroup.click()
  await page.waitForTimeout(200)
  check('再次点击分组头展开', (await previewBox.locator('.sync-row').count()) === rowsBeforeCollapse)

  const l1 = await previewBox.locator('.sync-row', { hasText: '7153729281' }).locator('.sync-branch.via-L1').count()
  check('按需求ID自动匹配到分支（L1）', l1 > 0)
  await page.screenshot({ path: path.join(PROJECT_DIR, 'docs', 'ui-verify-sync.png'), fullPage: false })

  await setOnlyUnregistered(false)
  await page.waitForTimeout(200)
  const doneTag = await previewBox.locator('.sync-row', { hasText: '7154016953' }).locator('.sync-tag-done').count()
  check('已导入的需求被标记', doneTag > 0)

  const firstNewId = ((await previewBox.locator('.sync-row:not(.existing) .sync-id').first().textContent()) || '').trim()
  await previewBox.getByRole('button', { name: '全选新增' }).click()
  await page.waitForTimeout(200)
  const selectedN = Number(((await previewBox.locator('.sync-toolbar .sync-hint').textContent()) || '').match(/已选 (\d+)/)?.[1] || 0)
  const importLabel = ((await previewBox.locator('.sync-footer .btn-purple').textContent()) || '').trim()
  check('全选新增后按钮承诺的条数=已选条数',
    selectedN > 1 && importLabel.includes(String(selectedN)), `${importLabel} / 已选 ${selectedN}`)

  // 勾完再筛选：被筛掉的是**显示**，不该影响已经勾了什么。
  // 旧实现从过滤后的行里取选中项，会出现「按钮说导 N 条、实际只导 1 条」且无任何提示。
  await previewBox.locator('.sync-input').fill(firstNewId)
  await page.waitForTimeout(400)
  const visibleRows = await previewBox.locator('.sync-row').count()
  check('筛选后提示有多少已选行被隐藏',
    visibleRows < selectedN && (await previewBox.locator('.sync-hidden-note').count()) > 0,
    `可见 ${visibleRows} 行 / 已选 ${selectedN}`)

  await previewBox.locator('.sync-footer .btn-purple').click()
  await page.waitForTimeout(800)

  const numBefore = Number((totalBefore.match(/\d+/) || [0])[0])
  const totalAfter = (await page.locator('h1 .sub').textContent()) || ''
  const numAfter = Number((totalAfter.match(/\d+/) || [0])[0])
  check('导入后需求总数增加', totalAfter !== totalBefore, `${totalBefore.trim()} → ${totalAfter.trim()}`)
  check('导入条数按选中集合而不是按筛选结果',
    numAfter - numBefore === selectedN, `新增 ${numAfter - numBefore}，已选 ${selectedN}`)

  // 再拉一次验证去重：需要看见已导入的那些，所以显式关闭「只看未导入」筛选
  await page.getByRole('button', { name: '同步飞书项目' }).click()
  await previewBox.locator('.sync-row, .sync-hint').first().waitFor({ timeout: 240000 })
  await setOnlyUnregistered(false)
  await page.waitForTimeout(300)
  const dedup = await previewBox.locator('.sync-row', { hasText: firstNewId }).locator('.sync-tag-done').count()
  check('重复同步不产生重复需求（按 workItemId 去重）', dedup > 0, `刚导入的 ${firstNewId}`)
  await previewBox.locator('.sync-header .btn-close').click()
  await page.waitForTimeout(200)

  // ===== 9) 同步设置弹窗 =====
  await page.getByRole('button', { name: '同步设置' }).click()
  // 必须先等空间下拉真的有选项：工作项类型在上一阶段已经加载过，
  // 如果只等类型列表，会在空间请求还没回来时就往下走，误判成「0 个空间」。
  // 注意等的是 attached 而不是 visible —— <option> 在闭合的 select 里没有布局盒，
  // Playwright 永远判定为不可见，等 visible 只会白白超时。
  await settingsBox.locator('.sync-field select option').first().waitFor({ state: 'attached', timeout: 60000 })
  const spaceOptions = await settingsBox.locator('.sync-field select option').count()
  check('同步设置加载出空间', spaceOptions > 0, `${spaceOptions} 个空间`)
  const typeCount = await settingsBox.locator('.sync-types .sync-type-item').count()
  check('同步设置加载出工作项类型', typeCount > 5, `${typeCount} 个类型`)
  await settingsBox.locator('.sync-footer .btn-purple').click()
  await page.waitForTimeout(300)

  // ===== 10) 导出的 v2 字段与导入往返 =====
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出' }).click(),
  ])
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'))
  check('导出包含 v2 新增字段',
    ['branchTriage', 'branchLinks', 'meegleConfig'].every(k => k in exported),
    `顶层字段：${Object.keys(exported).join(', ')}`)

  // 往导出文件里加一条「无需需求」处置再导入：验证新增字段能真正被应用并落盘
  exported.branchTriage = exported.branchTriage || {}
  exported.branchTriage['ops-web\u0000feat/mdm二期分支'] = { action: 'exempt', at: Date.now() }
  const importPath = path.join(PROJECT_DIR, '.tmp-import.json')
  fs.writeFileSync(importPath, JSON.stringify(exported))
  await page.locator('input[type=file]').setInputFiles(importPath)
  await page.waitForTimeout(1000)
  check('导入后处置生效（该分支卡片消失）', (await cardOf('feat/mdm二期分支').count()) === 0)
  check('导入后需求数据仍在', (await page.locator('h1 .sub').textContent() || '').includes('共'))
  fs.unlinkSync(importPath)

  // ===== 10b) 备份到项目 backup/ 目录（引擎写盘）=====
  // 下载导出要用户自己挑目录、事后想不起存哪；备份固定落到项目下的 backup/，
  // 所以这里必须验证「浏览器点一下 → 磁盘上真的多出一个文件」，而不是只看 toast。
  const BACKUP_DIR = path.join(PROJECT_DIR, 'backup')
  const listBackups = () => (fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(n => n.endsWith('.json')) : [])
  const before = listBackups()
  const itemsBeforeBackup = Number(((await page.locator('h1 .sub').textContent()) || '').match(/\d+/)?.[0] || 0)

  // 名字必须 exact：默认是子串匹配，「备份」会同时命中「备份记录」
  await page.getByRole('button', { name: '备份', exact: true }).click()
  await page.waitForTimeout(1200)
  const created = listBackups().filter(n => !before.includes(n))
  check('点备份在项目 backup 目录真的写出文件',
    created.length === 1 && /^todoList-发版需求-\d{14}\.json$/.test(created[0]),
    created.join(' , ') || `目录里没有新增文件（现有 ${before.length} 个）`)

  const backupJson = created.length ? JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, created[0]), 'utf8')) : null
  check('备份内容与当前数据一致',
    !!backupJson && Array.isArray(backupJson.items) && backupJson.items.length === itemsBeforeBackup,
    backupJson ? `备份 ${backupJson.items.length} 条 / 页面 ${itemsBeforeBackup} 条` : '没读到备份文件')
  check('备份里带上了 v2 的判断类字段',
    !!backupJson && ['branchTriage', 'branchLinks', 'meegleConfig', 'indexConfig'].every(k => k in backupJson))
  check('备份文件名不含分支索引（派生数据不备份）',
    !!backupJson && !('branchIndex' in backupJson))

  // 备份记录弹窗：列出文件、显示目录，并且恢复是「点两次」的覆盖性操作
  await page.getByRole('button', { name: '备份记录' }).click()
  const backupBox = page.locator('.backup-box')
  await backupBox.locator('.backup-row').first().waitFor({ timeout: 20000 })
  const dirText = ((await backupBox.locator('.backup-path code').textContent()) || '').trim()
  check('备份弹窗显示具体目录', dirText.endsWith('backup') && dirText.includes('发版小助手-v2'), dirText)
  check('备份弹窗列出刚写的备份',
    (await backupBox.locator('.backup-row', { hasText: created[0] || '不存在' }).count()) === 1,
    created[0] || '')
  await backupBox.screenshot({ path: path.join(PROJECT_DIR, 'docs', 'ui-verify-backup.png') })

  // 先改数据（新增一条）再恢复，验证恢复真的把数据拉回备份时的样子
  await backupBox.locator('.sync-footer .btn-outline', { hasText: '关闭' }).click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: '+ 新增需求' }).click()
  await page.getByPlaceholder('需求名称（必填）').fill('备份-恢复前多出来的一条')
  await page.locator('tr.edit-row').getByRole('button', { name: '保存' }).first().click()
  await page.waitForTimeout(500)
  const itemsAfterAdd = Number(((await page.locator('h1 .sub').textContent()) || '').match(/\d+/)?.[0] || 0)
  check('恢复前先造出数据差异', itemsAfterAdd === itemsBeforeBackup + 1, `${itemsBeforeBackup} → ${itemsAfterAdd}`)

  await page.getByRole('button', { name: '备份记录' }).click()
  await backupBox.locator('.backup-row', { hasText: created[0] }).getByRole('button', { name: '恢复' }).click()
  await page.waitForTimeout(300)
  check('恢复需要二次确认',
    (await backupBox.locator('.backup-row', { hasText: created[0] }).getByRole('button', { name: '确认恢复' }).count()) === 1
    && itemsAfterAdd === Number(((await page.locator('h1 .sub').textContent()) || '').match(/\d+/)?.[0] || 0))
  await backupBox.locator('.backup-row', { hasText: created[0] }).getByRole('button', { name: '确认恢复' }).click()
  await page.waitForTimeout(1000)
  const itemsAfterRestore = Number(((await page.locator('h1 .sub').textContent()) || '').match(/\d+/)?.[0] || 0)
  check('恢复把数据整份拉回备份时的状态',
    itemsAfterRestore === itemsBeforeBackup && (await page.getByText('备份-恢复前多出来的一条').count()) === 0,
    `${itemsAfterAdd} → ${itemsAfterRestore}（备份时 ${itemsBeforeBackup}）`)

  // 验证过程写进 backup/ 的是测试数据（98 条假需求），跑完必须清掉，不能留在用户的备份目录里
  for (const f of created) fs.unlinkSync(path.join(BACKUP_DIR, f))
  check('验证产生的测试备份已清理', listBackups().length === before.length, `目录剩 ${listBackups().length} 个`)

  // ===== 11) v1 主路径回归（v2 要替换 v1，必须确认没碰坏老功能）=====
  await page.getByRole('button', { name: '+ 新增需求' }).click()
  await page.getByPlaceholder('需求名称（必填）').fill('回归-新增需求')
  await page.locator('tr.edit-row').getByRole('button', { name: '保存' }).first().click()
  await page.waitForTimeout(500)
  check('v1 新增需求', (await page.getByText('回归-新增需求').count()) > 0)

  const newRow = page.locator('tr', { hasText: '回归-新增需求' })
  await newRow.getByRole('button', { name: '设为待发版' }).click()
  await page.waitForTimeout(400)
  check('v1 状态流转 新建→待发版', ((await newRow.locator('.status-tag').textContent()) || '').includes('待发版'))

  // 有发版中的需求时，「发版中」分组必须仍然可折叠 ——
  // 曾在 sections computed 内部写自己的依赖，导致点折叠后重算又被置回展开
  const releasingSection = page.locator('.section', { has: page.locator('h2', { hasText: '发版中' }) })
  await newRow.getByRole('button', { name: '发版' }).click()
  await page.waitForTimeout(500)
  check('需求可进入发版中', (await page.locator('tr', { hasText: '回归-新增需求' }).locator('.status-tag').textContent() || '').includes('发版中'))
  const releasingArrow = releasingSection.locator('.collapse-header .arrow')
  check('有发版中需求时该分组默认展开', (await releasingArrow.getAttribute('class') || '').includes('open'))
  await releasingSection.locator('.collapse-header').click()
  await page.waitForTimeout(300)
  check('发版中分组可以折叠（computed 不再回写自己的依赖）',
    !(await releasingArrow.getAttribute('class') || '').includes('open'),
    await releasingArrow.getAttribute('class') || '')
  await releasingSection.locator('.collapse-header').click()
  await page.waitForTimeout(300)
  // 「全部发版」在折叠标题内部，没有 @click.stop 就会顺带把分组折叠
  await releasingSection.getByRole('button', { name: '全部发版' }).click()
  await page.waitForTimeout(500)
  check('「全部发版」不会顺带折叠分组',
    (await releasingArrow.getAttribute('class') || '').includes('open'),
    await releasingArrow.getAttribute('class') || '')

  // 分组空了必须能看到空态文案：.empty-state 曾被 display:none 写死，文案永远不显示
  check('空分区的空态文案可见',
    await releasingSection.locator('.empty-state', { hasText: '暂无发版中需求' }).isVisible())

  // 这条路走完把它放回待发版：后面的编辑/删除回归要用同一个待发版的行
  const releasedSection = page.locator('.section', { has: page.locator('h2', { hasText: '已发版' }) })
  await releasedSection.locator('.collapse-header').click()
  await page.waitForTimeout(300)
  await page.locator('tr', { hasText: '回归-新增需求' }).getByRole('button', { name: '恢复待发版' }).click()
  await page.waitForTimeout(400)

  // 表格横向滚动：窄窗口下右侧「操作」列要靠它才够得着
  check('表格容器可横向滚动',
    (await page.locator('.table-wrap').first().evaluate(el => getComputedStyle(el).overflowX)) === 'auto')

  await newRow.getByRole('button', { name: '编辑' }).click()
  await page.getByPlaceholder('需求名称（必填）').fill('回归-编辑后')
  await page.locator('tr.edit-row').getByRole('button', { name: '保存' }).first().click()
  await page.waitForTimeout(400)
  check('v1 编辑保存', (await page.getByText('回归-编辑后').count()) > 0)

  const editedRow = page.locator('tr', { hasText: '回归-编辑后' })
  await editedRow.getByRole('button', { name: '删' }).click()
  await page.waitForTimeout(300)
  // 断言必须看**可见性**：确认弹窗是常驻 DOM、只切 display，
  // 用 count() 判断永远为真，绑定写坏了也照样绿
  check('v1 删除二次确认', await page.getByText('确定删除该需求吗？').isVisible())
  await page.getByRole('button', { name: '确定删除' }).click()
  await page.waitForTimeout(400)
  // 断言必须落在表格行上：删除后会弹「已删除：回归-编辑后」的 toast，
  // 用整页文本判断会被 toast 自己命中，看起来像没删掉
  check('v1 删除后行消失', (await page.locator('tr', { hasText: '回归-编辑后' }).count()) === 0)

  // ===== 11b) 发版主路径：未设上线分支时要先填目标分支 =====
  // 之前的用例预置了 todo_launch_branch，恰好绕过了这条分支，「填写目标分支」的
  // 必填校验一直没被测到 —— 而它正是防止目标分支漏填的那道闸
  await page.evaluate(() => localStorage.removeItem('todo_launch_branch'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
  const launchRow = page.locator('tr', { hasText: 'UI验证-待挂分支' })
  await launchRow.getByRole('button', { name: '发版' }).click()
  await page.waitForTimeout(400)
  const launchDialog = page.locator('.dialog-overlay', { has: page.locator('.confirm-title', { hasText: '请填写各项目的上线目标分支' }) })
  check('未设上线分支时先要求填目标分支', await launchDialog.isVisible())
  await launchDialog.getByRole('button', { name: '确认发版' }).click()
  await page.waitForTimeout(300)
  check('目标分支为空时拦住发版', await launchDialog.isVisible())
  check('拦住时有明确提示',
    (await page.locator('.toast.show', { hasText: '请填写所有项目的目标分支' }).count()) > 0)
  await launchDialog.locator('input[placeholder="目标分支"]').first().fill('master_launched')
  await launchDialog.getByRole('button', { name: '确认发版' }).click()
  await page.waitForTimeout(500)
  check('填写后进入发版中',
    ((await launchRow.locator('.status-tag').textContent()) || '').includes('发版中'))
  await launchRow.getByRole('button', { name: '标记已发版' }).click()
  await page.waitForTimeout(400)
  check('标记已发版',
    ((await launchRow.locator('.status-tag').textContent()) || '').includes('已发版'),
    (await launchRow.locator('.status-tag').textContent()) || '')

  const searchInput = page.getByPlaceholder('搜索需求名称、链接ID或分支名...')
  await searchInput.fill('UI验证-销售预测')
  await page.waitForTimeout(400)
  const filtered = await page.locator('tr', { hasText: 'UI验证-销售预测' }).count()
  const hidden = await page.locator('tr', { hasText: 'UI验证-老数据形态' }).count()
  check('v1 搜索过滤', filtered > 0 && hidden === 0, `命中 ${filtered}，被过滤 ${hidden}`)
  // 未登记分支面板现在也有一个同名清空按钮，必须限定在页头搜索框里
  await page.locator('.header-actions .search-clear').click()

  // 每日提醒：清掉当天标记后刷新，应重新弹出
  await page.evaluate(() => localStorage.removeItem('todo_last_remind_date'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  // 同样必须看可见性：提醒弹窗也常驻 DOM，靠 .show 类控制显隐
  check('v1 每日备份提醒弹出',
    await page.locator('.reminder-overlay.show .reminder-title', { hasText: '数据备份提醒' }).isVisible())
  await page.getByRole('button', { name: '暂不保存' }).click()
  await page.waitForTimeout(300)

  await page.screenshot({ path: path.join(PROJECT_DIR, 'docs', 'ui-verify.png'), fullPage: true })
  console.log(`\n截图已保存: docs/ui-verify.png`)

  // ===== 12) 分支匹配的前置条件诊断（用户实际踩到的场景）=====
  // 真实事故：需求 7134246577 在 pms-web 上明明有分支，预览却逐行显示「未匹配到分支」。
  // 原因是索引没生成/项目没配 —— 但这被逐行文案伪装成了「单条需求的事实」。
  // 12a 没有任何项目时，必须说明真实原因，不能再逐行谎报
  await page.evaluate(() => {
    // 每日提醒的判断是「记录日期 === 今天」才不弹，所以必须写成今天；
    // 写成未来的日期反而会弹出来挡住点击（这里踩过一次）
    const t = new Date()
    const d = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
    localStorage.setItem('todo_last_remind_date', d)
    localStorage.setItem('todo_project_names', '[]')
    localStorage.setItem('todo_branch_index', '{}')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: '同步飞书项目' }).click()
  await previewBox.locator('.sync-note').waitFor({ timeout: 240000 })
  const noProjectNote = ((await previewBox.locator('.sync-note').textContent()) || '').trim()
  check('未配置项目时给出明确原因', /没有配置任何项目/.test(noProjectNote), noProjectNote.slice(0, 70))
  check('此时不再逐行谎报「未匹配到分支」',
    (await previewBox.locator('.sync-branch-none', { hasText: '未匹配到分支' }).count()) === 0)
  await previewBox.locator('.sync-header .btn-close').click()
  await page.waitForTimeout(200)

  // 12b 配上 pms-web（MR 地址 + 本地路径）后，7134246577 必须能匹配到它的真实分支
  await page.evaluate(() => {
    const t = new Date()
    const d = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
    localStorage.setItem('todo_last_remind_date', d)
    localStorage.setItem('todo_project_names', JSON.stringify([
      { name: 'pms-web', mr: 'https://git.joyintoy.cn/joyin/pms-web', localPath: 'C:\\项目\\pms-web' },
    ]))
    localStorage.setItem('todo_branch_index', '{}')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: '同步飞书项目' }).click()
  await previewBox.getByPlaceholder('按名称或需求ID筛选...').waitFor({ timeout: 300000 })
  // 前序阶段已经导入过约 100 条，7134246577 很可能就在其中，需要看得见它才能验证分支匹配
  await setOnlyUnregistered(false)
  await previewBox.getByPlaceholder('按名称或需求ID筛选...').fill('7134246577')
  await page.waitForTimeout(800)
  await previewBox.locator('.sync-branch').first().waitFor({ timeout: 60000 })
  const matched = ((await previewBox.locator('.sync-branch').first().textContent()) || '').trim()
  check('配置 pms-web 后 7134246577 能匹配到分支', /pms-web/.test(matched), matched)
  check('配置齐全时不再显示前置条件提示', (await previewBox.locator('.sync-note').count()) === 0)
  await previewBox.locator('.sync-header .btn-close').click()
  await page.waitForTimeout(200)

  // ===== 13) 分支索引只保留自己创建的分支 =====
  // 用 auth-web 做试金石：它当前的非主线分支全部属于钱龙 / licheng / Liujiangbei，
  // 而 ops-web / pms-web / scm-web 的分支清一色是自己 —— 拿它才能验证过滤真的生效。
  await page.evaluate(() => {
    const t = new Date()
    const d = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
    localStorage.setItem('todo_last_remind_date', d)
    localStorage.setItem('todo_project_names', JSON.stringify([
      { name: 'auth-web', mr: 'https://git.joyintoy.cn/joyin/auth-web', localPath: 'C:\\项目\\auth-web' },
    ]))
    localStorage.setItem('todo_branch_index', '{}')
    localStorage.setItem('todo_branch_triage', '{}')
    localStorage.setItem('todo_index_config', JSON.stringify({ onlyMine: true }))
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  await page.getByRole('button', { name: '刷新分支索引' }).click()
  const scopeHint = page.locator('.unreg-panel .hint', { hasText: '仅我创建的分支' })
  await scopeHint.waitFor({ timeout: 240000 })
  const scopeText = ((await scopeHint.textContent()) || '').trim()
  check('索引默认只保留我创建的分支', /已过滤 \d+ 条他人分支/.test(scopeText), scopeText)
  check('他人分支不再进入未登记列表',
    (await page.locator('.unreg-card').count()) === 0,
    `${await page.locator('.unreg-card').count()} 张卡片`)

  await page.locator('.header-check input').uncheck()
  // 必须等重算的**结果**出现，不能等提示文案 —— 文案只是回显配置，勾选一改就立即翻转，
  // 此时索引还在重算，直接数卡片必然得到旧口径的 0（这里踩过一次）
  await page.locator('.unreg-card').first().waitFor({ timeout: 240000 })
  check('关闭开关后纳入他人分支', (await page.locator('.unreg-card').count()) > 0,
    `${await page.locator('.unreg-card').count()} 张卡片`)
  check('界面标注已切换为包含他人分支',
    (await page.locator('.unreg-panel .hint', { hasText: '包含他人分支' }).count()) > 0)

  // ===== 13) 索引降级必须可见 =====
  // 远端分支列表取不到时不会报错，只退化成「本地 ref 全算数」——
  // 本地那些远端已删除的旧分支会全部变成未登记分支。这种静默降级必须显示出来。
  await page.evaluate(() => {
    localStorage.setItem('todo_project_names', JSON.stringify([
      { name: 'ops-web', mr: 'https://git.joyintoy.invalid/joyin/ops-web', localPath: 'C:\\项目\\ops-web' },
    ]))
    localStorage.setItem('todo_branch_index', '{}')
    localStorage.setItem('todo_index_config', JSON.stringify({ onlyMine: false }))
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: '刷新分支索引' }).click()
  const warn = page.locator('.unreg-panel .hint.warn', { hasText: '远端分支列表未取到' })
  await warn.waitFor({ timeout: 240000 })
  check('远端列表取不到时界面明确告警', await warn.isVisible(), ((await warn.textContent()) || '').trim())
  // 面板默认收起，告警必须在收起态就看得见 —— 否则等于没提示
  check('告警在面板收起时也可见',
    (await page.locator('.unreg-panel .collapse-body.expanded').count()) === 0 && (await warn.isVisible()))

  check('无 JS 未捕获异常', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))

  // ===== 14) 端口漂移提示 =====
  // 浏览器按「协议+主机+端口」隔离 localStorage：引擎漂到 1950 时页面看到的是另一份
  // （通常是空的）数据。这种情况必须明示，否则用户只会以为数据丢了。
  // 用单独的 page 验证，避免它打到不存在的端口污染主流程的错误收集。
  const portFile = path.join(PROJECT_DIR, '.server-port')
  const realPortText = fs.readFileSync(portFile, 'utf8')
  const portPage = await context.newPage()
  try {
    fs.writeFileSync(portFile, '1950')
    await portPage.goto(BASE, { waitUntil: 'domcontentloaded' })
    await portPage.waitForTimeout(700)
    check('引擎端口非默认时给出「数据按来源隔离」提示',
      await portPage.locator('.port-note').isVisible(),
      ((await portPage.locator('.port-note').textContent()) || '').trim())
  } finally {
    fs.writeFileSync(portFile, realPortText)
    await portPage.close()
  }
  check('端口正常时不显示该提示', (await page.locator('.port-note').count()) === 0)

  // toDo.json 不存在时的 404 是 v1 既有正常分支（loadFromJsonFile 会静默回退 localStorage）；
  // favicon 缺失与功能无关。除这两者外出现 4xx/5xx 都算回归。
  const KNOWN_404 = /toDo\.json|favicon\.ico/i
  const unexpected = httpErrors.filter(u => !KNOWN_404.test(u))
  check(
    '无意外 HTTP 错误',
    unexpected.length === 0,
    unexpected.length ? unexpected.join(' | ') : `已知 404 ${httpErrors.length} 个（toDo.json / favicon）`,
  )
} catch (err) {
  check('执行过程未抛异常', false, err.message)
} finally {
  await browser.close()
}

const failed = results.filter(r => !r.ok)
console.log(`\n===== 结果：${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length) {
  failed.forEach(f => console.log(`  ❌ ${f.name} ${f.detail}`))
  process.exit(1)
}
