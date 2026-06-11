// CodeMirror 6 wrapper for the volume-browser file editor.
//
// Lives in its own module so webpack splits it into a separate chunk —
// the bundle isn't paid for until a user actually opens a file. ~150 KB
// gzipped on first open, cached forever after.
//
// Exports:
//   mountEditor(host, text, options) → EditorView
//   mountDiff(host, oldText, newText, options) → MergeView
//   languageFor(filename, firstLine) → CodeMirror Extension
//   THEME_DARK → the One Dark theme extension we reuse everywhere
import { EditorState } from '@codemirror/state';
import {
  EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, keymap, dropCursor,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, indentWithTab,
} from '@codemirror/commands';
import {
  searchKeymap, highlightSelectionMatches,
} from '@codemirror/search';
import {
  bracketMatching, indentOnInput, foldGutter, foldKeymap, defaultHighlightStyle, syntaxHighlighting,
  StreamLanguage,
} from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

// Language packs (each ~5–15 KB)
import { yaml } from '@codemirror/lang-yaml';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';

// Legacy modes for things without dedicated packs (still high-quality)
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { xml } from '@codemirror/legacy-modes/mode/xml';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { perl } from '@codemirror/legacy-modes/mode/perl';

// Diff view (lazy within this lazy module: imported only when caller uses it).
import { MergeView } from '@codemirror/merge';

export const THEME_DARK = oneDark;

/**
 * Pick a CodeMirror language extension from a filename and (optional)
 * first line of content. Returns [] for plain text so the editor still
 * gets line numbers, search, undo, etc. without syntax highlighting.
 */
export function languageFor(filename = '', firstLine = '') {
  const name = String(filename);
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() : '';

  // Filename-based first (Dockerfile, Makefile, .bashrc, …)
  if (/^docker-?compose\..*\.ya?ml$/i.test(name) || /^docker-?compose\.ya?ml$/i.test(name))
    return yaml();
  if (/^dockerfile(\..+)?$/i.test(name) || ext === 'dockerfile')
    return StreamLanguage.define(dockerFile);
  if (/^(makefile|gnumakefile)$/i.test(name) || ext === 'mk')
    return StreamLanguage.define(properties); // close-enough highlight
  if (/^\.?(bash|zsh|profile|bashrc|zshrc|env)(\..+)?$/i.test(name) ||
      /^\.envrc$/i.test(name))
    return StreamLanguage.define(shell);
  if (/^nginx\.conf$|\.nginxconf$/i.test(name) ||
      /^.+\.nginx$/i.test(name))
    return StreamLanguage.define(nginx);

  // Extension-based
  switch (ext) {
    case 'yml': case 'yaml': return yaml();
    case 'json': case 'json5': case 'jsonc': return json();
    case 'py': case 'pyw': case 'pyi': return python();
    case 'js': case 'mjs': case 'cjs': case 'jsx':
    case 'ts': case 'tsx': return javascript({ jsx: ext.endsWith('x'), typescript: ext.startsWith('ts') });
    case 'html': case 'htm': case 'xhtml': return html();
    case 'css': case 'scss': case 'less': return css();
    case 'md': case 'markdown': return markdown();
    case 'sh': case 'bash': case 'zsh': case 'ksh': return StreamLanguage.define(shell);
    case 'conf':
      // /etc/nginx/*.conf is common; default to nginx for .conf since we
      // don't have a generic config highlighter.
      return StreamLanguage.define(nginx);
    case 'ini': case 'properties': case 'env': return StreamLanguage.define(properties);
    case 'toml': return StreamLanguage.define(toml);
    case 'xml': case 'svg': case 'rss': case 'atom': return StreamLanguage.define(xml);
    case 'lua': return StreamLanguage.define(lua);
    case 'rb': case 'ruby': case 'rake': return StreamLanguage.define(ruby);
    case 'pl': case 'pm': return StreamLanguage.define(perl);
    default: break;
  }

  // Shebang fallback
  if (/^#!.*\bpython[0-9.]*\b/.test(firstLine)) return python();
  if (/^#!.*\bnode\b/.test(firstLine)) return javascript();
  if (/^#!.*\b(ba|z|k)?sh\b/.test(firstLine)) return StreamLanguage.define(shell);
  if (/^#!.*\bperl\b/.test(firstLine)) return StreamLanguage.define(perl);
  if (/^#!.*\bruby\b/.test(firstLine)) return StreamLanguage.define(ruby);

  return [];
}

function baseExtensions({ readOnly = false, onChange, onSave } = {}) {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap,
      indentWithTab,
      // Save shortcut. The handler returns true to swallow the event so
      // the browser's "Save page" dialog doesn't open.
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => { if (onSave) onSave(); return true; },
      },
    ]),
    EditorState.readOnly.of(!!readOnly),
    EditorView.lineWrapping,
    EditorView.theme({
      // Match the SPA's dark surface even when no theme extension is
      // applied (the One Dark extension is added separately so the
      // caller can swap it out for a light theme later if we add one).
      '&': { fontSize: '13px', height: '100%' },
      '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflow: 'auto' },
      '.cm-content': { padding: '8px 0' },
      '.cm-gutters': { borderRight: '1px solid #1e293b', backgroundColor: 'transparent' },
    }),
    THEME_DARK,
    EditorView.updateListener.of((v) => {
      if (v.docChanged && onChange) onChange(v.state.doc.toString());
    }),
  ];
}

/**
 * Mount a CodeMirror editor into the given DOM host. Returns the
 * EditorView so callers can read .state.doc.toString(), dispatch
 * .setSelection, .destroy, etc.
 */
export function mountEditor(host, text, options = {}) {
  const firstLine = String(text).split('\n', 1)[0];
  return new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        ...baseExtensions(options),
        languageFor(options.filename || '', firstLine),
      ],
    }),
    parent: host,
  });
}

/**
 * Mount a side-by-side diff (for "show me what I'm about to save").
 * Returns the MergeView; .destroy() to tear it down.
 */
export function mountDiff(host, oldText, newText, options = {}) {
  const firstLine = String(newText).split('\n', 1)[0];
  return new MergeView({
    a: {
      doc: oldText,
      extensions: [
        ...baseExtensions({ readOnly: true }),
        languageFor(options.filename || '', firstLine),
      ],
    },
    b: {
      doc: newText,
      extensions: [
        ...baseExtensions({ readOnly: true }),
        languageFor(options.filename || '', firstLine),
      ],
    },
    parent: host,
    revertControls: false,
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: { margin: 3, minSize: 4 },
  });
}
