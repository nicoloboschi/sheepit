// The editable half of FileView: CodeMirror plus a language mode per file
// type. Split out of FileView so the 1.1 MB of editor and grammars is fetched
// when you press Edit and not when the Files pane merely shows you a file.
import React from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { php } from '@codemirror/lang-php';
import { go } from '@codemirror/lang-go';
import { sass } from '@codemirror/lang-sass';
import { less } from '@codemirror/lang-less';
import { xml } from '@codemirror/lang-xml';
import { StreamLanguage } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { r as rMode } from '@codemirror/legacy-modes/mode/r';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
import { csharp, scala, kotlin, dart } from '@codemirror/legacy-modes/mode/clike';
import type { Extension } from '@codemirror/state';
import { getLang } from '../lang';

const legacy = (m: Parameters<typeof StreamLanguage.define>[0]): Extension => StreamLanguage.define(m);

function getCmLang(name: string): Extension[] {
  switch (getLang(name)) {
    case 'javascript': return [javascript()];
    case 'jsx':        return [javascript({ jsx: true })];
    case 'typescript': return [javascript({ typescript: true })];
    case 'tsx':        return [javascript({ jsx: true, typescript: true })];
    case 'python':     return [python()];
    case 'css':        return [css()];
    case 'scss':       return [sass()];
    case 'less':       return [less()];
    case 'html':       return [html()];
    case 'xml':        return [xml()];
    case 'json':       return [json()];
    case 'markdown':   return [markdown()];
    case 'rust':       return [rust()];
    case 'java':       return [java()];
    case 'cpp': case 'c': return [cpp()];
    case 'csharp':     return [legacy(csharp)];
    case 'scala':      return [legacy(scala)];
    case 'kotlin':     return [legacy(kotlin)];
    case 'dart':       return [legacy(dart)];
    case 'go':         return [go()];
    case 'sql':        return [sql()];
    case 'yaml':       return [yaml()];
    case 'php':        return [php()];
    case 'bash':       return [legacy(shell)];
    case 'ruby':       return [legacy(ruby)];
    case 'toml':       return [legacy(toml)];
    case 'ini':        return [legacy(properties)];
    case 'swift':      return [legacy(swift)];
    case 'lua':        return [legacy(lua)];
    case 'perl':       return [legacy(perl)];
    case 'r':          return [legacy(rMode)];
    case 'docker':     return [legacy(dockerFile)];
    case 'protobuf':   return [legacy(protobuf)];
    case 'latex':      return [legacy(stex)];
    default:           return [];
  }
}

interface Props {
  /** File name — picks the language mode. */
  name: string;
  value: string;
  onChange: (v: string) => void;
  /** ⌘S inside the editor. */
  onSave: () => void;
}

export default function CodeEditor({ name, value, onChange, onSave }: Props) {
  return (
    <CodeMirror
      value={value}
      extensions={[EditorView.lineWrapping, ...getCmLang(name)]}
      theme={vscodeDark}
      onChange={onChange}
      onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 's' && e.metaKey) { e.preventDefault(); onSave(); } }}
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, tabSize: 2, searchKeymap: false }}
      style={{ fontSize: 13, fontFamily: 'var(--font-mono)', minHeight: '100%' }}
    />
  );
}
