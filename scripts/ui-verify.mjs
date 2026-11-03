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
]

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
  await page.getByRole('button', { name: /刷新分支索引/ }).click()
  await page.getByText('feat/mdm二期分支').first().waitFor({ timeout: 180000 })

  check(
    '索引请求打到本引擎端口',
    apiCalls.some(u => u.includes(`localhost:${PORT}/api/git/branch-index`)),
    `端口 ${PORT}`,
  )
  check('未登记分支区出现 target 分支', (await page.getByText('feat/mdm二期分支').count()) > 0)
  check('未登记分支带项目标签', (await page.getByText(/ops-web · \d+/).count()) > 0)

  // 4) 影响面提示：融合分支共 5 个需求ID，每条需求看到的「还覆盖」都是 4 个。
  //    两条需求必须都出现提示：一条靠 source.workItemId，一条只能靠链接里提取的ID
  const impacts = await page.getByText(/还覆盖 \d+ 个需求/).allTextContents()
  check('影响面提示数量正确（两条需求都命中）',
    impacts.length === 2 && impacts.every(t => /还覆盖 4 个需求/.test(t)),
    `${impacts.length} 条：${impacts.map(t => t.trim()).join(' / ')}`)

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

  // 7) 恢复
  await page.getByRole('link', { name: '恢复' }).first().click()
  await page.waitForTimeout(300)
  check('恢复后卡片回来', (await cardOf('feat/mdm二期分支').count()) === 1)

  await page.screenshot({ path: path.join(PROJECT_DIR, 'docs', 'ui-verify.png'), fullPage: true })
  console.log(`\n截图已保存: docs/ui-verify.png`)

  check('无 JS 未捕获异常', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))

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
