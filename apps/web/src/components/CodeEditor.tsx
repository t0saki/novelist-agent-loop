/** CodeMirror 6 封装（markdown / yaml / json），跟随站点明暗主题。Owner: lane H。 */
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { EditorView } from '@codemirror/view';
import { useMemo } from 'react';
import { useIsDark } from '../lib/theme';

export type EditorLang = 'markdown' | 'yaml' | 'json' | 'text';

export function langForPath(path: string): EditorLang {
  if (/\.(ya?ml)$/i.test(path)) return 'yaml';
  if (/\.(md|markdown)$/i.test(path)) return 'markdown';
  if (/\.jsonl?$/i.test(path)) return 'json';
  return 'text';
}

export function CodeEditor(props: { value: string; onChange?: (v: string) => void; lang: EditorLang; readOnly?: boolean; height?: string }) {
  const dark = useIsDark();
  const ext = useMemo(() => [EditorView.lineWrapping, ...(props.lang === 'markdown' ? [markdown()] : props.lang === 'yaml' ? [yaml()] : [])], [props.lang]);
  return (
    <div className="border border-line rounded-md overflow-hidden">
      <CodeMirror value={props.value} height={props.height ?? '60vh'} theme={dark ? 'dark' : 'light'} extensions={ext} editable={!props.readOnly} readOnly={props.readOnly} onChange={props.onChange} basicSetup={{ foldGutter: false, highlightActiveLine: !props.readOnly }} />
    </div>
  );
}
