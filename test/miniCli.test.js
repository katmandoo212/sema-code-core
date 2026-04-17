const { SemaCore } = require('../dist/core/SemaCore');
const readline = require('readline');

const core = new SemaCore({
  workingDir: '/path/to/your/project', // 修改为你的项目路径
  logLevel: 'none',
  thinking: false,
  useTools: ["Bash", "Glob", "Grep", "Read", "Edit", "Write", "Skill", "Task", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "NotebookEdit"]
});

let sessionId = null;
let rl = null;

function createRl() {
  if (rl) rl.close();
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

function prompt(question) {
  return new Promise((resolve) => {
    if (!rl) createRl();
    rl.question(question, resolve);
  });
}

const gray = (s) => `\x1b[90m${s}\x1b[0m`;
const blue = (s) => `\x1b[34m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

const MSG_PROMPT = '👤 消息 (esc中断): ';
const AI_PREFIX = '🤖 AI: ';

function log(event, data) {
  console.log(gray(`${event}|${JSON.stringify(data)}`));
}

async function run() {
  // 创建会话
  await new Promise((resolve) => {
    core.once('session:ready', (data) => {
      sessionId = data.sessionId;
      resolve();
    });
    core.createSession();
  });

  process.on('SIGINT', () => {
    console.log('\n⚠️  中断会话...');
    if (sessionId) core.interruptSession();
    else { rl && rl.close(); process.exit(0); }
  });

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (key && key.name === 'escape') {
      if (sessionId) core.interruptSession();
    }
  });

  // 事件监听
  const events = [
    'tool:execution:start', 'tool:execution:complete', 'tool:execution:error', 'task:agent:start', 'task:agent:end',
    'todos:update', 'session:interrupted'
  ];
  events.forEach(e => core.on(e, (data) => log(e, data)));

  let aiHeaderPrinted = false;
  core.on('message:text:chunk', (data) => {
    process.stdout.write(data.delta || '');
  });
  core.on('message:complete', () => {
    process.stdout.write('\n');
  });
  core.on('state:update', (data) => {
    if (data.state === 'idle') aiHeaderPrinted = false;
  });

  function sendInput(input) {
    process.stdout.write('\n' + green(AI_PREFIX));
    aiHeaderPrinted = true;
    core.processUserInput(input);
  }

  // 工具权限交互
  core.on('tool:permission:request', async (data) => {
    log('tool:permission:request', data);
    const answer = await prompt(blue('👤 权限响应 (y=agree / a=allow / n=refuse): '));
    const map = { y: 'agree', a: 'allow', n: 'refuse' };
    const selected = map[answer.toLowerCase().trim()] || 'agree';
    core.respondToToolPermission({ toolName: data.toolName, selected });
  });

  // 交互循环
  await new Promise((resolve, reject) => {
    core.once('session:error', (data) => { log('session:error', data); reject(new Error(data.message)); });

    core.on('state:update', async (data) => {
      if (data.state === 'idle') {
        setTimeout(async () => {
          const input = (await prompt(blue('\n' + MSG_PROMPT))).trim();
          if (input === 'exit' || input === 'quit') { resolve(); return; }
          if (input) sendInput(input);
        }, 100);
      }
    });

    // 首次输入
    (async () => {
      const input = (await prompt(blue(MSG_PROMPT))).trim();
      if (input === 'exit' || input === 'quit') { resolve(); return; }
      if (input) sendInput(input);
    })();
  });

  console.log('\n=== 会话结束 ===');
  rl && rl.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('错误:', err);
  rl && rl.close();
  process.exit(1);
});
