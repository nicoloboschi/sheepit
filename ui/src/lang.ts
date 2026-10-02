// One extension → language-name map, read by both halves of the file viewer:
// the Prism grammar it highlights with and the CodeMirror mode it edits with.
// It lives here rather than in FileView because the editor is lazy-loaded and
// must not pull the viewer in behind it.
export const ext = (name: string): string => (name ?? '').split('.').pop()?.toLowerCase() ?? '';

const EXT_LANG: Record<string, string> = {
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  dockerfile: 'docker', makefile: 'makefile',
  swift: 'swift', kt: 'kotlin', scala: 'scala', r: 'r',
  lua: 'lua', perl: 'perl', php: 'php', dart: 'dart',
  vue: 'html', svelte: 'html', astro: 'html',
  md: 'markdown', mdx: 'markdown', tex: 'latex',
  ini: 'ini', env: 'bash', conf: 'ini', cfg: 'ini',
  proto: 'protobuf', tf: 'hcl',
};
export const getLang = (name: string) => EXT_LANG[ext(name)] ?? 'text';
