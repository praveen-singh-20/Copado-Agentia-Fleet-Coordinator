// Minimal XML parser for Salesforce metadata files (no dependencies).
// Handles declarations, comments, CDATA, attributes, self-closing tags and the
// standard entities. It is not a validating parser.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      top().text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end === -1) throw new Error('Unterminated comment');
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end === -1) throw new Error('Unterminated CDATA');
      top().text += src.slice(lt + 9, end);
      i = end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end === -1) throw new Error('Unterminated declaration');
      i = end + 2;
    } else if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end === -1 ? src.length : end + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      if (end === -1) throw new Error('Unterminated closing tag');
      const name = src.slice(lt + 2, end).trim();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error(`Mismatched closing tag </${name}>, expected </${node?.name}>`);
      i = end + 1;
    } else {
      // Find the end of the tag, respecting quoted attribute values.
      let j = lt + 1;
      let quote: string | null = null;
      while (j < src.length) {
        const ch = src[j];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
        j++;
      }
      if (j >= src.length) throw new Error('Unterminated tag');
      let body = src.slice(lt + 1, j);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(body);
      if (!m) throw new Error(`Bad tag at offset ${lt}`);
      const node: XmlNode = { name: m[1], attrs: {}, children: [], text: '' };
      const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(body.slice(m[1].length)))) node.attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '');
      top().children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`Unclosed tag <${top().name}>`);
  const el = root.children[0];
  if (!el) throw new Error('No root element');
  return el;
}

/** Strip a namespace prefix ("sf:field" → "field"). */
const local = (n: string) => (n.includes(':') ? n.split(':').pop()! : n);

export const kids = (n: XmlNode | undefined, name: string): XmlNode[] => (n ? n.children.filter((c) => local(c.name) === name) : []);
export const kid = (n: XmlNode | undefined, name: string): XmlNode | undefined => kids(n, name)[0];
export const txt = (n: XmlNode | undefined, name?: string): string | undefined => {
  const t = name ? kid(n, name) : n;
  return t ? t.text.trim() : undefined;
};
export const bool = (n: XmlNode | undefined, name: string): boolean | undefined => {
  const t = txt(n, name);
  return t === undefined ? undefined : t === 'true';
};

/** All descendants with a given local name. */
export function findAll(n: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of n.children) {
    if (local(c.name) === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

/** Every text value in the tree (for reference scanning). */
export function allText(n: XmlNode, out: string[] = []): string[] {
  if (n.text.trim()) out.push(n.text.trim());
  for (const c of n.children) allText(c, out);
  return out;
}
