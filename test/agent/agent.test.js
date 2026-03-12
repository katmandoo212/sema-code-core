const { SemaCore } = require('../../dist/core/SemaCore');

const core = new SemaCore({ 
    workingDir: '/path/to/your/project', // 修改为你的项目路径
    logLevel: 'none' 
});

const newAgentConf = {
  name: 'TestAgent',
  description: '用于测试的自定义 Agent',
  tools: ['Bash', 'Glob', 'Grep', 'Read'],
  model: 'quick',
  prompt: '你是一个测试 Agent，负责回答简单问题。',
  locate: 'user'
};

async function runTests() {
  try {
    // 获取 agents 信息
    const agentsBefore = await core.getAgentsInfo();
    console.log('当前 agents 列表:');
    agentsBefore.forEach(a => console.log(`  - [${a.locate}] ${a.name}: ${a.description.slice(0, 50)}...`));

    // 新增 agent
    console.log('\n新增 agent:', newAgentConf.name);
    const agentsAfter = await core.addAgentConf(newAgentConf);
    console.log('新增后 agents 列表:');
    agentsAfter.forEach(a => console.log(`  - [${a.locate}] ${a.name}: ${a.description.slice(0, 50)}...`));

    // 验证新增成功
    const added = agentsAfter.find(a => a.name === newAgentConf.name);
    if (added) {
      console.log('\n新增成功:', JSON.stringify(added, null, 2));
    } else {
      console.error('\n新增失败: 未找到新增的 agent');
    }
  } catch (error) {
    console.error('测试失败:', error.message);
  }
}

runTests().then(() => process.exit(0)).catch(() => process.exit(1));
