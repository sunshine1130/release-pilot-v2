/**
 * Git分支抓取脚本
 * 从导出的JSON文件中读取项目配置，获取近3个月当前用户创建的分支
 * 
 * 使用方法：
 * node fetch-branches.js <json文件路径> [git用户名]
 * 
 * 示例：
 * node fetch-branches.js todoList-发版需求-20260618.json
 * node fetch-branches.js todoList-发版需求-20260618.json myusername
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// 获取命令行参数
const args = process.argv.slice(2)
if (args.length < 1) {
  console.log('使用方法: node fetch-branches.js <json文件路径> [git用户名]')
  console.log('')
  console.log('示例:')
  console.log('  node fetch-branches.js todoList-发版需求-20260618.json')
  console.log('  node fetch-branches.js todoList-发版需求-20260618.json myusername')
  process.exit(1)
}

const jsonFilePath = args[0]
const specifiedUser = args[1] // 可选的用户名参数

// 读取JSON文件
if (!fs.existsSync(jsonFilePath)) {
  console.error(`错误: 文件不存在 - ${jsonFilePath}`)
  process.exit(1)
}

let data
try {
  const content = fs.readFileSync(jsonFilePath, 'utf8')
  data = JSON.parse(content)
} catch (e) {
  console.error(`错误: 无法解析JSON文件 - ${e.message}`)
  process.exit(1)
}

// 获取项目列表
const projects = data.projectNames || []
if (projects.length === 0) {
  console.log('没有找到项目配置')
  process.exit(0)
}

// 计算3个月前的日期
const threeMonthsAgo = new Date()
threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
const dateStr = threeMonthsAgo.toISOString().split('T')[0]

console.log(`\n========================================`)
console.log(`Git分支抓取脚本`)
console.log(`查找从 ${dateStr} 至今创建的分支`)
console.log(`========================================\n`)

// 获取当前git用户（如果没有指定）
let gitUser = specifiedUser
if (!gitUser) {
  try {
    gitUser = execSync('git config user.name', { encoding: 'utf8' }).trim()
    console.log(`当前git用户: ${gitUser}\n`)
  } catch (e) {
    console.log('无法获取git用户名，将显示所有分支\n')
  }
}

// 结果存储
const results = {}

// 遍历每个项目
for (const project of projects) {
  const projectName = project.name
  const localPath = project.localPath

  if (!localPath) {
    console.log(`[${projectName}] - 未配置本地路径，跳过`)
    continue
  }

  // 检查路径是否存在
  const fullPath = path.resolve(localPath)
  if (!fs.existsSync(fullPath)) {
    console.log(`[${projectName}] - 本地路径不存在: ${fullPath}`)
    results[projectName] = { error: '路径不存在', path: fullPath }
    continue
  }

  // 检查是否是git仓库
  const gitDir = path.join(fullPath, '.git')
  if (!fs.existsSync(gitDir)) {
    console.log(`[${projectName}] - 不是git仓库: ${fullPath}`)
    results[projectName] = { error: '不是git仓库', path: fullPath }
    continue
  }

  console.log(`[${projectName}] - 正在获取分支...`)

  try {
    // 获取所有分支（包括远程和本地）
    const branchesCmd = `cd "${fullPath}" && git branch -a --no-color`
    let branchesOutput = execSync(branchesCmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
    
    // 解析分支列表
    const allBranches = branchesOutput
      .split('\n')
      .map(b => b.replace(/^\*?\s*/, '').trim())
      .filter(b => b && !b.includes('HEAD') && b !== '')
    
    // 获取近3个月的提交日志，筛选出当前用户创建的分支
    const logCmd = `cd "${fullPath}" && git log --all --since="${dateStr}" --format="%H %an %ad %s" --date=short`
    let logOutput
    try {
      logOutput = execSync(logCmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
    } catch (e) {
      // 如果日志太大，尝试只获取最近的部分
      logOutput = execSync(`cd "${fullPath}" && git log --all --since="${dateStr}" -n 500 --format="%H %an %ad %s" --date=short`, { encoding: 'utf8' })
    }

    // 解析提交日志
    const commits = logOutput
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const parts = line.split(' ')
        if (parts.length >= 4) {
          return {
            hash: parts[0],
            author: parts[1],
            date: parts[2],
            message: parts.slice(3).join(' ')
          }
        }
        return null
      })
      .filter(c => c)

    // 获取每个分支的最新提交
    const branchCommits = {}
    for (const branch of allBranches) {
      try {
        // 处理远程分支名称
        const branchRef = branch.includes('remotes/') ? branch : branch
        const hashCmd = `cd "${fullPath}" && git rev-parse "${branchRef}" 2>/dev/null || echo ""`
        const hash = execSync(hashCmd, { encoding: 'utf8' }).trim()
        if (hash) {
          branchCommits[branch] = hash
        }
      } catch (e) {
        // 忽略无法解析的分支
      }
    }

    // 找出用户创建的分支
    const userBranches = []
    for (const [branch, hash] of Object.entries(branchCommits)) {
      // 查找这个分支的提交记录
      const branchCommit = commits.find(c => c.hash === hash)
      if (branchCommit) {
        // 如果指定了用户名，只显示该用户的分支
        if (gitUser && branchCommit.author !== gitUser) {
          continue
        }
        userBranches.push({
          branch: branch.replace(/^remotes\/origin\//, '').replace(/^origin\//, ''),
          author: branchCommit.author,
          date: branchCommit.date,
          message: branchCommit.message,
          isRemote: branch.includes('remotes/')
        })
      }
    }

    // 去重并排序
    const uniqueBranches = [...new Map(userBranches.map(b => [b.branch, b])).values()]
    uniqueBranches.sort((a, b) => new Date(b.date) - new Date(a.date))

    results[projectName] = {
      path: fullPath,
      branches: uniqueBranches
    }

    if (uniqueBranches.length > 0) {
      console.log(`  找到 ${uniqueBranches.length} 个分支:`)
      uniqueBranches.forEach(b => {
        const remoteTag = b.isRemote ? '[远程]' : '[本地]'
        console.log(`    ${remoteTag} ${b.branch} (${b.date}) - ${b.author}`)
      })
    } else {
      console.log(`  未找到符合条件的分支`)
    }

  } catch (e) {
    console.log(`  错误: ${e.message}`)
    results[projectName] = { error: e.message, path: fullPath }
  }

  console.log('')
}

// 输出汇总
console.log(`\n========================================`)
console.log(`汇总结果`)
console.log(`========================================\n`)

// 输出JSON格式的结果
const outputPath = jsonFilePath.replace('.json', '-branches.json')
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2))
console.log(`结果已保存到: ${outputPath}\n`)

// 输出简单的分支列表（便于复制）
console.log('分支列表（便于复制）:')
console.log('---')
for (const [project, data] of Object.entries(results)) {
  if (data.branches && data.branches.length > 0) {
    console.log(`\n[${project}]`)
    data.branches.forEach(b => {
      console.log(b.branch)
    })
  }
}
console.log('\n---')