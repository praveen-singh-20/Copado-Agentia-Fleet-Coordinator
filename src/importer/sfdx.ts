// Build a MetadataSnapshot from a Salesforce DX source-format project (force-app).
//
// Supported: CustomObject, CustomField, ValidationRule, Flow, ApexClass, ApexTrigger,
// Profile, PermissionSet, Report, Dashboard. Anything else is counted and listed as
// skipped. Systems outside Salesforce (integration mappings, report audiences, data
// classification tags) come from an optional overlay file, labeled "configuration".
//
// Every dependency records how it was found:
//   metadata    – read from a metadata XML element (flow assignments, formulas, report columns)
//   source-code – a field or class token in Apex code
//   inference   – a field name inside an Apex string literal (dynamic SOQL) or an ambiguous token

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Component, ComponentId, Dependency, DependencyKind, MetadataSnapshot, Provenance } from '../core/types.ts';
import { validateSnapshot } from '../graph/metadataGraph.ts';
import { bool, findAll, kid, kids, parseXml, txt, type XmlNode } from '../xml/xml.ts';

export interface Overlay {
  components?: Component[];
  dependencies?: (Omit<Dependency, 'source'> & { source?: Provenance })[];
  tags?: Record<ComponentId, string[]>;
  attributes?: Record<ComponentId, Record<string, unknown>>;
}

export interface ImportResult {
  snapshot: MetadataSnapshot;
  skipped: { file: string; reason: string }[];
  warnings: string[];
}

export interface ImportOptions {
  name?: string;
  origin?: string;
  overlay?: Overlay;
  /** Look for fleet.overlay.json in the project root when no overlay is given. Default true. */
  autoOverlay?: boolean;
}

export const OVERLAY_FILE = 'fleet.overlay.json';

interface Pending {
  component: Component;
  file: string;
  xml?: XmlNode;
  source?: string;
  object?: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.') || e === 'node_modules') continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Package directories from sfdx-project.json, or force-app, or the folder itself. */
export function packageDirs(root: string): string[] {
  const proj = path.join(root, 'sfdx-project.json');
  if (existsSync(proj)) {
    try {
      const dirs = (JSON.parse(readFileSync(proj, 'utf8')).packageDirectories ?? []) as { path: string }[];
      const found = dirs.map((d) => path.join(root, d.path)).filter((d) => existsSync(d));
      if (found.length) return found;
    } catch {
      /* fall through */
    }
  }
  if (existsSync(path.join(root, 'force-app'))) return [path.join(root, 'force-app')];
  return [root];
}

const isCustom = (api: string) => /__c$/.test(api);

/** Remove Apex comments and split code from string literals. */
export function splitApex(src: string): { code: string; strings: string[] } {
  let code = '';
  const strings: string[] = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      const e = src.indexOf('\n', i);
      i = e === -1 ? src.length : e;
    } else if (src.startsWith('/*', i)) {
      const e = src.indexOf('*/', i + 2);
      i = e === -1 ? src.length : e + 2;
    } else if (src[i] === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\') {
          s += src[j + 1] ?? '';
          j += 2;
        } else s += src[j++];
      }
      strings.push(s);
      code += "''";
      i = j + 1;
    } else code += src[i++];
  }
  return { code, strings };
}

export function importSfdx(root: string, opts: ImportOptions = {}): ImportResult {
  if (!existsSync(root)) throw new Error(`Project folder not found: ${root}`);
  const skipped: ImportResult['skipped'] = [];
  const warnings: string[] = [];
  const pending: Pending[] = [];
  const add = (p: Pending) => {
    const files = [p.file, ...(existsSync(`${p.file}-meta.xml`) ? [`${p.file}-meta.xml`] : [])];
    const h = createHash('sha1');
    for (const f of files) h.update(readFileSync(f));
    p.component.hash = h.digest('hex').slice(0, 16);
    pending.push(p);
  };
  const readXml = (f: string): XmlNode | undefined => {
    try {
      return parseXml(readFileSync(f, 'utf8'));
    } catch (e) {
      skipped.push({ file: f, reason: `XML parse error: ${(e as Error).message}` });
      return undefined;
    }
  };

  for (const dir of packageDirs(root)) {
    for (const file of walk(dir)) {
      const base = path.basename(file);
      const parts = file.split(path.sep);
      const parent = parts[parts.length - 2];
      const grand = parts[parts.length - 3];
      let m: RegExpMatchArray | null;

      if ((m = base.match(/^(.+)\.object-meta\.xml$/))) {
        const xml = readXml(file);
        if (xml) add({ file, xml, component: { id: `CustomObject:${m[1]}`, type: 'CustomObject', attributes: { label: txt(xml, 'label') } } });
      } else if ((m = base.match(/^(.+)\.field-meta\.xml$/)) && parent === 'fields') {
        const xml = readXml(file);
        if (!xml) continue;
        const values = findAll(xml, 'value').map((v) => txt(v, 'fullName')).filter(Boolean);
        add({
          file,
          xml,
          object: grand,
          component: {
            id: `CustomField:${grand}.${m[1]}`,
            type: 'CustomField',
            attributes: clean({
              label: txt(xml, 'label'),
              fieldType: txt(xml, 'type'),
              length: num(txt(xml, 'length')),
              required: bool(xml, 'required'),
              formula: txt(xml, 'formula'),
              referenceTo: txt(xml, 'referenceTo'),
              picklistValues: values.length ? values : undefined,
              description: txt(xml, 'description'),
            }),
          },
        });
      } else if ((m = base.match(/^(.+)\.validationRule-meta\.xml$/))) {
        const xml = readXml(file);
        if (!xml) continue;
        const active = bool(xml, 'active') ?? true;
        add({
          file,
          xml,
          object: grand,
          component: {
            id: `ValidationRule:${grand}.${m[1]}`,
            type: 'ValidationRule',
            attributes: clean({ active, errorConditionFormula: txt(xml, 'errorConditionFormula'), errorMessage: txt(xml, 'errorMessage') }),
            ...(active ? { tags: ['production-automation'] } : {}),
          },
        });
      } else if ((m = base.match(/^(.+)\.flow-meta\.xml$/))) {
        const xml = readXml(file);
        if (!xml) continue;
        const start = kid(xml, 'start');
        const status = txt(xml, 'status');
        add({
          file,
          xml,
          object: txt(start, 'object'),
          component: {
            id: `Flow:${m[1]}`,
            type: 'Flow',
            attributes: clean({
              label: txt(xml, 'label'),
              processType: txt(xml, 'processType'),
              status,
              object: txt(start, 'object'),
              trigger: [txt(start, 'recordTriggerType'), txt(start, 'triggerType')].filter(Boolean).join(' ') || undefined,
            }),
            ...(status === 'Active' ? { tags: ['production-automation'] } : {}),
          },
        });
      } else if ((m = base.match(/^(.+)\.cls$/))) {
        add({ file, source: readFileSync(file, 'utf8'), component: { id: `ApexClass:${m[1]}`, type: 'ApexClass', attributes: {} } });
      } else if ((m = base.match(/^(.+)\.trigger$/))) {
        const source = readFileSync(file, 'utf8');
        const t = /trigger\s+\w+\s+on\s+(\w+)\s*\(([^)]*)\)/i.exec(source);
        add({
          file,
          source,
          object: t?.[1],
          component: {
            id: `ApexTrigger:${m[1]}`,
            type: 'ApexTrigger',
            attributes: clean({ object: t?.[1], events: t?.[2].split(',').map((s) => s.trim()).filter(Boolean) }),
            tags: ['production-automation'],
          },
        });
      } else if ((m = base.match(/^(.+)\.(profile|permissionset)-meta\.xml$/))) {
        const xml = readXml(file);
        if (!xml) continue;
        const type = m[2] === 'profile' ? 'Profile' : 'PermissionSet';
        const license = txt(xml, 'userLicense') ?? txt(xml, 'license');
        const label = txt(xml, 'label');
        const tags: string[] = [];
        if (license && /community|guest|partner|portal|site/i.test(license)) tags.push('external');
        if (/integration/i.test(`${m[1]} ${label ?? ''}`)) tags.push('integration');
        add({
          file,
          xml,
          component: { id: `${type}:${m[1]}`, type, attributes: clean({ userLicense: license, label }), nodes: permissionNodes(xml), ...(tags.length ? { tags } : {}) },
        });
      } else if ((m = base.match(/^(.+)\.report-meta\.xml$/))) {
        const xml = readXml(file);
        if (xml) add({ file, xml, component: { id: `Report:${parent}/${m[1]}`, type: 'Report', attributes: clean({ name: txt(xml, 'name'), format: txt(xml, 'format'), reportType: txt(xml, 'reportType') }) } });
      } else if ((m = base.match(/^(.+)\.dashboard-meta\.xml$/))) {
        const xml = readXml(file);
        if (xml) add({ file, xml, component: { id: `Dashboard:${parent}/${m[1]}`, type: 'Dashboard', attributes: clean({ title: txt(xml, 'title'), runningUser: txt(xml, 'runningUser') }) } });
      } else if (/-meta\.xml$/.test(base) && !/\.(cls|trigger)-meta\.xml$/.test(base) && !/Folder-meta|\.reportFolder|\.dashboardFolder/.test(base)) {
        skipped.push({ file: path.relative(root, file), reason: 'metadata type not modeled yet' });
      }
    }
  }

  // ---------- Second pass: dependencies ----------
  const components = new Map<ComponentId, Component>();
  for (const p of pending) {
    if (components.has(p.component.id)) warnings.push(`duplicate ${p.component.id} (${p.file})`);
    components.set(p.component.id, p.component);
  }
  const fieldsByName = new Map<string, ComponentId[]>();
  for (const id of components.keys()) {
    if (!id.startsWith('CustomField:')) continue;
    const api = id.split('.').pop()!;
    fieldsByName.set(api, [...(fieldsByName.get(api) ?? []), id]);
  }
  const classNames = [...components.keys()].filter((id) => id.startsWith('ApexClass:')).map((id) => id.slice('ApexClass:'.length));

  const deps: Dependency[] = [];
  const seen = new Set<string>();
  const dep = (from: ComponentId, to: ComponentId, kind: DependencyKind, source: Provenance, note?: string) => {
    if (from === to) return;
    if (!components.has(to)) {
      // Standard objects usually have no .object-meta.xml in the repo: add a placeholder.
      if (to.startsWith('CustomObject:')) components.set(to, { id: to, type: 'CustomObject', attributes: { implicit: true } });
      else return;
    }
    const key = `${from}|${to}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    deps.push({ from, to, kind, source, ...(note ? { note } : {}) });
  };
  // A field named with its object (flow $Record, report columns, formulas) that is not in
  // this project gets a placeholder, so the reference is kept: the simulation then reports
  // it as missing unless a story in the batch creates it.
  const fieldOn = (object: string | undefined, api: string): ComponentId | undefined => {
    if (!object || !isCustom(api)) return undefined;
    const id = `CustomField:${object}.${api}`;
    if (!components.has(id)) {
      components.set(id, { id, type: 'CustomField', attributes: { implicit: true } });
      dep(id, `CustomObject:${object}`, 'references', 'metadata');
    }
    return id;
  };

  for (const p of pending) {
    const c = p.component;
    switch (c.type) {
      case 'CustomField': {
        dep(c.id, `CustomObject:${p.object}`, 'references', 'metadata');
        const ref = c.attributes.referenceTo as string | undefined;
        if (ref) dep(c.id, `CustomObject:${ref}`, 'references', 'metadata');
        for (const tok of tokens(String(c.attributes.formula ?? ''))) {
          const f = fieldOn(p.object, tok);
          if (f) dep(c.id, f, 'reads', 'metadata');
        }
        break;
      }
      case 'ValidationRule': {
        dep(c.id, `CustomObject:${p.object}`, 'references', 'metadata');
        for (const tok of tokens(String(c.attributes.errorConditionFormula ?? ''))) {
          const f = fieldOn(p.object, tok);
          if (f) dep(c.id, f, 'reads', 'metadata');
        }
        break;
      }
      case 'Flow':
        flowDeps(p, dep, fieldOn);
        break;
      case 'ApexClass':
      case 'ApexTrigger': {
        const { code, strings } = splitApex(p.source ?? '');
        if (c.type === 'ApexTrigger' && p.object) dep(c.id, `CustomObject:${p.object}`, 'references', 'source-code');
        for (const name of classNames) {
          if (`ApexClass:${name}` !== c.id && new RegExp(`\\b${name}\\b`).test(code)) dep(c.id, `ApexClass:${name}`, 'references', 'source-code');
        }
        for (const tok of new Set(tokens(code))) {
          const ids = fieldsByName.get(tok) ?? [];
          const writes = new RegExp(`\\.\\s*${tok}\\s*=(?!=)`).test(code);
          if (ids.length === 1) dep(c.id, ids[0], writes ? 'writes' : 'reads', 'source-code');
          else for (const id of ids) dep(c.id, id, writes ? 'writes' : 'reads', 'inference', `field name ${tok} exists on several objects`);
        }
        for (const s of strings) {
          for (const tok of new Set(tokens(s))) {
            for (const id of fieldsByName.get(tok) ?? []) dep(c.id, id, 'reads', 'inference', 'field name inside a string literal (dynamic SOQL?)');
          }
        }
        break;
      }
      case 'Report': {
        const groupFields = new Set([...findAll(p.xml!, 'groupingsDown'), ...findAll(p.xml!, 'groupingsAcross')].map((g) => txt(g, 'field')));
        for (const node of [...findAll(p.xml!, 'field'), ...findAll(p.xml!, 'column')]) {
          const v = node.text.trim();
          const mm = /^(\w+)[.$](\w+__c)$/.exec(v);
          if (!mm) continue;
          const f = fieldOn(mm[1], mm[2]);
          if (f) dep(c.id, f, groupFields.has(v) ? 'groups-by' : 'reads', 'metadata');
        }
        break;
      }
      case 'Dashboard':
        for (const r of findAll(p.xml!, 'report')) dep(c.id, `Report:${r.text.trim()}`, 'references', 'metadata');
        break;
    }
  }

  // Apex classes called by active automation run in production too.
  for (const d of deps) {
    const from = components.get(d.from);
    const to = components.get(d.to);
    if (to?.type === 'ApexClass' && from?.tags?.includes('production-automation')) to.tags = [...new Set([...(to.tags ?? []), 'production-automation'])];
  }

  // ---------- Overlay ----------
  let overlay = opts.overlay;
  if (!overlay && opts.autoOverlay !== false && existsSync(path.join(root, OVERLAY_FILE))) {
    overlay = JSON.parse(readFileSync(path.join(root, OVERLAY_FILE), 'utf8')) as Overlay;
  }
  if (overlay) applyOverlay(overlay, components, deps, warnings, seen);

  const snapshot: MetadataSnapshot = {
    name: opts.name ?? path.basename(path.resolve(root)),
    capturedAt: new Date().toISOString(),
    origin: opts.origin ?? `Imported from ${root}`,
    components: [...components.values()].sort((a, b) => a.id.localeCompare(b.id)),
    dependencies: deps.sort((a, b) => `${a.from}${a.to}${a.kind}`.localeCompare(`${b.from}${b.to}${b.kind}`)),
  };
  validateSnapshot(snapshot);
  return { snapshot, skipped, warnings };
}

function permissionNodes(xml: XmlNode): Record<string, Record<string, unknown>> {
  const nodes: Record<string, Record<string, unknown>> = {};
  for (const f of kids(xml, 'fieldPermissions')) {
    const field = txt(f, 'field');
    if (field) nodes[`fieldPermissions:${field}`] = { readable: bool(f, 'readable') ?? false, editable: bool(f, 'editable') ?? false };
  }
  for (const o of kids(xml, 'objectPermissions')) {
    const object = txt(o, 'object');
    if (!object) continue;
    nodes[`objectPermissions:${object}`] = clean({
      allowRead: bool(o, 'allowRead'),
      allowCreate: bool(o, 'allowCreate'),
      allowEdit: bool(o, 'allowEdit'),
      allowDelete: bool(o, 'allowDelete'),
      viewAllRecords: bool(o, 'viewAllRecords'),
      modifyAllRecords: bool(o, 'modifyAllRecords'),
    });
  }
  for (const a of kids(xml, 'classAccesses')) {
    const cls = txt(a, 'apexClass');
    if (cls) nodes[`classAccesses:${cls}`] = { enabled: bool(a, 'enabled') ?? false };
  }
  return nodes;
}

type DepFn = (from: ComponentId, to: ComponentId, kind: DependencyKind, source: Provenance, note?: string) => void;

function flowDeps(p: Pending, dep: DepFn, fieldOn: (o: string | undefined, f: string) => ComponentId | undefined) {
  const xml = p.xml!;
  const id = p.component.id;
  const recordObject = p.object;
  if (recordObject) dep(id, `CustomObject:${recordObject}`, 'references', 'metadata');

  // $Record.Field__c — writes when it is the target of an assignment, reads otherwise.
  const scan = (node: XmlNode) => {
    const t = node.text.trim();
    for (const m of t.matchAll(/\$Record\.(\w+__c)/g)) {
      const f = fieldOn(recordObject, m[1]);
      if (f) dep(id, f, node.name === 'assignToReference' ? 'writes' : 'reads', 'metadata');
    }
    node.children.forEach(scan);
  };
  scan(xml);

  // Record create/update/lookup elements on other objects.
  for (const kind of ['recordUpdates', 'recordCreates', 'recordLookups'] as const) {
    for (const el of findAll(xml, kind)) {
      const obj = txt(el, 'object') ?? (txt(el, 'inputReference') === '$Record' ? recordObject : undefined);
      if (!obj) continue;
      dep(id, `CustomObject:${obj}`, kind === 'recordLookups' ? 'reads' : 'writes', 'metadata');
      for (const ia of kids(el, 'inputAssignments')) {
        const f = fieldOn(obj, txt(ia, 'field') ?? '');
        if (f) dep(id, f, 'writes', 'metadata');
      }
      for (const fl of kids(el, 'filters')) {
        const f = fieldOn(obj, txt(fl, 'field') ?? '');
        if (f) dep(id, f, 'reads', 'metadata');
      }
      for (const q of kids(el, 'queriedFields')) {
        const f = fieldOn(obj, q.text.trim());
        if (f) dep(id, f, 'reads', 'metadata');
      }
    }
  }
  for (const a of findAll(xml, 'actionCalls')) {
    if (txt(a, 'actionType') === 'apex' && txt(a, 'actionName')) dep(id, `ApexClass:${txt(a, 'actionName')}`, 'references', 'metadata');
  }
  for (const s of findAll(xml, 'subflows')) {
    const name = txt(s, 'flowName');
    if (name) dep(id, `Flow:${name}`, 'references', 'metadata');
  }
}

function applyOverlay(o: Overlay, components: Map<ComponentId, Component>, deps: Dependency[], warnings: string[], seen: Set<string>) {
  for (const c of o.components ?? []) {
    if (components.has(c.id)) warnings.push(`overlay replaces ${c.id}`);
    components.set(c.id, structuredClone(c));
  }
  for (const [id, tags] of Object.entries(o.tags ?? {})) {
    const c = components.get(id);
    if (!c) warnings.push(`overlay tags unknown component ${id}`);
    else c.tags = [...new Set([...(c.tags ?? []), ...tags])];
  }
  for (const [id, attrs] of Object.entries(o.attributes ?? {})) {
    const c = components.get(id);
    if (!c) warnings.push(`overlay attributes for unknown component ${id}`);
    else c.attributes = { ...c.attributes, ...attrs };
  }
  for (const d of o.dependencies ?? []) {
    // A configured reference to a field that is not in this project keeps a placeholder.
    const m = /^CustomField:(\w+)\.\w+__c$/.exec(d.to);
    if (m && !components.has(d.to)) {
      components.set(d.to, { id: d.to, type: 'CustomField', attributes: { implicit: true } });
      if (!components.has(`CustomObject:${m[1]}`)) components.set(`CustomObject:${m[1]}`, { id: `CustomObject:${m[1]}`, type: 'CustomObject', attributes: { implicit: true } });
      deps.push({ from: d.to, to: `CustomObject:${m[1]}`, kind: 'references', source: 'metadata' });
    }
    if (!components.has(d.from) || !components.has(d.to)) {
      warnings.push(`overlay dependency ${d.from} → ${d.to} skipped (unknown component)`);
      continue;
    }
    const key = `${d.from}|${d.to}|${d.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deps.push({ ...d, source: d.source ?? 'configuration' });
  }
}

function tokens(s: string): string[] {
  return [...s.matchAll(/\b(\w+__c)\b/g)].map((m) => m[1]);
}

function num(v: string | undefined): number | undefined {
  return v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v);
}

function clean<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
