/**
 * 受控 YAML 子集解析器：支持缩进映射、序列、标量、行内 JSON。
 * 不支持锚点、标签、块标量（| / >）和复杂多文档；遇到时抛错而不是猜测语义。
 */
export function parseYaml(text) {
  const raw = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines = [];
  for (const line of raw) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') continue;
    if (/^\t/.test(line)) throw new Error('YAML: 不支持制表符缩进');
    lines.push({ indent: line.match(/^ */)[0].length, text: trimmed });
  }
  let index = 0;

  function parseNode(indent) {
    if (index >= lines.length) return null;
    if (lines[index].text.startsWith('-')) return parseList(indent);
    return parseMap(indent);
  }

  function parseMap(indent) {
    const result = {};
    while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith('-')) {
      const text = lines[index].text;
      index += 1;
      const colon = text.indexOf(':');
      if (colon <= 0) throw new Error(`YAML: 无法解析行 "${text}"`);
      const key = unquote(text.slice(0, colon).trim());
      const rest = text.slice(colon + 1).trim();
      if (rest === '') {
        if (index < lines.length && lines[index].indent > indent) {
          result[key] = parseNode(lines[index].indent);
        } else {
          result[key] = null;
        }
      } else if (rest === '|' || rest === '>' || rest === '|-') {
        throw new Error('YAML: 不支持块标量，请改用单行字符串或 JSON');
      } else {
        result[key] = parseScalar(rest);
      }
    }
    return result;
  }

  function parseList(indent) {
    const result = [];
    while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith('-')) {
      const rest = lines[index].text.slice(1).trim();
      index += 1;
      if (!rest) {
        result.push(index < lines.length && lines[index].indent > indent ? parseNode(lines[index].indent) : null);
        continue;
      }
      const colon = rest.indexOf(':');
      const quoted = rest.startsWith('"') || rest.startsWith("'");
      const looksLikeMap = colon > 0 && !quoted && !rest.startsWith('{') && !rest.startsWith('[');
      if (!looksLikeMap) {
        result.push(parseScalar(rest));
        continue;
      }
      const item = {};
      const key = unquote(rest.slice(0, colon).trim());
      const value = rest.slice(colon + 1).trim();
      if (value) {
        item[key] = parseScalar(value);
      } else if (index < lines.length && lines[index].indent > indent) {
        item[key] = parseNode(lines[index].indent);
      } else {
        item[key] = null;
      }
      if (index < lines.length && lines[index].indent > indent && !lines[index].text.startsWith('-')) {
        Object.assign(item, parseMap(lines[index].indent));
      }
      result.push(item);
    }
    return result;
  }

  if (!lines.length) return {};
  const root = parseNode(lines[0].indent);
  if (index < lines.length) throw new Error('YAML: 存在无法归属的缩进内容');
  return root;
}

function parseScalar(text) {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const body = text.slice(1, -1);
    if (text.startsWith('"')) {
      try {
        return JSON.parse(text);
      } catch {
        return body;
      }
    }
    return body.replace(/''/g, "'");
  }
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (text === '[]') return [];
  if (text === '{}') return {};
  return text;
}

function unquote(text) {
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

export function stringifyYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value
      .map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const body = stringifyYaml(item, indent + 2);
          return `${pad}- ${body.trimStart()}`;
        }
        return `${pad}- ${formatScalar(item)}`;
      })
      .join('\n');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, val]) => {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          return `${pad}${key}:\n${stringifyYaml(val, indent + 2)}`;
        }
        if (Array.isArray(val)) {
          if (!val.length) return `${pad}${key}: []`;
          return `${pad}${key}:\n${stringifyYaml(val, indent + 2)}`;
        }
        return `${pad}${key}: ${formatScalar(val)}`;
      })
      .join('\n');
  }
  return `${pad}${formatScalar(value)}`;
}

function formatScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  if (text === '' || /[:#\[\]{}]|^\s|\s$/.test(text)) return JSON.stringify(text);
  return text;
}
