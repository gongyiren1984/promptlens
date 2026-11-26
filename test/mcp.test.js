import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createTempProject, seedProject } from './helpers.js';
import { McpClient, stdioTransport } from '../src/mcp/client.js';

test('MCP Client 通过 stdio 连接 Server：工具对等、调用可用并记录 mcp actor', async () => {
  const env = createTempProject('MCP 测试');
  const bin = resolve('bin/promptlens.js');
  const transport = stdioTransport({
    command: process.execPath,
    args: [bin, 'mcp', 'serve', '--project', env.root, '--scopes', 'project:read,project:write,run:read,run:write'],
    cwd: env.root,
  });
  const client = new McpClient({ transport });
  try {
    seedProject(env.ctx);
    const init = await client.initialize();
    assert.equal(init.serverInfo.name, 'promptlens');
    assert.equal(typeof init.protocolVersion, 'string');

    const tools = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of [
      'promptlens_prompts_list',
      'promptlens_prompt_restore',
      'promptlens_cases_import',
      'promptlens_cases_generate',
      'promptlens_eval_profile_create',
      'promptlens_prompt_iterate',
      'promptlens_suggestions_generate',
      'promptlens_run_cost',
      'promptlens_analytics',
      'promptlens_audit_events',
      'promptlens_project_recovery',
      'promptlens_library_list',
    ]) {
      assert.ok(names.includes(name), `缺少 MCP 工具 ${name}`);
    }

    const prompts = await client.callToolData('promptlens_prompts_list');
    assert.equal(prompts.prompts.length, 1);

    const settings = await client.callToolData('promptlens_project_settings_get');
    assert.equal(settings.projectId, env.manifest.projectId);

    await client.callToolData('promptlens_project_settings_patch', { autoReport: false });
    const audit = await client.callToolData('promptlens_audit_events', { limit: 20 });
    const updated = audit.events.find((event) => event.type === 'project.settings_updated');
    assert.ok(updated, '应记录设置更新审计');
    assert.equal(updated.actor, 'mcp');

    const missingRun = await client.callToolData('promptlens_run_cost', { runId: 'nonexistent' }).catch((error) => error);
    assert.equal(missingRun.code, 'NOT_FOUND_RUN');
  } finally {
    client.close();
    env.cleanup();
  }
});
