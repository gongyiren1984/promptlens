export function safeName(name: string) {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
  return cleaned || 'promptlens-project';
}

export function joinPath(root: string, name: string) {
  const sep = /^[A-Za-z]:/.test(root) || (root.includes('\\') && !root.includes('/')) ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${name}`;
}
