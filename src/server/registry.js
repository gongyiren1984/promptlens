import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createError } from '../core/errors.js';
import { createProject, discoverProjects, openProject, projectHealth, projectSummary, MANIFEST_NAME } from '../core/project.js';
import { locateProjectRoot } from '../core/project-admin.js';

const MAX_OPEN_PROJECTS = 8;
const MAX_RECENT = 20;

/**
 * 项目注册表：把“工作区扫描 + 最近项目”映射为 projectId → 项目上下文。
 * 每个项目长期持有一个 SQLite 连接（WAL），并按 LRU 关闭最久未用的连接。
 */
export function createRegistry({ workspaceRoot, home }) {
  let workspace = resolve(workspaceRoot);
  const homeDir = resolve(home ?? process.env.PROMPTLENS_HOME ?? join(homedir(), '.promptlens'));
  const recentPath = join(homeDir, 'recent-projects.json');
  const cache = new Map();
  let recent = readRecent(recentPath);

  function touch(projectId, root, name) {
    recent = [
      { projectId, path: root, name, lastOpenedAt: new Date().toISOString() },
      ...recent.filter((item) => item.projectId !== projectId),
    ].slice(0, MAX_RECENT);
    persistRecent();
  }

  function persistRecent() {
    try {
      mkdirSync(homeDir, { recursive: true });
      const tmp = `${recentPath}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, projects: recent }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, recentPath);
    } catch {
      /* 最近项目索引失败不影响主流程 */
    }
  }

  function list() {
    const byId = new Map();
    for (const item of recent) {
      // 丢弃已移动/删除的最近项，避免把缺少 counts/root 的残缺记录返回给 UI
      if (!existsSync(join(item.path, MANIFEST_NAME))) continue;
      let summary = null;
      try {
        const opened = openProject(item.path);
        summary = projectSummary(opened);
        opened.close();
      } catch {
        summary = {
          projectId: item.projectId,
          name: item.name,
          root: item.path,
          schema: 'unknown',
          archivedAt: null,
          createdAt: null,
          counts: { prompts: 0, cases: 0, runs: 0, reports: 0 },
        };
      }
      byId.set(item.projectId, { ...summary, lastOpenedAt: item.lastOpenedAt ?? null, source: 'recent' });
    }
    for (const summary of discoverProjects(workspace)) {
      const existing = byId.get(summary.projectId);
      byId.set(summary.projectId, {
        ...summary,
        lastOpenedAt: existing?.lastOpenedAt ?? null,
        source: existing ? 'recent' : 'workspace',
      });
    }
    return {
      root: workspace,
      home: homeDir,
      projects: [...byId.values()].sort((a, b) => String(b.lastOpenedAt ?? '').localeCompare(String(a.lastOpenedAt ?? ''))),
    };
  }

  function ctx(projectId) {
    const cached = cache.get(projectId);
    if (cached) {
      cached.lastUsed = Date.now();
      cache.delete(projectId);
      cache.set(projectId, cached);
      return cached.ctx;
    }
    const root = resolveRoot(projectId);
    const opened = openProject(root);
    if (opened.projectId !== projectId) {
      opened.close();
      throw createError('NOT_FOUND_PROJECT', { message: `项目 ID 不匹配: ${projectId}` });
    }
    opened.actor = 'http';
    cache.set(projectId, { ctx: opened, lastUsed: Date.now() });
    evict();
    return opened;
  }

  function resolveRoot(projectId) {
    const entry = recent.find((item) => item.projectId === projectId);
    if (entry && existsSync(join(entry.path, MANIFEST_NAME))) return entry.path;
    const discovered = discoverProjects(workspace).find((item) => item.projectId === projectId);
    if (discovered) return discovered.root;
    throw createError('NOT_FOUND_PROJECT', {
      message: `未找到项目 ${projectId}`,
      remediation: '确认项目目录存在，或在工作区中重新扫描。',
    });
  }

  function evict() {
    while (cache.size > MAX_OPEN_PROJECTS) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) break;
      try {
        oldest[1].ctx.close();
      } catch {
        /* 已关闭 */
      }
      cache.delete(oldest[0]);
    }
  }

  function openByPath(path) {
    const opened = openProject(path);
    opened.actor = 'http';
    const summary = projectSummary(opened);
    const existing = cache.get(summary.projectId);
    if (existing && existing.ctx.root !== opened.root) {
      opened.close();
    } else if (!existing) {
      cache.set(summary.projectId, { ctx: opened, lastUsed: Date.now() });
    } else {
      opened.close();
    }
    touch(summary.projectId, summary.root, summary.name);
    return { ...summary, created: false };
  }

  function create({ path, name }) {
    if (!path) throw createError('VALIDATION_INVALID_REQUEST', { message: '创建项目需要目录路径。' });
    if (existsSync(join(resolve(path), MANIFEST_NAME))) {
      return openByPath(path);
    }
    const { manifest } = createProject({ path, name });
    const result = openByPath(path);
    return { ...result, projectId: manifest.projectId, created: true };
  }

  function health(projectId) {
    return projectHealth(ctx(projectId));
  }

  /** 目录移动后按 projectId 重新定位并修复最近项目索引。 */
  function locate(projectId, searchRoot = workspace) {
    const found = locateProjectRoot({ projectId, searchRoots: [searchRoot] });
    return openByPath(found.root);
  }

  function closeProject(projectId) {
    const entry = cache.get(projectId);
    if (!entry) return false;
    try {
      entry.ctx.close();
    } catch {
      /* 已关闭 */
    }
    cache.delete(projectId);
    return true;
  }

  function forget(projectId) {
    closeProject(projectId);
    recent = recent.filter((item) => item.projectId !== projectId);
    persistRecent();
  }

  function projectIdForRun(runId) {
    const candidates = new Set([...cache.keys()]);
    for (const item of list().projects) candidates.add(item.projectId);
    for (const projectId of candidates) {
      try {
        const project = ctx(projectId);
        const row = project.db.prepare('SELECT id FROM runs WHERE id = ?').get(runId);
        if (row) return projectId;
      } catch {
        /* 跳过不可读项目 */
      }
    }
    throw createError('NOT_FOUND_RUN', { message: `未找到运行 ${runId} 所属项目` });
  }

  function reportIdToProject(reportId) {
    const candidates = new Set([...cache.keys()]);
    for (const item of list().projects) candidates.add(item.projectId);
    for (const projectId of candidates) {
      try {
        const project = ctx(projectId);
        const row = project.db.prepare('SELECT id FROM reports WHERE id = ?').get(reportId);
        if (row) return projectId;
      } catch {
        /* 跳过不可读项目 */
      }
    }
    throw createError('NOT_FOUND_REPORT', { message: `未找到报告 ${reportId} 所属项目` });
  }

  function close() {
    for (const entry of cache.values()) {
      try {
        entry.ctx.close();
      } catch {
        /* 已关闭 */
      }
    }
    cache.clear();
  }

  /** 运行时切换工作区：仅影响扫描范围，已打开项目与最近项目索引保持不变。 */
  function setWorkspace(next) {
    if (typeof next !== 'string' || !next.trim()) {
      throw createError('VALIDATION_INVALID_REQUEST', { message: '工作区路径不能为空。' });
    }
    if (!isAbsolute(next)) {
      throw createError('VALIDATION_INVALID_REQUEST', { message: '工作区路径必须是绝对路径。' });
    }
    const resolved = resolve(next);
    mkdirSync(resolved, { recursive: true });
    workspace = resolved;
    return workspace;
  }

  return {
    get workspace() {
      return workspace;
    },
    setWorkspace,
    home: homeDir,
    list,
    ctx,
    health,
    openByPath,
    create,
    locate,
    closeProject,
    forget,
    projectIdForRun,
    reportIdToProject,
    touch,
    close,
  };
}

function readRecent(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed.projects)) return [];
    return parsed.projects
      .filter((item) => item && typeof item.projectId === 'string' && typeof item.path === 'string')
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}
