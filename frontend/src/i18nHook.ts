import { options, type VNode } from 'preact';
import { t } from './i18n.ts';

const HOST_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const;
const COMPONENT_PROPS = ['label', 'title', 'hint', 'placeholder', 'message'] as const;
/** Elements whose text is technical (commands, paths, output) and stays as it is. */
const KEEP = new Set(['code', 'pre', 'kbd', 'samp', 'script', 'style', 'textarea']);

/** Translates the literal texts of an element or component in place (not those of an element with translate={false}). Pure apart from the `props` it receives. */
export function translateProps(type: unknown, props: Record<string, unknown>, tr: (s: string) => string = t): void {
  // `translate={false}` marks user data (file, website and task names): it is shown as it is, even if it equals a text of the interface
  if (props.translate === false || props.translate === 'no') return;
  if (typeof type === 'string') {
    if (KEEP.has(type)) return;
    for (const k of HOST_ATTRS) if (typeof props[k] === 'string') props[k] = tr(props[k]);
    const c = props.children;
    if (typeof c === 'string') props.children = tr(c);
    else if (Array.isArray(c)) props.children = c.map((x) => (typeof x === 'string' ? tr(x) : x));
  } else if (typeof type === 'function') {
    for (const k of COMPONENT_PROPS) if (typeof props[k] === 'string') props[k] = tr(props[k]);
  }
}

/** Installs the hook once; call before the first render. */
export function installTranslation(): void {
  const prev = options.vnode;
  options.vnode = (vnode: VNode) => {
    if (vnode.props) translateProps(vnode.type, vnode.props as Record<string, unknown>);
    prev?.(vnode);
  };
}
