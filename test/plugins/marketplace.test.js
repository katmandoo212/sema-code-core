/**
 * 插件市场管理测试
 * 测试 addMarketplaceFromDirectory / installPlugin / enablePlugin / disablePlugin / uninstallPlugin / removeMarketplace 等
 *
 * 前提：需要一个本地 mock 市场目录（见 createMockMarketplace）
 * 运行：node test/plugins/marketplace.test.js
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const { SemaCore } = require('../../dist/core/SemaCore')

// ===================== Mock 市场目录创建 =====================

function createMockMarketplace(baseDir) {
  const marketplaceDir = path.join(baseDir, 'mock-marketplace')
  const pluginDir = path.join(marketplaceDir, 'plugins', 'demo-plugin')

  // .claude-plugin/marketplace.json
  const metaDir = path.join(marketplaceDir, '.claude-plugin')
  fs.mkdirSync(metaDir, { recursive: true })
  fs.writeFileSync(path.join(metaDir, 'marketplace.json'), JSON.stringify({
    name: 'mock-marketplace',
    plugins: [
      {
        name: 'demo-plugin',
        description: 'A demo plugin for testing',
        author: { name: 'Tester' },
        source: './plugins/demo-plugin'
      }
    ]
  }, null, 2))

  // 插件结构：commands / agents / skills
  fs.mkdirSync(path.join(pluginDir, 'commands'), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'commands', 'demo-cmd.md'), '# demo-cmd')

  fs.mkdirSync(path.join(pluginDir, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'agents', 'demo-agent.md'), '# demo-agent')

  const skillDir = path.join(pluginDir, 'skills', 'demo-skill')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# demo-skill')

  // package.json（版本）
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ version: '0.1.0' }))

  return marketplaceDir
}

// ===================== 主测试流程 =====================

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sema-plugin-test-'))
  const mockMarketplacePath = createMockMarketplace(tmpDir)

  console.log('Mock marketplace:', mockMarketplacePath)

  const core = new SemaCore({ logLevel: 'none' })
  // 等待后台初始化完成（getMarketplacePluginsInfo 第一次调用会等后台加载）

  try {
    // 1. 添加本地目录市场
    console.log('\n[1] addMarketplaceFromDirectory')
    let info = await core.addMarketplaceFromDirectory(mockMarketplacePath)
    const marketplace = info.marketplaces.find(m => m.name === 'mock-marketplace')
    console.log('  marketplace:', JSON.stringify(marketplace, null, 2))
    assert(marketplace, '市场应存在')
    assert(marketplace.available.length > 0, '市场应有可用插件')

    // 2. 安装插件（project scope）
    console.log('\n[2] installPlugin (project)')
    info = await core.installPlugin('demo-plugin', 'mock-marketplace', 'project')
    const plugin = info.plugins.find(p => p.name === 'demo-plugin')
    console.log('  plugin:', JSON.stringify(plugin, null, 2))
    assert(plugin, '插件应已安装')
    assert(plugin.status === true, '安装后插件应为开启状态')
    assert(plugin.components.commands.includes('demo-cmd'), '应有 commands')
    assert(plugin.components.agents.includes('demo-agent'), '应有 agents')
    assert(plugin.components.skills.includes('demo-skill'), '应有 skills')

    // 3. 禁用插件
    console.log('\n[3] disablePlugin')
    info = await core.disablePlugin('demo-plugin', 'mock-marketplace', 'project')
    const disabled = info.plugins.find(p => p.name === 'demo-plugin' && p.scope === 'project')
    console.log('  status:', disabled?.status)
    assert(disabled?.status === false, '插件应为禁用状态')

    // 4. 开启插件
    console.log('\n[4] enablePlugin')
    info = await core.enablePlugin('demo-plugin', 'mock-marketplace', 'project')
    const enabled = info.plugins.find(p => p.name === 'demo-plugin' && p.scope === 'project')
    console.log('  status:', enabled?.status)
    assert(enabled?.status === true, '插件应为开启状态')

    // 5. 更新插件
    console.log('\n[5] updatePlugin')
    info = await core.updatePlugin('demo-plugin', 'mock-marketplace', 'project')
    const updated = info.plugins.find(p => p.name === 'demo-plugin' && p.scope === 'project')
    console.log('  version:', updated?.version)
    assert(updated, '更新后插件应存在')

    // 6. 卸载插件
    console.log('\n[6] uninstallPlugin')
    info = await core.uninstallPlugin('demo-plugin', 'mock-marketplace', 'project')
    const uninstalled = info.plugins.find(p => p.name === 'demo-plugin' && p.scope === 'project')
    console.log('  uninstalled:', !uninstalled)
    assert(!uninstalled, '卸载后插件不应存在')

    // 7. getMarketplacePluginsInfo 返回缓存（不重新加载）
    console.log('\n[7] getMarketplacePluginsInfo (cached)')
    const cached = await core.getMarketplacePluginsInfo()
    assert(Array.isArray(cached.marketplaces), '应返回市场列表')
    console.log('  marketplaces:', cached.marketplaces.map(m => m.name))

    // 8. 刷新市场插件信息
    console.log('\n[8] refreshMarketplacePluginsInfo')
    const refreshed = await core.refreshMarketplacePluginsInfo()
    assert(Array.isArray(refreshed.marketplaces), '刷新后应返回市场列表')
    console.log('  marketplaces:', refreshed.marketplaces.map(m => m.name))

    // 9. 移除市场
    console.log('\n[9] removeMarketplace')
    info = await core.removeMarketplace('mock-marketplace')
    const removed = info.marketplaces.find(m => m.name === 'mock-marketplace')
    console.log('  removed:', !removed)
    assert(!removed, '移除后市场不应存在')

    console.log('\n✅ 所有测试通过')
  } catch (err) {
    console.error('\n❌ 测试失败:', err.message)
    process.exit(1)
  } finally {
    // 清理临时目录
    fs.rmSync(tmpDir, { recursive: true, force: true })
    await core.dispose()
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(`断言失败: ${msg}`)
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err)
  process.exit(1)
})
