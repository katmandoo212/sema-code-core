import { BashTool } from '../../dist/tools/Bash/Bash.js'
import { getTaskManager } from '../../dist/manager/TaskManager.js'
import { getEventBus } from '../../dist/events/EventSystem.js'
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'

// ─── 测试框架 ────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (!condition) throw new Error(`断言失败: ${msg}`)
}

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ❌ ${name}`)
    console.log(`     ${e.message}`)
    failed++
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const tm = getTaskManager()
const eventBus = getEventBus()

/** 执行 BashTool，返回最终 result.data */
async function run(command, opts = {}) {
  const { timeout = 5000, run_in_background = false, abortController } = opts
  const ac = abortController ?? new AbortController()
  const agentContext = {
    abortController: ac,
    agentId: 'main',
    currentToolUseID: 'tid-' + Date.now(),
  }
  let data
  for await (const result of BashTool.call(
    { command, timeout, description: 'test', run_in_background },
    agentContext,
  )) {
    if (result.type === 'result') data = result.data
  }
  return data
}

/** 从 BashTool 返回消息中解析 taskId 和 filepath */
function parseTaskInfo(msg) {
  const taskId = msg.match(/Task ID: ([a-f0-9]+)/)?.[1]
  const filepath = msg.match(/Output: (.+)$/)?.[1]?.trim()
  return { taskId, filepath }
}

// ════════════════════════════════════════════════════════════════════════════
// Group 1: run_in_background=true（spawnBashTask 路径）
// ════════════════════════════════════════════════════════════════════════════

console.log('\n【Group 1: run_in_background=true】')

await test('命令成功完成：立即返回taskId，waitForTask→completed，output文件有内容', async () => {
  const data = await run('echo "hello_bg"', { run_in_background: true })

  assert(data.stdout.includes('Task ID:'), `应含Task ID: ${data.stdout}`)
  const { taskId, filepath } = parseTaskInfo(data.stdout)
  assert(taskId && filepath, `解析失败: ${data.stdout}`)

  const record = await tm.waitForTask(taskId, 5000)
  assert(record.status === 'completed', `status应为completed，实际=${record.status}`)
  assert(record.exitCode === 0, `exitCode应为0，实际=${record.exitCode}`)
  assert(readFileSync(filepath, 'utf8').includes('hello_bg'), `output文件应含hello_bg`)
})

await test('命令失败：status=failed，exitCode正确', async () => {
  const data = await run('exit 42', { run_in_background: true })
  const { taskId } = parseTaskInfo(data.stdout)
  const record = await tm.waitForTask(taskId, 5000)
  assert(record.status === 'failed', `status应为failed，实际=${record.status}`)
  assert(record.exitCode === 42, `exitCode应为42，实际=${record.exitCode}`)
})

await test('task:start/stream/end事件：字段正确，stream节流≥300ms', async () => {
  let startEvent = null
  const streamEvents = []
  let endEvent = null

  const onStart = e => { startEvent = e }
  const onStream = e => { streamEvents.push({ ...e, _t: Date.now() }) }
  const onEnd = e => { endEvent = e }
  eventBus.on('task:start', onStart)
  eventBus.on('task:stream', onStream)
  eventBus.on('task:end', onEnd)

  const data = await run('for i in 1 2 3; do echo "ev$i"; sleep 0.4; done', { run_in_background: true })
  const { taskId } = parseTaskInfo(data.stdout)
  await tm.waitForTask(taskId, 10000)

  eventBus.off('task:start', onStart)
  eventBus.off('task:stream', onStream)
  eventBus.off('task:end', onEnd)

  assert(startEvent?.taskId === taskId, `task:start taskId不匹配`)
  assert(startEvent?.type === 'Bash', `task:start type应为Bash`)
  assert(startEvent?.filepath, `task:start 应有filepath`)

  assert(endEvent?.taskId === taskId, `task:end taskId不匹配`)
  assert(endEvent?.status === 'completed', `task:end status应为completed`)
  assert(endEvent?.exitCode === 0, `task:end exitCode应为0`)
  assert(typeof endEvent?.summary === 'string', `task:end 应有summary字段`)

  assert(streamEvents.length > 0, `应有task:stream事件`)
  // 节流验证：相邻两个 stream 事件间隔应 ≥ 250ms（留50ms余量）
  for (let i = 1; i < streamEvents.length; i++) {
    const gap = streamEvents[i]._t - streamEvents[i - 1]._t
    assert(gap >= 250, `stream间隔应≥300ms，实际=${gap}ms`)
  }
  // stream output 应为累积值，最后一条应含内容
  assert(streamEvents[streamEvents.length - 1].output.includes('ev'), `最后stream output应有内容`)
})

await test('notifyCallback：完成后触发，含XML格式和filepath', async () => {
  let notifyMsg = null
  tm.setNotifyCallback(msg => { notifyMsg = msg })

  const data = await run('echo notify_test', { run_in_background: true })
  const { taskId, filepath } = parseTaskInfo(data.stdout)
  await tm.waitForTask(taskId, 5000)
  tm.setNotifyCallback(() => {})

  assert(notifyMsg !== null, '应触发notifyCallback')
  assert(notifyMsg.includes('<task-notification>'), `应含<task-notification>: ${notifyMsg}`)
  assert(notifyMsg.includes(`<task-id>${taskId}</task-id>`), `应含taskId`)
  assert(notifyMsg.includes(filepath), `应含filepath`)
  assert(notifyMsg.includes('<status>completed</status>'), `应含completed状态`)
})

await test('stopTask()：进程被杀，status=stopped，task:end触发', async () => {
  let endEvent = null
  const onEnd = e => { endEvent = e }
  eventBus.on('task:end', onEnd)

  const data = await run('sleep 60', { run_in_background: true })
  const { taskId } = parseTaskInfo(data.stdout)

  assert(tm.getTask(taskId).status === 'running', '应为running')
  assert(tm.getRunningTasks().some(t => t.taskId === taskId), 'getRunningTasks应含该任务')

  tm.stopTask(taskId)
  await sleep(200)
  eventBus.off('task:end', onEnd)

  assert(tm.getTask(taskId).status === 'killed', `status应为stopped`)
  assert(!tm.getRunningTasks().some(t => t.taskId === taskId), 'stopped后不应在getRunningTasks中')
  assert(endEvent?.taskId === taskId, `task:end应触发`)
  assert(endEvent?.status === 'killed', `task:end status应为stopped`)
})

await test('waitForTask() timeout：任务运行中时在指定时间内resolve', async () => {
  const data = await run('sleep 30', { run_in_background: true })
  const { taskId } = parseTaskInfo(data.stdout)

  const start = Date.now()
  const record = await tm.waitForTask(taskId, 200)
  const elapsed = Date.now() - start

  assert(elapsed < 500, `应在500ms内返回，实际=${elapsed}ms`)
  assert(record.status === 'running', `status应为running，实际=${record.status}`)

  tm.stopTask(taskId)
})

// ════════════════════════════════════════════════════════════════════════════
// Group 2: 超时接管（takeoverTask 路径）
// ════════════════════════════════════════════════════════════════════════════

console.log('\n【Group 2: 超时接管（takeoverTask）】')

await test('核心：3s超时转后台，call()快速返回，partial output已写入，后续输出继续追加', async () => {
  const start = Date.now()
  const data = await run(
    'for i in 1 2 3 4 5 6 7 8 9 10; do echo "step$i"; sleep 5; done',
    { timeout: 3000 },
  )
  const elapsed = Date.now() - start

  assert(elapsed < 5000, `应在5s内返回，实际=${elapsed}ms`)
  assert(data.stdout.includes('moved to background'), `应含"moved to background": ${data.stdout}`)

  const { taskId, filepath } = parseTaskInfo(data.stdout)
  assert(taskId, `应有taskId`)
  assert(filepath, `应有filepath`)

  const task = tm.getTask(taskId)
  assert(task?.status === 'running', `status应为running，实际=${task?.status}`)
  assert(existsSync(filepath), `output文件应已创建`)

  // 超时前已输出 step1（sleep 之前立即 echo）
  const initialContent = readFileSync(filepath, 'utf8')
  assert(initialContent.includes('step1'), `partial output应含step1，实际: ${JSON.stringify(initialContent)}`)

  // 等待后续输出追加（step2 在命令启动 ~5s 后出现，此时总计 ~7-8s）
  await sleep(4500)
  const laterContent = readFileSync(filepath, 'utf8')
  assert(
    laterContent.length > initialContent.length,
    `等待后文件应增大: before=${initialContent.length} after=${laterContent.length}\n内容=${laterContent}`,
  )
  assert(laterContent.includes('step2'), `应含step2，实际: ${JSON.stringify(laterContent)}`)

  tm.stopTask(taskId)
})

await test('接管后新shell可正常执行命令', async () => {
  // 上一个 Case 已将 PersistentShell.instance 置 null，此处应新建 shell
  const data = await run('echo "new_shell_ok"', { timeout: 5000 })
  assert(!data.interrupted, `命令应正常完成`)
  assert(data.stdout.includes('new_shell_ok'), `stdout应含new_shell_ok，实际=${data.stdout}`)
  assert(!data.stdout.includes('moved to background'), `不应转后台`)
})

await test('接管后 stopTask()：status=stopped，poll timer清理', async () => {
  const data = await run(
    'for i in 1 2 3 4 5; do echo "s$i"; sleep 3; done',
    { timeout: 2000 },
  )
  const { taskId } = parseTaskInfo(data.stdout)
  assert(tm.getTask(taskId)?.status === 'running', '应为running')

  tm.stopTask(taskId)
  await sleep(200)

  const record = tm.getTask(taskId)
  assert(record.status === 'killed', `status应为stopped，实际=${record.status}`)
  assert(!record._pollTimer, `pollTimer应已清理`)
})

await test('接管的shell异常退出（无statusFile）→ 任务failed', async () => {
  // 构造一个已退出的进程
  const proc = spawn('sh', ['-c', 'exit 1'])
  await new Promise(r => proc.on('exit', r))

  const base = `sema-test-${Date.now()}`
  const fakeStdout = join(tmpdir(), `${base}-stdout`)
  const fakeStderr = join(tmpdir(), `${base}-stderr`)
  const fakeStatus = join(tmpdir(), `${base}-status`)  // 不创建，模拟异常退出
  writeFileSync(fakeStdout, 'partial output')
  writeFileSync(fakeStderr, '')

  const { taskId } = tm.takeoverTask(
    {
      stdoutFile: fakeStdout,
      stderrFile: fakeStderr,
      statusFile: fakeStatus,
      shellProcess: proc,
      partialOutput: 'partial output',
    },
    'test-cmd', 'tid-test', {},
  )

  const record = await tm.waitForTask(taskId, 3000)
  assert(record.status === 'failed', `status应为failed，实际=${record.status}`)

  for (const f of [fakeStdout, fakeStderr]) {
    if (existsSync(f)) unlinkSync(f)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// Group 3: 边界
// ════════════════════════════════════════════════════════════════════════════

console.log('\n【Group 3: 边界】')

await test('多任务并发：taskId/filepath唯一，互不干扰，各自完成', async () => {
  const [d1, d2] = await Promise.all([
    run('echo "task_A"', { run_in_background: true }),
    run('echo "task_B"', { run_in_background: true }),
  ])

  const { taskId: id1, filepath: fp1 } = parseTaskInfo(d1.stdout)
  const { taskId: id2, filepath: fp2 } = parseTaskInfo(d2.stdout)

  assert(id1 !== id2, `taskId应唯一: ${id1} vs ${id2}`)
  assert(fp1 !== fp2, `filepath应唯一`)

  await Promise.all([tm.waitForTask(id1, 5000), tm.waitForTask(id2, 5000)])

  assert(tm.getTask(id1).status === 'completed', `task1应completed`)
  assert(tm.getTask(id2).status === 'completed', `task2应completed`)
  assert(readFileSync(fp1, 'utf8').includes('task_A'), `task1 output应含task_A`)
  assert(readFileSync(fp2, 'utf8').includes('task_B'), `task2 output应含task_B`)
})

await test('getTask未知id→undefined，stopTask未知id→不crash', async () => {
  assert(tm.getTask('nonexistent_id_xyz') === undefined, 'getTask未知id应返回undefined')
  // 不抛异常即通过
  tm.stopTask('nonexistent_id_xyz')
})

await test('大输出内存截断：record.output≤2MB，output文件不截断', async () => {
  const data = await run(
    `python3 -c "import sys; sys.stdout.write('a' * 3 * 1024 * 1024)"`,
    { run_in_background: true, timeout: 15000 },
  )
  const { taskId, filepath } = parseTaskInfo(data.stdout)
  const record = await tm.waitForTask(taskId, 15000)

  const MAX = 2 * 1024 * 1024
  assert(record.output.length <= MAX, `内存应≤2MB，实际=${record.output.length}`)
  const fileSize = statSync(filepath).size
  assert(fileSize > MAX, `文件应>2MB，实际=${fileSize}`)
})

await test('dispose()：所有running任务被停止', async () => {
  const [d1, d2] = await Promise.all([
    run('sleep 60', { run_in_background: true }),
    run('sleep 60', { run_in_background: true }),
  ])
  const { taskId: id1 } = parseTaskInfo(d1.stdout)
  const { taskId: id2 } = parseTaskInfo(d2.stdout)

  assert(tm.getTask(id1).status === 'running', 'task1应running')
  assert(tm.getTask(id2).status === 'running', 'task2应running')

  tm.dispose()
  await sleep(200)

  assert(tm.getTask(id1).status === 'killed', `task1应stopped，实际=${tm.getTask(id1).status}`)
  assert(tm.getTask(id2).status === 'killed', `task2应stopped，实际=${tm.getTask(id2).status}`)
})

// ─── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`)
console.log(`结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`)
process.exit(failed > 0 ? 1 : 0)
