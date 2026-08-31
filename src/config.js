const fs = require('node:fs');
const path = require('node:path');

function loadConfig(configPath = process.env.NETWORK_SYSTEM_CONFIG || 'config/config.json') {
  const absolutePath = path.resolve(configPath);
  if (!fs.existsSync(absolutePath) && !process.env.NETWORK_SYSTEM_CONFIG) {
    const examplePath = path.resolve('config/config.example.json');
    fs.copyFileSync(examplePath, absolutePath);
    console.warn(`已由範例建立 ${absolutePath}，正式測試前請修改設備 IP 與 token。`);
  }
  const config = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  validateConfig(config);
  config.__path = absolutePath;
  config.controller.database = path.resolve(path.dirname(absolutePath), '..', config.controller.database);
  return config;
}

function validateConfig(config) {
  const ids = [config?.controller?.localNode?.id, ...(config?.agents || []).map((node) => node.id)];
  if (!config?.controller?.localNode?.address || !config?.controller?.port) {
    throw new Error('config.json 缺少 controller.localNode.address 或 controller.port');
  }
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error('config.json 至少需要一台 agent');
  }
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error('所有節點都必須有不重複的 id');
  }
  if ((config.probe?.intervalMs || 0) < 500) throw new Error('probe.intervalMs 不可小於 500ms');
}

function publicConfig(config) {
  return {
    controller: { localNode: config.controller.localNode, port: config.controller.port },
    agents: config.agents.map(({ token, ...node }) => node),
    probe: config.probe,
    iperf: config.iperf,
    session: config.session
  };
}

module.exports = { loadConfig, validateConfig, publicConfig };
