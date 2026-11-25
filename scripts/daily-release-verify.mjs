/**
 * 批量发版与今日上线分支看板的真实浏览器回归。
 * 页面、Vue、JS、CSS 都走本地 HTTP 实载；只 mock 远端 Git 响应和 window.open，
 * 不启动/停止用户服务，不在真实 GitLab 创建分支。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const envPath = path.join(PROJECT_DIR, '.verify.local.json')
const env = fs.existsSync(envPath) ? JSON.parse(fs.readFileSync(envPath, 'utf8')) : {}
let playwright
for (const candidate of [process.env.PLAYWRIGHT_PATH, env.playwrightPath, 'playwright', 'playwright-core'].filter(Boolean)) {
  try { playwright = require(candidate); break } catch {}
}
if (!playwright) throw new Error('未找到 playwright，请配置 PLAYWRIGHT_PATH 或 .verify.local.json 的 playwrightPath')
const { chromium } = playwright

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const staticServer = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const name = pathname === '/' ? 'todo-release.html' : decodeURIComponent(pathname.slice(1))
  if (!['todo-release.html', 'todo-release.js', 'todo-release.css', 'vue.global.js', '使用说明.html'].includes(name)) {
    res.writeHead(404); res.end(); return
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(name)] || 'text/plain' })
  fs.createReadStream(path.join(PROJECT_DIR, name)).pipe(res)
})
await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${staticServer.address().port}`

const projects = ['backend-a', 'backend-b', 'frontend-c', 'backend-error'].map(name => ({
  name, mr: `https://git.example.com/group/${name}/-/merge_requests`, localPath: ''
}))
const branchItem = name => ({ name, branch: `feat/${name}`, notes: '' })
const items = [
  { id: 'new-a', name: '批量新需求A', link: '', status: 'new', projects: [branchItem('backend-a')], syncBranches: [] },
  { id: 'new-b', name: '批量新需求B', link: '', status: 'new', projects: [branchItem('backend-b')], syncBranches: [] },
  { id: 'pending-a', name: '批量待发版A', link: '', status: 'pending', projects: [branchItem('backend-a')], syncBranches: [] },
  { id: 'pending-b', name: '批量待发版B', link: '', status: 'pending', projects: [branchItem('backend-b')], syncBranches: [] },
  { id: 'release-seed', name: '今日上线项目', link: '', status: 'releasing', projects: projects.map(p => branchItem(p.name)), syncBranches: [] },
]
const daily = () => {
  const d = new Date()
  return `master_${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
})
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.addInitScript(({ projects, items, today }) => {
  if (!localStorage.getItem('uitest_initialized')) {
    localStorage.clear()
    localStorage.setItem('todo_project_names', JSON.stringify(projects))
    localStorage.setItem('todo_release_data', JSON.stringify(items))
    localStorage.setItem('todo_launch_branch', 'master_launched')
    localStorage.setItem('todo_last_remind_date', today)
    localStorage.setItem('todo_last_branch_fetch_date', today)
    localStorage.setItem('uitest_initialized', '1')
  }
  window.__opened = []
  window.__blockOpen = 0
  window.open = url => {
    window.__opened.push(url)
    if (window.__blockOpen > 0) { window.__blockOpen--; return null }
    return { closed: false }
  }
}, { projects, items, today: today() })

const page = await context.newPage()
const jsErrors = []
const branchCalls = []
const externalCalls = []
const exists = { 'backend-a': true, 'backend-b': false, 'frontend-c': false }
let slowChecks = false
let versionCommit = 'uitest'
let versionPid = 101
let updateHasUpdate = false
let updateCheckCalls = 0
page.on('pageerror', e => jsErrors.push(e.message))
await page.route('**/api/**', async route => {
  const req = route.request()
  const url = new URL(req.url())
  if (url.pathname === '/api/system/open-external') {
    externalCalls.push(JSON.parse(req.postData() || '{}').url)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    return
  }
  if (url.pathname === '/api/git/branch-exists') {
    const repo = url.searchParams.get('repo') || ''
    const name = projects.find(p => repo.includes(`/${p.name}.git`))?.name || ''
    branchCalls.push({ name, branch: url.searchParams.get('branch') })
    if (slowChecks) await new Promise(resolve => setTimeout(resolve, 1000))
    if (name === 'backend-error') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'GIT_FAILED', error: '模拟仓库不可用' }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: !!exists[name], branch: url.searchParams.get('branch') }) })
    return
  }
  if (url.pathname === '/api/update/check') {
    updateCheckCalls++
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      configured: true, reachable: true, local: { commit: versionCommit, pid: versionPid },
      remoteLatest: updateHasUpdate ? { commit: 'new1234' } : null,
      hasUpdate: updateHasUpdate, dirty: false,
    }) })
    return
  }
  if (url.pathname === '/api/update/apply') {
    versionCommit = 'new1234'
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      ok: true, to: 'new1234', subject: '模拟引擎更新', files: ['server.js'], engineChanged: true,
    }) })
    return
  }
  if (url.pathname === '/api/version') {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ commit: versionCommit, date: '', subject: '', pid: versionPid }) })
    return
  }
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: 'uitest' }) })
})

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' → ' + detail : ''}`)
}
const card = id => page.locator(`.req-card[data-key="${id}"]`)
const projectRow = name => page.locator('.daily-project-row').filter({ hasText: name })
const storedItems = () => page.evaluate(() => JSON.parse(localStorage.getItem('todo_release_data')))
const mrSource = async name => {
  const href = await projectRow(name).getByRole('link', { name: '打开 MR' }).getAttribute('href')
  return new URL(href).searchParams.get('merge_request[source_branch]')
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.daily-branch-board')
  check('今日看板展示全部发版项目', await page.locator('.daily-project-row').count() === 4)
  check('批量 NB 前不做远端检测', branchCalls.length === 0, `调用 ${branchCalls.length} 次`)
  check('检测前各项目沿用固定上线分支', await mrSource('backend-a') === 'master_launched')

  await page.getByRole('button', { name: '页面 Guide', exact: true }).click()
  await page.waitForSelector('.guide-overlay')
  const firstGuideRect = await page.locator('.guide-spotlight').boundingBox()
  check('页面 Guide 会高亮真实工具条',
    (await page.locator('.guide-tooltip h3').textContent()) === '顶部工具条'
    && firstGuideRect && firstGuideRect.width > 0 && firstGuideRect.height > 0)
  await page.getByRole('button', { name: '下一步' }).click()
  await page.waitForTimeout(450)
  const secondGuideRect = await page.locator('.guide-spotlight').boundingBox()
  check('下一步会移动高亮到真实项目管理区域',
    (await page.locator('.guide-tooltip h3').textContent()) === '项目管理'
    && secondGuideRect && secondGuideRect.y !== firstGuideRect.y,
    `${await page.locator('.guide-tooltip h3').textContent()}：${firstGuideRect?.y} → ${secondGuideRect?.y}`)
  await page.keyboard.press('Escape')
  check('Escape 可退出页面 Guide', await page.locator('.guide-overlay').count() === 0)

  await card('new-a').locator('.batch-check input').check()
  await card('new-b').locator('.batch-check input').check()
  check('勾选后出现批量待发版操作', await page.getByRole('button', { name: '批量设为待发版（2）' }).isVisible())
  await page.getByRole('button', { name: '批量设为待发版（2）' }).click()
  let saved = await storedItems()
  check('批量设为待发版只处理勾选的新建需求',
    ['new-a', 'new-b'].every(id => saved.find(i => i.id === id).status === 'pending')
    && ['pending-a', 'pending-b'].every(id => saved.find(i => i.id === id).status === 'pending'))

  await card('pending-a').locator('.batch-check input').check()
  await card('pending-b').locator('.batch-check input').check()
  await page.getByRole('button', { name: '批量开始发版（2）' }).click()
  saved = await storedItems()
  const releaseTimes = saved.filter(i => ['pending-a', 'pending-b'].includes(i.id)).map(i => i.releaseTime)
  check('批量开始发版只处理勾选的待发版需求',
    ['pending-a', 'pending-b'].every(id => saved.find(i => i.id === id).status === 'releasing')
    && ['new-a', 'new-b'].every(id => saved.find(i => i.id === id).status === 'pending'))
  check('同一次批量发版使用同一发版时间', releaseTimes.length === 2 && releaseTimes[0] && releaseTimes[0] === releaseTimes[1])

  await page.getByRole('button', { name: '批量建立当日上线分支' }).click()
  check('批量 NB 弹窗列出当天分支和全部项目',
    await page.locator('.daily-dialog-project').count() === 4
    && (await page.locator('.daily-branch-dialog').textContent()).includes(daily()))
  await page.getByRole('button', { name: '打开全部新建分支页面' }).click()
  const opened = await page.evaluate(() => window.__opened)
  check('一次点击打开全部项目 NB 页面', opened.length === 4 && opened.every(u => {
    const url = new URL(u)
    return url.searchParams.get('ref') === 'master' && url.searchParams.get('branch_name') === daily()
  }), `${opened.length} 个页面`)

  await page.waitForSelector('.daily-project-row.is-exists')
  await page.waitForSelector('.daily-project-row.is-error')
  check('看板区分已建立、未建立与检测失败',
    (await projectRow('backend-a').textContent()).includes('已建立')
    && (await projectRow('backend-b').textContent()).includes('未建立')
    && (await projectRow('frontend-c').textContent()).includes('未建立')
    && (await projectRow('backend-error').textContent()).includes('检测失败'))
  const errorLayout = await projectRow('backend-error').evaluate(row => {
    const source = row.querySelector('.daily-mr-source').getBoundingClientRect()
    const error = row.querySelector('.daily-error').getBoundingClientRect()
    const actions = row.querySelector('.daily-row-actions').getBoundingClientRect()
    return { sourceBottom: source.bottom, sourceTop: source.top, errorTop: error.top, actionsTop: actions.top }
  })
  check('检测失败原因不会挤乱 MR 源分支和操作按钮',
    errorLayout.sourceBottom <= errorLayout.errorTop + 1
    && errorLayout.actionsTop < errorLayout.errorTop)
  check('检测请求使用当天分支', branchCalls.length >= 4 && branchCalls.every(c => c.branch === daily()), `${branchCalls.length} 次`)
  check('检测到真实分支后自动更新公共上线分支',
    await page.evaluate(() => localStorage.getItem('todo_launch_branch')) === daily())
  check('已建立项目的 MR 使用当天分支', await mrSource('backend-a') === daily())
  check('未建立与前端项目不被全局分支带着走',
    await mrSource('backend-b') === 'master_launched'
    && await mrSource('frontend-c') === 'master_launched'
    && await mrSource('backend-error') === 'master_launched')

  exists['backend-b'] = true
  const focusStarted = Date.now()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(() => document.querySelectorAll('.daily-project-row.is-exists').length >= 2)
  check('切回页面立即补检，无需等待下一轮轮询', Date.now() - focusStarted < 10000 && await mrSource('backend-b') === daily())
  await page.getByRole('button', { name: '停止自动检测' }).click()
  check('可以停止自动检测', await page.getByRole('button', { name: '停止自动检测' }).count() === 0)
  await page.waitForFunction(() => !document.querySelector('.toast.show'))
  await page.screenshot({ path: path.join(PROJECT_DIR, 'docs', 'daily-release-verify.png'), fullPage: true })
  console.log('看板状态截图已保存：docs/daily-release-verify.png')

  // 未配置公共分支时，批量发版仍须逐项目填写目标，并且只流转所选卡片。
  await page.evaluate(() => {
    localStorage.removeItem('todo_launch_branch')
    localStorage.removeItem('todo_daily_branch_check')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await card('new-a').locator('.batch-check input').check()
  await page.getByRole('button', { name: '批量开始发版（1）' }).click()
  const dialog = page.locator('.dialog-overlay', { hasText: '请填写各项目的上线目标分支' })
  check('无公共上线分支时批量发版仍要求填写目标', await dialog.isVisible())
  await dialog.locator('input[placeholder="目标分支"]').fill('master_launched')
  await dialog.getByRole('button', { name: '确认发版' }).click()
  saved = await storedItems()
  check('填写目标后只流转当前勾选需求',
    saved.find(i => i.id === 'new-a').status === 'releasing'
    && saved.find(i => i.id === 'new-b').status === 'pending')

  // 停止必须中止当前序列；自定义固定分支在自动切换后仍要留给未建项目使用。
  Object.keys(exists).forEach(name => { exists[name] = false })
  slowChecks = true
  await page.evaluate(() => {
    localStorage.setItem('todo_launch_branch', 'release_fixed')
    localStorage.removeItem('todo_daily_branch_check')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '批量建立当日上线分支' }).click()
  const firstCheck = page.waitForRequest(req => req.url().includes('/api/git/branch-exists'))
  await page.getByRole('button', { name: '打开全部新建分支页面' }).click()
  await firstCheck
  await page.getByRole('button', { name: '停止自动检测' }).click()
  const callsAtStop = branchCalls.length
  await page.waitForTimeout(1500)
  check('停止会中止当前检测序列且不回写公共分支',
    branchCalls.length === callsAtStop
    && await page.evaluate(() => localStorage.getItem('todo_launch_branch')) === 'release_fixed',
    `停止时 ${callsAtStop} 次，1.5 秒后 ${branchCalls.length} 次`)

  slowChecks = false
  exists['backend-a'] = true
  await page.getByRole('button', { name: '立即检测' }).click()
  await page.waitForSelector('.daily-project-row.is-exists')
  check('自动切换后未建项目仍保留自定义固定上线分支',
    await mrSource('backend-a') === daily()
    && await mrSource('backend-b') === 'release_fixed')

  const stopButton = page.getByRole('button', { name: '停止自动检测' })
  if (await stopButton.count()) await stopButton.click()
  await page.evaluate(() => {
    localStorage.setItem('todo_launch_branch', 'master_launched')
    localStorage.removeItem('todo_daily_branch_check')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  check('未启动批量 NB 时也显示手动检测与空查询时间',
    await page.getByRole('button', { name: '立即检测' }).isVisible()
    && (await page.locator('.daily-board-time').textContent()).includes('—'))
  const callsBeforeManual = branchCalls.length
  await page.getByRole('button', { name: '立即检测' }).click()
  await page.waitForSelector('.daily-project-row.is-exists')
  check('手动检测可识别已建分支并显示最后查询时间',
    branchCalls.length > callsBeforeManual
    && await mrSource('backend-a') === daily()
    && /上次检测：\d{2}:/.test(await page.locator('.daily-board-time').textContent()))
  exists['backend-a'] = false
  await page.getByRole('button', { name: '立即检测' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.daily-project-row')]
    .find(row => row.textContent.includes('backend-a'))?.classList.contains('is-missing'))
  check('远端删除后重查会从已建立变为未建立',
    (await projectRow('backend-a').textContent()).includes('未建立')
    && await mrSource('backend-a') === 'master_launched')

  await page.evaluate(() => { window.__blockOpen = 2 })
  await page.getByRole('button', { name: '批量建立当日上线分支' }).click()
  const tagWidths = await page.locator('.daily-dialog-project').first().evaluate(row => {
    const tag = row.querySelector('.project-tag').getBoundingClientRect()
    const code = row.querySelector('code').getBoundingClientRect()
    const box = row.getBoundingClientRect()
    return { tag: tag.width, track: code.left - box.left - 10 }
  })
  check('批量弹窗项目色条按文字宽度显示', tagWidths.tag < tagWidths.track,
    `色条 ${Math.round(tagWidths.tag)}px / 原列宽 ${Math.round(tagWidths.track)}px`)
  const externalBefore = externalCalls.length
  await page.getByRole('button', { name: '打开全部新建分支页面' }).click()
  await page.waitForFunction(() => document.querySelector('.toast.show')?.textContent.includes('系统浏览器补开 2'))
  check('浏览器拦截的项目由本机引擎逐个补开',
    externalCalls.length - externalBefore === 2
    && externalCalls.slice(-2).every(u => new URL(u).searchParams.get('branch_name') === daily()))

  const overflow = await page.evaluate(() => {
    const board = document.querySelector('.daily-branch-board')
    if (!board) return true
    const right = board.getBoundingClientRect().right
    return [...board.querySelectorAll('*')].some(el => {
      const r = el.getBoundingClientRect()
      return r.width && r.right > right + 1
    })
  })
  check('看板内容没有横向越界', !overflow)
  check('浏览器没有未捕获 JS 异常', jsErrors.length === 0, jsErrors.join(' | '))

  updateHasUpdate = true
  await page.evaluate(() => localStorage.removeItem('todo_update_notice'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.version-badge.has-update')
  check('每天自动检查发现更新后显示绿色有更新',
    (await page.locator('.version-badge').textContent()).trim() === '有更新'
    && await page.locator('.version-badge').evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(16, 185, 129)'))
  await page.locator('.version-badge').click()
  await page.waitForSelector('.version-badge.restart-required')
  check('包含引擎改动时持续提示重启后生效', (await page.locator('.version-badge').textContent()).trim() === '重启后生效')
  const updateCallsAfterApply = updateCheckCalls
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.version-badge.restart-required')
  check('刷新不丢重启提示且当天不重复自动检查', updateCheckCalls === updateCallsAfterApply)
  versionPid = 102
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('.version-badge')?.textContent.trim() === 'vnew1234')
  check('引擎 PID 变化后自动清除重启提示',
    await page.locator('.version-badge.restart-required').count() === 0
    && await page.locator('.version-badge.has-update').count() === 0)

  const help = await context.newPage()
  help.on('pageerror', e => jsErrors.push(e.message))
  await help.goto(base + '/' + encodeURIComponent('使用说明.html'), { waitUntil: 'domcontentloaded' })
  await help.waitForSelector('.doc-section')
  check('使用说明包含分模块导航、页面 Guide 和基础 QA',
    await help.locator('.toc a').count() === 11
    && await help.locator('.doc-section').count() === 11
    && await help.locator('.flow-step').count() === 6
    && await help.locator('#qa details').count() >= 10)
  await help.screenshot({ path: path.join(PROJECT_DIR, 'docs', 'help-verify.png'), fullPage: false })
  await help.locator('.toc a[href="#release"]').click()
  await help.waitForFunction(() => location.hash === '#release'
    && document.querySelector('.toc a[href="#release"]').classList.contains('active'))
  check('模块导航可跳转并高亮当前模块', true)
  const firstQa = help.locator('#qa details').first()
  await firstQa.locator('summary').click()
  check('基础 QA 可展开阅读', await firstQa.evaluate(el => el.open))
  await help.setViewportSize({ width: 390, height: 844 })
  await help.locator('.toc a[href="#quickstart"]').click()
  const helpOverflow = await help.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  check('使用说明在手机宽度下无页面横向溢出', !helpOverflow)
  check('使用说明没有未捕获 JS 异常', jsErrors.length === 0, jsErrors.join(' | '))
} catch (e) {
  check('浏览器回归执行完成', false, e.stack || e.message)
} finally {
  await browser.close()
  await new Promise(resolve => staticServer.close(resolve))
}

const failed = results.filter(r => !r.ok)
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
if (failed.length) process.exitCode = 1
