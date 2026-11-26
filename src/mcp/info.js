import { MCP_DEFAULT_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS } from '../version.js';
import { TOOL_DEFINITIONS } from './server.js';

const DEFAULT_SCOPES = ['project:read', 'run:read'];
const WRITE_SCOPES = ['run:write', 'project:write'];

/** 生成外部 MCP 客户端可直接使用的启动命令；开发模式与 SEA 发布模式均适用。 */
export function mcpInfo({ projectRoot, scopes = DEFAULT_SCOPES }) {
  const isSea = !process.argv[1] || /promptlens-sidecar(\.exe)?$/i.test(process.execPath);
  const command = process.execPath;
  const baseArgs = isSea ? ['mcp', 'serve'] : [process.argv[1], 'mcp', 'serve'];
  const args = [...baseArgs, '--project', projectRoot, '--scopes', scopes.join(',')];
  return {
    mode: 'server',
    transports: ['stdio'],
    defaultProtocolVersion: MCP_DEFAULT_PROTOCOL_VERSION,
    supportedProtocolVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    toolCount: TOOL_DEFINITIONS.length,
    tools: TOOL_DEFINITIONS.map((tool) => tool.name),
    scopes: { default: DEFAULT_SCOPES, write: WRITE_SCOPES },
    projectRoot,
    launch: { command, args },
    clientConfig: {
      mcpServers: {
        promptlens: { command, args },
      },
    },
  };
}
