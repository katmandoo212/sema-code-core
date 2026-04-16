import { CronCreateTool } from '../../dist/tools/CronCreate/CronCreate.js';
import { CronDeleteTool } from '../../dist/tools/CronDelete/CronDelete.js';
import { CronListTool } from '../../dist/tools/CronList/CronList.js';
import { getCronManager } from '../../dist/manager/CronManager.js';
import { parseCronExpression, calcNextFireAt, cronToHuman } from '../../dist/util/cron.js';
import { getStateManager } from '../../dist/manager/StateManager.js';

// ─── 测试工具 ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(`断言失败: ${msg}`);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

/** 执行工具并返回最终 result.data */
async function run(tool, input, { agentId = 'main' } = {}) {
  const ac = new AbortController();
  const agentContext = { abortController: ac, agentId, currentToolUseID: 'test-tool-id' };
  let data;
  for await (const result of tool.call(input, agentContext)) {
    if (result.type === 'result') data = result.data;
  }
  return data;
}

/** 每个用例前清理 CronManager */
function cleanup() {
  const mgr = getCronManager();
  for (const task of mgr.listTasks()) {
    mgr.deleteTask(task.id);
  }
}

// ─── Case 1: cron 辅助函数 ────────────────────────────────────────────────

console.log('\n【Case 1: cron 辅助函数】');

await test('parseCronExpression - 合法表达式返回 true', async () => {
  assert(parseCronExpression('*/5 * * * *') === true, '*/5 * * * * 应合法');
  assert(parseCronExpression('0 9 * * 1-5') === true, '0 9 * * 1-5 应合法');
  assert(parseCronExpression('30 14 * * *') === true, '30 14 * * * 应合法');
});

await test('parseCronExpression - 非法表达式返回 false', async () => {
  assert(parseCronExpression('invalid') === false, 'invalid 应非法');
  assert(parseCronExpression('60 * * * *') === false, '60 * * * * 应非法');
  assert(parseCronExpression('a b c d e') === false, '字母表达式应非法');
});

await test('calcNextFireAt - 返回未来时间', async () => {
  const now = Date.now();
  const next = calcNextFireAt('*/5 * * * *', now);
  assert(next !== null, '应返回非 null');
  assert(next > now, '下次触发时间应大于当前时间');
  assert(next - now <= 5 * 60 * 1000, '5分钟内应有触发');
});

await test('calcNextFireAt - 非法表达式返回 null', async () => {
  assert(calcNextFireAt('invalid', Date.now()) === null, '非法表达式应返回 null');
});

await test('cronToHuman - 常见模式转换', async () => {
  assert(cronToHuman('* * * * *') === 'every minute', '每分钟');
  assert(cronToHuman('*/5 * * * *') === 'every 5 minutes', '每5分钟');
  assert(cronToHuman('30 14 * * *') === 'daily at 14:30', '每天14:30');
  assert(cronToHuman('0 9 * * 1-5').includes('9'), '工作日9点');
});

// ─── Case 2: CronManager CRUD ────────────────────────────────────────────

console.log('\n【Case 2: CronManager CRUD】');

await test('createTask - 创建任务并返回 id', async () => {
  cleanup();
  const mgr = getCronManager();
  const id = mgr.createTask('*/5 * * * *', 'test prompt', true, false);
  assert(typeof id === 'string' && id.length > 0, '应返回非空 id');
  assert(mgr.listTasks().length === 1, '应有1个任务');
  const task = mgr.getTask(id);
  assert(task !== undefined, '应能获取到任务');
  assert(task.cron === '*/5 * * * *', 'cron 应匹配');
  assert(task.prompt === 'test prompt', 'prompt 应匹配');
  assert(task.recurring === true, '应为周期任务');
  assert(task.durable === false, '应为非持久化');
  cleanup();
});

await test('deleteTask - 删除已有任务返回 true', async () => {
  cleanup();
  const mgr = getCronManager();
  const id = mgr.createTask('*/5 * * * *', 'to delete', true, false);
  assert(mgr.deleteTask(id) === true, '删除已有任务应返回 true');
  assert(mgr.listTasks().length === 0, '删除后应无任务');
});

await test('deleteTask - 删除不存在的任务返回 false', async () => {
  cleanup();
  const mgr = getCronManager();
  assert(mgr.deleteTask('nonexistent') === false, '删除不存在的任务应返回 false');
});

await test('listTasks - 返回所有任务', async () => {
  cleanup();
  const mgr = getCronManager();
  mgr.createTask('*/1 * * * *', 'task1', true, false);
  mgr.createTask('*/2 * * * *', 'task2', false, false);
  mgr.createTask('*/3 * * * *', 'task3', true, false);
  assert(mgr.listTasks().length === 3, '应有3个任务');
  cleanup();
});

await test('createTask - 超过最大数量抛出错误', async () => {
  cleanup();
  const mgr = getCronManager();
  for (let i = 0; i < 20; i++) {
    mgr.createTask(`${i} * * * *`, `task-${i}`, true, false);
  }
  let threw = false;
  try {
    mgr.createTask('0 0 * * *', 'overflow', true, false);
  } catch (e) {
    threw = true;
    assert(e.message.includes('Maximum'), '错误信息应包含 Maximum');
  }
  assert(threw, '应抛出异常');
  cleanup();
});

// ─── Case 3: CronCreateTool ──────────────────────────────────────────────

console.log('\n【Case 3: CronCreateTool】');

await test('CronCreateTool.call - 正常创建', async () => {
  cleanup();
  const data = await run(CronCreateTool, {
    cron: '*/10 * * * *',
    prompt: 'check status',
  });
  assert(data.id && data.id.length > 0, '应返回 id');
  assert(data.humanSchedule === 'every 10 minutes', 'humanSchedule 应正确');
  assert(data.recurring === true, '默认 recurring=true');
  assert(data.durable === false, '默认 durable=false');

  // 检查 genResultForAssistant
  const gar = CronCreateTool.genResultForAssistant(data);
  assert(typeof gar === 'string' && gar.includes(data.id), 'genResultForAssistant 应包含 id');

  // 检查 genToolResultMessage
  const gtr = CronCreateTool.genToolResultMessage(data);
  assert(gtr.title === 'CronCreate', 'title 应为 CronCreate');
  assert(gtr.summary.includes('10 minutes'), 'summary 应包含 schedule');
  console.log(`     创建结果: id=${data.id}, schedule=${data.humanSchedule}`);
  cleanup();
});

await test('CronCreateTool.call - 指定 recurring=false, durable=true', async () => {
  cleanup();
  const data = await run(CronCreateTool, {
    cron: '30 14 * * *',
    prompt: 'one-shot task',
    recurring: false,
    durable: true,
  });
  assert(data.recurring === false, 'recurring 应为 false');
  assert(data.durable === true, 'durable 应为 true');
  assert(data.humanSchedule === 'daily at 14:30', 'humanSchedule 应正确');
  cleanup();
});

await test('CronCreateTool.validateInput - 非法 cron 应被拒绝', async () => {
  const result = await CronCreateTool.validateInput(
    { cron: 'bad cron', prompt: 'test' },
    { agentId: 'main' }
  );
  assert(result.result === false, '应返回 false');
  assert(result.message.includes('Invalid'), '错误信息应包含 Invalid');
});

await test('CronCreateTool.validateInput - 子代理应被拒绝', async () => {
  const result = await CronCreateTool.validateInput(
    { cron: '*/5 * * * *', prompt: 'test' },
    { agentId: 'sub-agent-1' }
  );
  assert(result.result === false, '子代理应被拒绝');
  assert(result.message.includes('main agent'), '错误信息应提到 main agent');
});

// ─── Case 4: CronDeleteTool ──────────────────────────────────────────────

console.log('\n【Case 4: CronDeleteTool】');

await test('CronDeleteTool.call - 删除已有任务', async () => {
  cleanup();
  const createData = await run(CronCreateTool, { cron: '*/5 * * * *', prompt: 'to delete' });
  const deleteData = await run(CronDeleteTool, { id: createData.id });
  assert(deleteData.id === createData.id, 'id 应匹配');

  const gar = CronDeleteTool.genResultForAssistant(deleteData);
  assert(gar.includes('cancelled'), 'genResultForAssistant 应包含 cancelled');

  assert(getCronManager().listTasks().length === 0, '删除后应无任务');
  cleanup();
});

await test('CronDeleteTool.validateInput - 不存在的任务应被拒绝', async () => {
  cleanup();
  const result = await CronDeleteTool.validateInput({ id: 'nonexistent' });
  assert(result.result === false, '不存在的任务应被拒绝');
  assert(result.message.includes('not found'), '错误信息应包含 not found');
});

// ─── Case 5: CronListTool ────────────────────────────────────────────────

console.log('\n【Case 5: CronListTool】');

await test('CronListTool.call - 空列表', async () => {
  cleanup();
  const data = await run(CronListTool, {});
  assert(Array.isArray(data.jobs), 'jobs 应为数组');
  assert(data.jobs.length === 0, '应为空列表');

  const gar = CronListTool.genResultForAssistant(data);
  assert(gar.includes('No active'), '空列表应显示 No active');

  const gtr = CronListTool.genToolResultMessage(data);
  assert(gtr.summary.includes('0'), 'summary 应包含 0');
});

await test('CronListTool.call - 列出多个任务', async () => {
  cleanup();
  await run(CronCreateTool, { cron: '*/5 * * * *', prompt: 'job1' });
  await run(CronCreateTool, { cron: '0 9 * * 1-5', prompt: 'job2', recurring: true, durable: true });
  await run(CronCreateTool, { cron: '30 14 * * *', prompt: 'job3', recurring: false });

  const data = await run(CronListTool, {});
  assert(data.jobs.length === 3, '应有3个任务');

  for (const job of data.jobs) {
    assert(job.id, '每个 job 应有 id');
    assert(job.cron, '每个 job 应有 cron');
    assert(job.humanSchedule, '每个 job 应有 humanSchedule');
    assert(job.prompt, '每个 job 应有 prompt');
    assert(typeof job.recurring === 'boolean', 'recurring 应为 boolean');
    assert(typeof job.durable === 'boolean', 'durable 应为 boolean');
  }

  const gar = CronListTool.genResultForAssistant(data);
  assert(gar.includes('3'), 'genResultForAssistant 应包含任务数量');

  console.log(`     任务列表:`);
  for (const job of data.jobs) {
    console.log(`       - ${job.id}: "${job.cron}" (${job.humanSchedule}) prompt="${job.prompt}" recurring=${job.recurring} durable=${job.durable}`);
  }
  cleanup();
});

// ─── Case 6: 工具元信息 ──────────────────────────────────────────────────

console.log('\n【Case 6: 工具元信息】');

await test('CronCreateTool 元信息正确', async () => {
  assert(CronCreateTool.name === 'CronCreate', 'name 应为 CronCreate');
  assert(CronCreateTool.isReadOnly() === false, '非只读');
  assert(CronCreateTool.canRunConcurrently() === true, '可并发');
  assert(typeof CronCreateTool.description() === 'string', 'description 应为字符串');
  assert(CronCreateTool.getDisplayTitle({ cron: '*/5 * * * *' }).includes('*/5'), 'displayTitle 应包含 cron');
});

await test('CronDeleteTool 元信息正确', async () => {
  assert(CronDeleteTool.name === 'CronDelete', 'name 应为 CronDelete');
  assert(CronDeleteTool.isReadOnly() === false, '非只读');
  assert(CronDeleteTool.canRunConcurrently() === true, '可并发');
});

await test('CronListTool 元信息正确', async () => {
  assert(CronListTool.name === 'CronList', 'name 应为 CronList');
  assert(CronListTool.isReadOnly() === true, '只读');
  assert(CronListTool.canRunConcurrently() === true, '可并发');
});

// ─── Case 7: 完整工作流 ──────────────────────────────────────────────────

console.log('\n【Case 7: 完整工作流 Create → List → Delete → List】');

await test('创建 → 列表 → 删除 → 列表', async () => {
  cleanup();

  // 创建
  const c1 = await run(CronCreateTool, { cron: '*/5 * * * *', prompt: 'workflow test' });
  console.log(`     创建: id=${c1.id}`);

  // 列表验证
  const l1 = await run(CronListTool, {});
  assert(l1.jobs.length === 1, '创建后应有1个任务');
  assert(l1.jobs[0].id === c1.id, 'id 应匹配');

  // 删除
  const d1 = await run(CronDeleteTool, { id: c1.id });
  assert(d1.id === c1.id, '删除的 id 应匹配');
  console.log(`     删除: id=${d1.id}`);

  // 列表验证
  const l2 = await run(CronListTool, {});
  assert(l2.jobs.length === 0, '删除后应无任务');
  console.log(`     工作流验证通过`);
});

// ─── 结果汇总 ────────────────────────────────────────────────────────────

cleanup();
console.log(`\n═══════════════════════════════════════`);
console.log(`  通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`);
console.log(`═══════════════════════════════════════\n`);

process.exit(failed > 0 ? 1 : 0);
