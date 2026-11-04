/**
 * v1 → v2 迁移路径验证（真实浏览器驱动）
 *
 * 为什么单独一个脚本：v2 对使用者承诺「v1 的数据不用搬」，靠的是三件很容易被顺手改坏的事——
 * ① 沿用 v1 的 localStorage 键名（改个名字，老数据就静默消失）
 * ② 导入要兼容 v1 那份只有 4 个字段的导出文件
 * ③ 导入老文件不能把 v2 新增的分支处置/手工关联/同步设置清空
 * 破坏其中任何一条，用户看到的现象都是「升级后需求全没了」，而接口层一切正常，所以必须用真实浏览器钉住。
 * 顺带钉住「localhost 与 127.0.0.1 是两个源」——这是升级说明里那条硬前提的依据。
 *
 * 运行：另开一个终端执行 `NO_OPEN=1 node server.js`，然后 node scripts/v1-migrate-verify.mjs
 * 前置：.verify.local.json（本脚本只从里面取 playwrightPath）
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ENV_FILE = path.join(PROJECT_DIR, '.verify.local.json')
if (!fs.existsSync(ENV_FILE)) {
  console.error(`\n未找到 ${ENV_FILE}`)
  console.error('请把 scripts/.verify.local.example.json 复制成 .verify.local.json，填上 playwrightPath 后重跑。\n')
  process.exit(1)
}
const ENV = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8'))
const { chromium } = require(ENV.playwrightPath || 'playwright')

function readPort() {
  const f = path.join(PROJECT_DIR, '.server-port')
  if (!fs.existsSync(f)) throw new Error('未找到 .server-port，请先用 NO_OPEN=1 node server.js 启动引擎')
  return Number(fs.readFileSync(f, 'utf8').trim())
}
const PORT = readPort()

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`)
}

// v1 时期的数据形态：需求用 name 字段，projects/syncBranches 是数组，且完全没有 v2 新增的任何字段
const V1_ITEMS = [
  { id: 'v1-a', name: 'V1遗留需求-甲', link: 'https://example.invalid/1', status: 'pending',
    projects: [{ name: 'ops-web', branch: 'feat/legacy-a', notes: '' }], syncBranches: [] },
  { id: 'v1-b', name: 'V1遗留需求-乙', link: '', status: 'new', projects: [], syncBranches: [] },
]
const V1_DATA = { projectNames: ['ops-web'], items: V1_ITEMS, branchesCache: {}, launchBranch: 'master' }

// 分组默认只展开「待发版」、项目管理卡片默认折叠，断言前把它们全部点开
async function expandAll(page) {
  for (const sel of ['.pm-header', '.collapse-header']) {
    const headers = page.locator(sel)
    for (let i = 0; i < (await headers.count()); i++) {
      const h = headers.nth(i)
      const expanded = await h.evaluate(
        (el) => !!el.closest('.section')?.querySelector('.collapse-body.expanded'),
      )
      if (!expanded) await h.click()
    }
  }
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

// ① 同源（localhost）下，v1 写进 localStorage 的老数据，v2 启动时应直接读到
await page.goto(`http://localhost:${PORT}/todo-release.html`)
await page.evaluate((d) => {
  const t = new Date()
  const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  localStorage.setItem('todo_project_names', JSON.stringify(d.projectNames))
  localStorage.setItem('todo_release_data', JSON.stringify(d.items))
  localStorage.setItem('todo_branch_cache', JSON.stringify(d.branchesCache))
  localStorage.setItem('todo_launch_branch', d.launchBranch)
  // 关掉每日备份提醒（遮罩会挡住点击）与自动抓分支，避免干扰
  localStorage.setItem('todo_last_remind_date', today)
  localStorage.setItem('todo_last_branch_fetch_date', today)
}, V1_DATA)
await page.reload()
await page.waitForTimeout(1000)
await expandAll(page)
let body = await page.innerText('body')
check('同源下 v1 老需求自动出现在页面里',
  body.includes('V1遗留需求-甲') && body.includes('V1遗留需求-乙'))
const launchInput = await page.locator('input[placeholder="如 master_launched"]').inputValue()
check('同源下 v1 的项目名与公用上线分支自动带过来',
  body.includes('ops-web') && launchInput === 'master',
  `项目名=${body.includes('ops-web')} 上线分支=${launchInput}`)

// ② v1 的「导出」文件只有 4 个字段，v2 导入后不能把 v2 新增的配置清空
// 先写进 localStorage 再刷新，让 v2 把它加载进内存——否则测的是脚本自己写的值，而不是导入行为
await page.evaluate(() =>
  localStorage.setItem('todo_branch_triage', JSON.stringify({ 'feat/keep-me': { triage: 'ignored' } })),
)
await page.reload()
await page.waitForTimeout(800)
const triageBefore = await page.evaluate(() => localStorage.getItem('todo_branch_triage'))
check('前置：v2 独有配置已被加载', !!triageBefore && triageBefore.includes('feat/keep-me'))

// 夹具写到系统临时目录，避免半路失败时在仓库里留下垃圾文件
const tmpFile = path.join(os.tmpdir(), `v1-export-fixture-${Date.now()}.json`)
fs.writeFileSync(tmpFile, JSON.stringify({
  projectNames: ['pms-web'],
  items: [{ id: 'v1-c', name: 'V1导出文件需求-丙', link: '', status: 'new',
    projects: [{ name: 'pms-web', branch: 'feat/c', notes: '' }], syncBranches: [] }],
  branchesCache: {},
  launchBranch: 'master',
}, null, 2))
await page.setInputFiles('input[type=file][accept=".json"]', tmpFile)
await page.waitForTimeout(1000)
await expandAll(page)
body = await page.innerText('body')
check('v1 导出的 JSON 能被 v2 导入', body.includes('V1导出文件需求-丙'))
check('导入即整体替换（v1 那四个字段按文件内容走）',
  !body.includes('V1遗留需求-甲') && body.includes('pms-web'))
const triage = await page.evaluate(() => localStorage.getItem('todo_branch_triage'))
check('导入 v1 老文件不会清空 v2 新增配置（分支处置保留）',
  !!triage && triage.includes('feat/keep-me'))
fs.unlinkSync(tmpFile)
await page.screenshot({ path: path.join(PROJECT_DIR, 'docs', 'ui-verify-v1-migrate.png') })

// ③ localhost 与 127.0.0.1 是两个不同的源 —— 「用和 v1 相同的地址打开」这条前提的依据
const page2 = await ctx.newPage()
await page2.goto(`http://127.0.0.1:${PORT}/todo-release.html`)
await page2.waitForTimeout(1000)
const body2 = await page2.innerText('body')
check('换主机名（127.0.0.1）就看不到 localhost 那份数据',
  !body2.includes('V1导出文件需求-丙'))

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
console.log('截图: docs/ui-verify-v1-migrate.png')
process.exit(failed.length ? 1 : 0)
