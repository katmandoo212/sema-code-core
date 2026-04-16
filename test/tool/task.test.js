import { TaskCreateTool } from '../../dist/tools/TaskCreate/TaskCreate.js';
import { TaskGetTool } from '../../dist/tools/TaskGet/TaskGet.js';
import { TaskUpdateTool } from '../../dist/tools/TaskUpdate/TaskUpdate.js';
import { TaskListTool } from '../../dist/tools/TaskList/TaskList.js';
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

/** 每个用例前清理 StateManager 中的任务数据 */
function cleanup() {
  const sm = getStateManager();
  sm.clearAllState();
}

// ─── Case 1: TaskCreateTool 基本创建 ────────────────────────────────────────

console.log('\n【Case 1: TaskCreateTool 基本创建】');

await test('创建任务返回递增数字 ID', async () => {
  cleanup();
  const d1 = await run(TaskCreateTool, { subject: '任务一', description: '描述一' });
  assert(d1.task.id === '1', `第一个任务 ID 应为 "1"，实际=${d1.task.id}`);
  assert(d1.task.subject === '任务一', `subject 应匹配`);

  const d2 = await run(TaskCreateTool, { subject: '任务二', description: '描述二' });
  assert(d2.task.id === '2', `第二个任务 ID 应为 "2"，实际=${d2.task.id}`);

  const d3 = await run(TaskCreateTool, { subject: '任务三', description: '描述三' });
  assert(d3.task.id === '3', `第三个任务 ID 应为 "3"，实际=${d3.task.id}`);
});

await test('genResultForAssistant 格式正确', async () => {
  cleanup();
  const data = await run(TaskCreateTool, { subject: '实现用户认证模块', description: '详细描述' });
  const gar = TaskCreateTool.genResultForAssistant(data);
  assert(gar === 'Task #1 created successfully: 实现用户认证模块', `格式不符: ${gar}`);
});

await test('创建时 blocks/blockedBy 初始化为空数组', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '测试任务', description: '描述' });
  const sm = getStateManager();
  const task = sm.forAgent('main').getTodoTask('1');
  assert(Array.isArray(task.blocks) && task.blocks.length === 0, 'blocks 应为空数组');
  assert(Array.isArray(task.blockedBy) && task.blockedBy.length === 0, 'blockedBy 应为空数组');
});

await test('支持 activeForm 和 metadata', async () => {
  cleanup();
  const data = await run(TaskCreateTool, {
    subject: '运行测试',
    description: '运行单元测试',
    activeForm: 'Running tests',
    metadata: { priority: 'high' },
  });
  const sm = getStateManager();
  const task = sm.forAgent('main').getTodoTask(data.task.id);
  assert(task.activeForm === 'Running tests', `activeForm 应匹配`);
  assert(task.metadata.priority === 'high', `metadata 应匹配`);
});

// ─── Case 2: TaskGetTool ────────────────────────────────────────────────────

console.log('\n【Case 2: TaskGetTool】');

await test('获取已有任务返回完整信息', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '分析项目架构', description: '理解模块划分和依赖关系' });
  const data = await run(TaskGetTool, { taskId: '1' });
  assert(data.task !== null, '应返回任务');
  assert(data.task.subject === '分析项目架构', `subject 应匹配`);
  assert(data.task.description === '理解模块划分和依赖关系', `description 应匹配`);
  assert(data.task.status === 'pending', `初始状态应为 pending`);
});

await test('获取不存在的任务返回 null', async () => {
  cleanup();
  const data = await run(TaskGetTool, { taskId: '999' });
  assert(data.task === null, '不存在的任务应返回 null');
  const gar = TaskGetTool.genResultForAssistant(data);
  assert(gar === 'Task not found', `应返回 "Task not found"，实际=${gar}`);
});

await test('genResultForAssistant 格式正确（含阻塞信息）', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '任务A', description: '描述A' });
  await run(TaskCreateTool, { subject: '任务B', description: '描述B' });
  await run(TaskCreateTool, { subject: '任务C', description: '描述C' });
  // B 被 A 阻塞，B 阻塞 C
  await run(TaskUpdateTool, { taskId: '2', addBlockedBy: ['1'], addBlocks: ['3'] });

  const data = await run(TaskGetTool, { taskId: '2' });
  const gar = TaskGetTool.genResultForAssistant(data);
  assert(gar.includes('Task #2: 任务B'), `应包含任务标题`);
  assert(gar.includes('Status: pending'), `应包含状态`);
  assert(gar.includes('Blocked by: #1'), `应包含 blockedBy`);
  assert(gar.includes('Blocks: #3'), `应包含 blocks`);
  console.log(`     genResultForAssistant:\n${gar.split('\n').map(l => `       ${l}`).join('\n')}`);
});

await test('TaskGet 不过滤已完成的阻塞者（返回原始值）', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '任务A', description: '描述A' });
  await run(TaskCreateTool, { subject: '任务B', description: '描述B' });
  await run(TaskUpdateTool, { taskId: '2', addBlockedBy: ['1'] });
  // 完成 A
  await run(TaskUpdateTool, { taskId: '1', status: 'completed' });

  const data = await run(TaskGetTool, { taskId: '2' });
  assert(data.task.blockedBy.includes('1'), 'TaskGet 应保留已完成的阻塞者，不过滤');
});

// ─── Case 3: TaskUpdateTool 状态更新 ────────────────────────────────────────

console.log('\n【Case 3: TaskUpdateTool 状态更新】');

await test('状态流转: pending → in_progress → completed', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '测试任务', description: '描述' });

  const d1 = await run(TaskUpdateTool, { taskId: '1', status: 'in_progress' });
  assert(d1.success === true, '更新应成功');
  assert(d1.updatedFields.includes('status'), 'updatedFields 应包含 status');

  const d2 = await run(TaskUpdateTool, { taskId: '1', status: 'completed' });
  assert(d2.success === true, '更新应成功');

  const task = (await run(TaskGetTool, { taskId: '1' })).task;
  assert(task.status === 'completed', '状态应为 completed');
});

await test('更新不存在的任务返回失败', async () => {
  cleanup();
  const data = await run(TaskUpdateTool, { taskId: '999', status: 'in_progress' });
  assert(data.success === false, '应返回失败');
  assert(data.error === 'Task not found', '错误信息应正确');
});

await test('删除任务 (status=deleted)', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '待删除', description: '描述' });
  const data = await run(TaskUpdateTool, { taskId: '1', status: 'deleted' });
  assert(data.success === true, '删除应成功');
  assert(data.updatedFields.includes('deleted'), 'updatedFields 应包含 deleted');

  const getResult = await run(TaskGetTool, { taskId: '1' });
  assert(getResult.task === null, '删除后应获取不到');
});

await test('genResultForAssistant 格式正确', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '测试', description: '描述' });
  const data = await run(TaskUpdateTool, { taskId: '1', status: 'in_progress' });
  const gar = TaskUpdateTool.genResultForAssistant(data);
  assert(gar === 'Updated task #1 status', `格式不符: ${gar}`);
});

await test('metadata 合并：新增和删除 key', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '元数据测试', description: '描述', metadata: { a: 1, b: 2 } });
  await run(TaskUpdateTool, { taskId: '1', metadata: { b: null, c: 3 } });

  const task = (await run(TaskGetTool, { taskId: '1' })).task;
  assert(task.metadata.a === 1, 'a 应保留');
  assert(task.metadata.b === undefined, 'b 应被删除');
  assert(task.metadata.c === 3, 'c 应被添加');
});

// ─── Case 4: TaskListTool ───────────────────────────────────────────────────

console.log('\n【Case 4: TaskListTool】');

await test('空列表', async () => {
  cleanup();
  const data = await run(TaskListTool, {});
  assert(data.tasks.length === 0, '应为空列表');
  const gar = TaskListTool.genResultForAssistant(data);
  assert(gar === 'No tasks found', `应返回 "No tasks found"，实际=${gar}`);
});

await test('列出多个任务，格式正确', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '实现用户认证模块', description: '描述1' });
  await run(TaskCreateTool, { subject: '编写认证模块的单元测试', description: '描述2' });
  await run(TaskCreateTool, { subject: '分析项目架构', description: '描述3' });

  const data = await run(TaskListTool, {});
  assert(data.tasks.length === 3, '应有3个任务');

  const gar = TaskListTool.genResultForAssistant(data);
  assert(gar.includes('#1 [pending] 实现用户认证模块'), '应包含任务1');
  assert(gar.includes('#2 [pending] 编写认证模块的单元测试'), '应包含任务2');
  assert(gar.includes('#3 [pending] 分析项目架构'), '应包含任务3');
  console.log(`     genResultForAssistant:\n${gar.split('\n').map(l => `       ${l}`).join('\n')}`);
});

await test('TaskList 动态过滤已完成的阻塞者', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '任务A', description: '描述' });
  await run(TaskCreateTool, { subject: '任务B', description: '描述' });
  await run(TaskUpdateTool, { taskId: '2', addBlockedBy: ['1'] });

  // A 未完成时，B 显示被阻塞
  const l1 = await run(TaskListTool, {});
  const taskB1 = l1.tasks.find(t => t.id === '2');
  assert(taskB1.blockedBy.includes('1'), '未完成时应显示阻塞');

  const gar1 = TaskListTool.genResultForAssistant(l1);
  assert(gar1.includes('blocked by #1'), '应显示 blocked by');

  // 完成 A 后，B 的 blockedBy 被过滤
  await run(TaskUpdateTool, { taskId: '1', status: 'completed' });
  const l2 = await run(TaskListTool, {});
  const taskB2 = l2.tasks.find(t => t.id === '2');
  assert(taskB2.blockedBy.length === 0, '完成后应过滤掉');

  const gar2 = TaskListTool.genResultForAssistant(l2);
  assert(!gar2.includes('blocked by'), '完成后不应显示 blocked by');
});

// ─── Case 5: 阻塞依赖机制 ──────────────────────────────────────────────────

console.log('\n【Case 5: 阻塞依赖机制】');

await test('addBlocks 双向写入', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '任务A', description: '描述' });
  await run(TaskCreateTool, { subject: '任务B', description: '描述' });

  // A blocks B
  await run(TaskUpdateTool, { taskId: '1', addBlocks: ['2'] });

  const taskA = (await run(TaskGetTool, { taskId: '1' })).task;
  const taskB = (await run(TaskGetTool, { taskId: '2' })).task;
  assert(taskA.blocks.includes('2'), 'A.blocks 应包含 2');
  assert(taskB.blockedBy.includes('1'), 'B.blockedBy 应包含 1');
});

await test('addBlockedBy 双向写入（方向反转）', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '任务A', description: '描述' });
  await run(TaskCreateTool, { subject: '任务B', description: '描述' });

  // B addBlockedBy A → blockTask(A, B)
  await run(TaskUpdateTool, { taskId: '2', addBlockedBy: ['1'] });

  const taskA = (await run(TaskGetTool, { taskId: '1' })).task;
  const taskB = (await run(TaskGetTool, { taskId: '2' })).task;
  assert(taskA.blocks.includes('2'), 'A.blocks 应包含 2');
  assert(taskB.blockedBy.includes('1'), 'B.blockedBy 应包含 1');
});

await test('重复添加阻塞关系不会重复', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '任务A', description: '描述' });
  await run(TaskCreateTool, { subject: '任务B', description: '描述' });

  await run(TaskUpdateTool, { taskId: '1', addBlocks: ['2'] });
  await run(TaskUpdateTool, { taskId: '1', addBlocks: ['2'] }); // 重复

  const taskA = (await run(TaskGetTool, { taskId: '1' })).task;
  const taskB = (await run(TaskGetTool, { taskId: '2' })).task;
  assert(taskA.blocks.filter(id => id === '2').length === 1, 'blocks 不应重复');
  assert(taskB.blockedBy.filter(id => id === '1').length === 1, 'blockedBy 不应重复');
});

await test('删除任务时清理阻塞引用', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '任务A', description: '描述' });
  await run(TaskCreateTool, { subject: '任务B', description: '描述' });
  await run(TaskCreateTool, { subject: '任务C', description: '描述' });

  // A blocks B, B blocks C
  await run(TaskUpdateTool, { taskId: '1', addBlocks: ['2'] });
  await run(TaskUpdateTool, { taskId: '2', addBlocks: ['3'] });

  // 删除 B
  await run(TaskUpdateTool, { taskId: '2', status: 'deleted' });

  const taskA = (await run(TaskGetTool, { taskId: '1' })).task;
  const taskC = (await run(TaskGetTool, { taskId: '3' })).task;
  assert(!taskA.blocks.includes('2'), '删除 B 后 A.blocks 不应包含 2');
  assert(!taskC.blockedBy.includes('2'), '删除 B 后 C.blockedBy 不应包含 2');
});

await test('多重阻塞关系', async () => {
  cleanup();
  await run(TaskCreateTool, { subject: '任务A', description: '描述' });
  await run(TaskCreateTool, { subject: '任务B', description: '描述' });
  await run(TaskCreateTool, { subject: '任务C', description: '描述' });

  // C 被 A 和 B 同时阻塞
  await run(TaskUpdateTool, { taskId: '3', addBlockedBy: ['1', '2'] });

  const taskC = (await run(TaskGetTool, { taskId: '3' })).task;
  assert(taskC.blockedBy.includes('1'), 'C.blockedBy 应包含 1');
  assert(taskC.blockedBy.includes('2'), 'C.blockedBy 应包含 2');

  const taskA = (await run(TaskGetTool, { taskId: '1' })).task;
  const taskB = (await run(TaskGetTool, { taskId: '2' })).task;
  assert(taskA.blocks.includes('3'), 'A.blocks 应包含 3');
  assert(taskB.blocks.includes('3'), 'B.blocks 应包含 3');

  // 完成 A，TaskList 中 C 仍被 B 阻塞
  await run(TaskUpdateTool, { taskId: '1', status: 'completed' });
  const list = await run(TaskListTool, {});
  const cInList = list.tasks.find(t => t.id === '3');
  assert(cInList.blockedBy.length === 1, 'C 应只剩1个阻塞者');
  assert(cInList.blockedBy.includes('2'), 'C 仍被 B 阻塞');
});

// ─── Case 6: 工具元信息 ────────────────────────────────────────────────────

console.log('\n【Case 6: 工具元信息】');

await test('TaskCreateTool 元信息正确', async () => {
  assert(TaskCreateTool.name === 'TaskCreate', `name=${TaskCreateTool.name}`);
  assert(TaskCreateTool.isReadOnly() === false, '非只读');
  assert(TaskCreateTool.canRunConcurrently() === true, '可并发');
  assert(typeof TaskCreateTool.description() === 'string', 'description 应为字符串');
  assert(TaskCreateTool.getDisplayTitle({ subject: '测试' }).includes('测试'), 'displayTitle 应包含 subject');
});

await test('TaskGetTool 元信息正确', async () => {
  assert(TaskGetTool.name === 'TaskGet', `name=${TaskGetTool.name}`);
  assert(TaskGetTool.isReadOnly() === true, '只读');
  assert(TaskGetTool.canRunConcurrently() === true, '可并发');
});

await test('TaskUpdateTool 元信息正确', async () => {
  assert(TaskUpdateTool.name === 'TaskUpdate', `name=${TaskUpdateTool.name}`);
  assert(TaskUpdateTool.isReadOnly() === false, '非只读');
  assert(TaskUpdateTool.canRunConcurrently() === true, '可并发');
});

await test('TaskListTool 元信息正确', async () => {
  assert(TaskListTool.name === 'TaskList', `name=${TaskListTool.name}`);
  assert(TaskListTool.isReadOnly() === true, '只读');
  assert(TaskListTool.canRunConcurrently() === true, '可并发');
});

// ─── Case 7: 完整工作流 ────────────────────────────────────────────────────

console.log('\n【Case 7: 完整工作流】');

await test('Create → 建依赖 → List → 逐步完成 → List', async () => {
  cleanup();

  // 创建3个任务
  await run(TaskCreateTool, { subject: '设计数据库', description: '设计表结构' });
  await run(TaskCreateTool, { subject: '实现 API', description: '实现 REST API' });
  await run(TaskCreateTool, { subject: '编写测试', description: '编写集成测试' });
  console.log('     创建: #1 设计数据库, #2 实现API, #3 编写测试');

  // 建依赖: 2 被 1 阻塞, 3 被 2 阻塞 (链式: 1→2→3)
  await run(TaskUpdateTool, { taskId: '2', addBlockedBy: ['1'] });
  await run(TaskUpdateTool, { taskId: '3', addBlockedBy: ['2'] });
  console.log('     依赖: #1 → #2 → #3');

  // 列表：显示阻塞关系
  const l1 = await run(TaskListTool, {});
  const gar1 = TaskListTool.genResultForAssistant(l1);
  console.log(`     列表:\n${gar1.split('\n').map(l => `       ${l}`).join('\n')}`);
  assert(gar1.includes('#2') && gar1.includes('blocked by #1'), '#2 应被 #1 阻塞');
  assert(gar1.includes('#3') && gar1.includes('blocked by #2'), '#3 应被 #2 阻塞');

  // 完成 #1
  await run(TaskUpdateTool, { taskId: '1', status: 'in_progress' });
  await run(TaskUpdateTool, { taskId: '1', status: 'completed' });
  console.log('     完成 #1');

  // #2 不再被阻塞，#3 仍被 #2 阻塞
  const l2 = await run(TaskListTool, {});
  const task2 = l2.tasks.find(t => t.id === '2');
  const task3 = l2.tasks.find(t => t.id === '3');
  assert(task2.blockedBy.length === 0, '#2 不再被阻塞');
  assert(task3.blockedBy.includes('2'), '#3 仍被 #2 阻塞');

  // 完成 #2
  await run(TaskUpdateTool, { taskId: '2', status: 'in_progress' });
  await run(TaskUpdateTool, { taskId: '2', status: 'completed' });
  console.log('     完成 #2');

  // #3 不再被阻塞
  const l3 = await run(TaskListTool, {});
  const task3Final = l3.tasks.find(t => t.id === '3');
  assert(task3Final.blockedBy.length === 0, '#3 不再被阻塞');

  const gar3 = TaskListTool.genResultForAssistant(l3);
  console.log(`     最终列表:\n${gar3.split('\n').map(l => `       ${l}`).join('\n')}`);
  console.log('     工作流验证通过');
});

// ─── Case 8: 子代理隔离 ────────────────────────────────────────────────────

console.log('\n【Case 8: 子代理隔离】');

await test('不同 agentId 的任务互相隔离', async () => {
  cleanup();

  // 主代理创建任务
  await run(TaskCreateTool, { subject: '主代理任务', description: '描述' }, { agentId: 'main' });

  // 子代理创建任务
  await run(TaskCreateTool, { subject: '子代理任务', description: '描述' }, { agentId: 'sub-1' });

  // 主代理只能看到自己的任务
  const mainList = await run(TaskListTool, {}, { agentId: 'main' });
  assert(mainList.tasks.length === 1, '主代理应只有1个任务');
  assert(mainList.tasks[0].subject === '主代理任务', '应为主代理的任务');

  // 子代理只能看到自己的任务
  const subList = await run(TaskListTool, {}, { agentId: 'sub-1' });
  assert(subList.tasks.length === 1, '子代理应只有1个任务');
  assert(subList.tasks[0].subject === '子代理任务', '应为子代理的任务');
});

// ─── 结果汇总 ────────────────────────────────────────────────────────────────

cleanup();
console.log(`\n═══════════════════════════════════════`);
console.log(`  通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`);
console.log(`═══════════════════════════════════════\n`);

process.exit(failed > 0 ? 1 : 0);
