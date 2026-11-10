import { readFile, mkdir, writeFile } from 'node:fs/promises';

// Self-contained browser modules; React is the Harness shared runtime singleton.
const sources = await Promise.all(['question-replies', 'long-messages', 'sidebar', 'presentation', 'attachment-details', 'client'].map(name => readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8')));
const body = sources.map(source => source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')).join('\n');
const output = `window.__ModuleLoader__.load({\n  id: 'dsh-plugin-codex-import',\n  factory: (require) => {\nconst React = require('react');\n${body}\n    return { name, inject, apply };\n  }\n});\n`;
await mkdir(new URL('../lib/', import.meta.url), { recursive: true });
await writeFile(new URL('../lib/client.js', import.meta.url), output);
