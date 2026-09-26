/**
 * A small DOM for driving popup.js in Node. It parses the real popup.html,
 * so ids, roles and nesting are the shipped ones, and it runs the parts of
 * the DOM the popup relies on: selectors, events with capture and bubbling,
 * focus, forms, check boxes, radios and selects. Layout is not modelled.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function kebab(prop) {
  return prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

// Selectors: comma lists of compounds (tag, #id, .class, [attr], [attr="v"])
// joined by descendant or child combinators.
function parseSelector(sel) {
  return sel.split(',').map((part) => {
    const tokens = part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    const steps = [];
    let combinator = ' ';
    for (const token of tokens) {
      if (token === '>') { combinator = '>'; continue; }
      steps.push({ combinator, compound: parseCompound(token) });
      combinator = ' ';
    }
    return steps;
  });
}

function parseCompound(text) {
  const out = { tag: '', id: '', classes: [], attrs: [], not: [] };
  text = text.replace(/:not\(([^()]*)\)/g, (_, inner) => {
    out.not.push(parseCompound(inner));
    return '';
  });
  const re = /([a-zA-Z][a-zA-Z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([^\]=\s]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else out.attrs.push({ name: m[4], value: m[5] ?? m[6] ?? m[7] ?? null });
  }
  return out;
}

function matchCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v == null) return false;
    if (a.value != null && v !== a.value) return false;
  }
  for (const n of c.not) if (matchCompound(el, n)) return false;
  return true;
}

function matchSteps(el, steps, i = steps.length - 1) {
  if (!matchCompound(el, steps[i].compound)) return false;
  if (i === 0) return true;
  if (steps[i].combinator === '>') {
    const parent = el.parentElement;
    return !!parent && matchSteps(parent, steps, i - 1);
  }
  for (let up = el.parentElement; up; up = up.parentElement) {
    if (matchSteps(up, steps, i - 1)) return true;
  }
  return false;
}

function matchesSelector(el, sel) {
  return parseSelector(sel).some((steps) => steps.length && matchSteps(el, steps));
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = init.cancelable !== false;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.propagationStopped = false;
    Object.assign(this, init);
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }

  stopImmediatePropagation() {
    this.propagationStopped = true;
    this.immediateStopped = true;
  }
}

class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.listeners = {};
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  addEventListener(type, fn, opts) {
    if (typeof fn !== 'function' && !(fn && typeof fn.handleEvent === 'function')) return;
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    (this.listeners[type] ||= []).push({ fn, capture, once: !!opts?.once });
  }

  removeEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const list = this.listeners[type];
    if (!list) return;
    const i = list.findIndex((row) => row.fn === fn && row.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }

  runListeners(event, phase) {
    const list = [...(this.listeners[event.type] || [])];
    event.currentTarget = this;
    for (const row of list) {
      if (phase === 'capture' && !row.capture) continue;
      if (phase === 'bubble' && row.capture) continue;
      if (row.once) this.removeEventListener(event.type, row.fn, row.capture);
      if (typeof row.fn === 'function') row.fn.call(this, event);
      else row.fn.handleEvent(event);
      if (event.immediateStopped) break;
    }
  }

  dispatchEvent(event) {
    event.target = this;
    const path = [];
    for (let node = this.parentNode; node; node = node.parentNode) path.push(node);
    if (this.ownerDocument && path[path.length - 1] === this.ownerDocument && this.ownerDocument.defaultView) {
      path.push(this.ownerDocument.defaultView);
    }
    for (let i = path.length - 1; i >= 0 && !event.propagationStopped; i--) path[i].runListeners(event, 'capture');
    if (!event.propagationStopped) this.runListeners(event, 'target');
    if (event.bubbles) {
      for (const node of path) {
        if (event.propagationStopped) break;
        node.runListeners(event, 'bubble');
      }
    }
    return !event.defaultPrevented;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

class FakeText extends FakeNode {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value ?? '');
  }
}

const REFLECT_STRING = { id: 'id', className: 'class', title: 'title', name: 'name', src: 'src', href: 'href', placeholder: 'placeholder', lang: 'lang', dir: 'dir', htmlFor: 'for', role: 'role' };
const REFLECT_BOOL = ['hidden', 'disabled', 'required', 'readOnly', 'multiple', 'open'];

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.attributes = new Map();
    this._value = null;
    this._checked = null;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this.files = null;
    this.style = {
      _props: {},
      setProperty(name, value) { this._props[name] = String(value); },
      removeProperty(name) { delete this._props[name]; },
      getPropertyValue(name) { return this._props[name] || ''; },
    };
    const el = this;
    this.dataset = new Proxy({}, {
      get(_obj, prop) {
        if (typeof prop !== 'string') return undefined;
        const v = el.getAttribute('data-' + kebab(prop));
        return v == null ? undefined : v;
      },
      set(_obj, prop, value) {
        el.setAttribute('data-' + kebab(prop), String(value));
        return true;
      },
      deleteProperty(_obj, prop) {
        el.removeAttribute('data-' + kebab(prop));
        return true;
      },
      has(_obj, prop) {
        return typeof prop === 'string' && el.hasAttribute('data-' + kebab(prop));
      },
      ownKeys() {
        return [...el.attributes.keys()].filter((k) => k.startsWith('data-')).map((k) => camel(k.slice(5)));
      },
      getOwnPropertyDescriptor(_obj, prop) {
        const v = el.getAttribute('data-' + kebab(prop));
        return v == null ? undefined : { value: v, enumerable: true, configurable: true, writable: true };
      },
    });
    this.classList = {
      _list: () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean),
      add(...names) {
        const set = new Set(this._list());
        for (const n of names) set.add(n);
        el.setAttribute('class', [...set].join(' '));
      },
      remove(...names) {
        const drop = new Set(names);
        el.setAttribute('class', this._list().filter((n) => !drop.has(n)).join(' '));
      },
      toggle(name, force) {
        const on = force == null ? !this.contains(name) : !!force;
        if (on) this.add(name);
        else this.remove(name);
        return on;
      },
      contains(name) { return this._list().includes(name); },
    };
  }

  get localName() {
    return this.tagName.toLowerCase();
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get childElementCount() {
    return this.children.length;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get lastElementChild() {
    const kids = this.children;
    return kids[kids.length - 1] || null;
  }

  sibling(delta) {
    if (!this.parentNode) return null;
    const kids = this.parentNode.children;
    return kids[kids.indexOf(this) + delta] || null;
  }

  get nextElementSibling() { return this.sibling(1); }

  get previousElementSibling() { return this.sibling(-1); }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(value) {
    this.replaceChildren();
    const text = value == null ? '' : String(value);
    if (text) this.appendChild(new FakeText(this.ownerDocument, text));
  }

  get innerText() {
    return this.textContent;
  }

  set innerText(value) {
    this.textContent = value;
  }

  get tabIndex() {
    const v = this.getAttribute('tabindex');
    if (v != null) return Number(v);
    return ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(this.tagName) ? 0 : -1;
  }

  set tabIndex(value) {
    this.setAttribute('tabindex', String(value));
  }

  get value() {
    if (this.tagName === 'SELECT') {
      const opts = this.options;
      const chosen = opts.find((o) => o.selected) || opts[0];
      return chosen ? chosen.value : '';
    }
    if (this.tagName === 'OPTION') return this.getAttribute('value') ?? this.textContent.trim();
    if (this._value != null) return this._value;
    return this.getAttribute('value') ?? (this.getAttribute('type') === 'checkbox' || this.getAttribute('type') === 'radio' ? 'on' : '');
  }

  set value(v) {
    if (this.tagName === 'SELECT') {
      for (const o of this.options) o.selected = o.value === String(v);
      return;
    }
    this._value = String(v ?? '');
  }

  get options() {
    return this.tagName === 'SELECT' ? this.querySelectorAll('option') : [];
  }

  get selectedIndex() {
    return this.options.findIndex((o) => o.value === this.value);
  }

  get selected() {
    if (this._selected != null) return this._selected;
    return this.hasAttribute('selected');
  }

  set selected(v) {
    this._selected = !!v;
  }

  get checked() {
    return this._checked != null ? this._checked : this.hasAttribute('checked');
  }

  set checked(v) {
    this._checked = !!v;
    if (this._checked && this.getAttribute('type') === 'radio' && this.name) {
      const root = this.form || this.ownerDocument;
      for (const other of root.querySelectorAll(`input[name="${this.name}"]`)) {
        if (other !== this) other._checked = false;
      }
    }
  }

  get type() {
    const t = this.getAttribute('type');
    if (t) return t.toLowerCase();
    if (this.tagName === 'BUTTON') return 'submit';
    if (this.tagName === 'INPUT') return 'text';
    return '';
  }

  set type(v) {
    this.setAttribute('type', v);
  }

  get form() {
    return this.closest('form');
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  toggleAttribute(name, force) {
    const on = force == null ? !this.hasAttribute(name) : !!force;
    if (on) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return on;
  }

  adopt(node) {
    if (typeof node === 'string') node = new FakeText(this.ownerDocument, node);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    return node;
  }

  appendChild(node) {
    if (!node) return node;
    node = this.adopt(node);
    this.childNodes.push(node);
    return node;
  }

  append(...nodes) {
    for (const n of nodes) if (n != null) this.appendChild(n);
  }

  prepend(...nodes) {
    const first = this.childNodes[0] || null;
    for (const n of nodes) if (n != null) this.insertBefore(n, first);
  }

  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    node = this.adopt(node);
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
    return node;
  }

  before(...nodes) {
    if (!this.parentNode) return;
    for (const n of nodes) this.parentNode.insertBefore(n, this);
  }

  after(...nodes) {
    if (!this.parentNode) return;
    const next = this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null;
    for (const n of nodes) this.parentNode.insertBefore(n, next);
  }

  replaceWith(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    this.before(...nodes);
    parent.removeChild(this);
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    this.ownerDocument?.forgetFocus(node);
    return node;
  }

  replaceChildren(...nodes) {
    for (const n of [...this.childNodes]) this.removeChild(n);
    this.append(...nodes);
  }

  querySelectorAll(sel) {
    const groups = parseSelector(sel);
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (groups.some((steps) => steps.length && matchSteps(child, steps))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  getElementsByTagName(tag) {
    return this.querySelectorAll(tag);
  }

  matches(sel) {
    return matchesSelector(this, sel);
  }

  closest(sel) {
    for (let el = this; el && el.nodeType === 1; el = el.parentNode) {
      if (matchesSelector(el, sel)) return el;
    }
    return null;
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  focus() {
    this.ownerDocument?.moveFocus(this);
  }

  blur() {
    if (this.ownerDocument?.activeElement === this) this.ownerDocument.moveFocus(this.ownerDocument.body);
  }

  select() {}

  setSelectionRange() {}

  scrollIntoView() {}

  scrollTo() {}

  showModal() { this.setAttribute('open', ''); }

  close() { this.removeAttribute('open'); }

  getContext() { return null; }

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }

  get offsetWidth() { return 0; }

  get offsetHeight() { return 0; }

  get clientHeight() { return 0; }

  get scrollHeight() { return 0; }

  /** A user click: runs the click listeners, then what the browser does by default. */
  click() {
    if (this.disabled) return;
    const input = this.tagName === 'INPUT' && (this.type === 'checkbox' || this.type === 'radio');
    const before = input ? this.checked : null;
    if (input) this.checked = this.type === 'radio' ? true : !before;
    const ok = this.dispatchEvent(new FakeEvent('click', { bubbles: true, button: 0 }));
    if (input) {
      if (!ok) { this.checked = before; return; }
      if (before !== this.checked) {
        this.dispatchEvent(new FakeEvent('input', { bubbles: true }));
        this.dispatchEvent(new FakeEvent('change', { bubbles: true }));
      }
      return;
    }
    if (!ok) return;
    if (this.tagName === 'BUTTON' && this.type === 'submit' && this.form) this.form.requestSubmit();
    if (this.tagName === 'LABEL') {
      const target = this.getAttribute('for')
        ? this.ownerDocument.getElementById(this.getAttribute('for'))
        : this.querySelector('input');
      if (target && target !== this) target.click();
    }
  }

  requestSubmit() {
    this.dispatchEvent(new FakeEvent('submit', { bubbles: true }));
  }
}

for (const [prop, attr] of Object.entries(REFLECT_STRING)) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() { return this.getAttribute(attr) ?? ''; },
    set(v) { this.setAttribute(attr, v == null ? '' : String(v)); },
    configurable: true,
  });
}
for (const prop of REFLECT_BOOL) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() { return this.hasAttribute(prop.toLowerCase()); },
    set(v) { this.toggleAttribute(prop.toLowerCase(), !!v); },
    configurable: true,
  });
}

class FakeWindow extends FakeNode {
  constructor() {
    super(null);
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.nodeType = 9;
    this.ownerDocument = null;
    this.childNodes = [];
    this.documentElement = null;
    this.activeElement = null;
    this.defaultView = new FakeWindow();
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get body() {
    return this.documentElement?.querySelector('body') || null;
  }

  get head() {
    return this.documentElement?.querySelector('head') || null;
  }

  createElement(tag) {
    return new FakeElement(this, tag);
  }

  createElementNS(_ns, tag) {
    return new FakeElement(this, tag);
  }

  createTextNode(text) {
    return new FakeText(this, text);
  }

  createDocumentFragment() {
    return new FakeElement(this, '#fragment');
  }

  getElementById(id) {
    return this.documentElement?.querySelector(`#${id}`) || null;
  }

  querySelectorAll(sel) {
    if (!this.documentElement) return [];
    const self = this.documentElement.matches(sel) ? [this.documentElement] : [];
    return [...self, ...this.documentElement.querySelectorAll(sel)];
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  moveFocus(el) {
    const prev = this.activeElement;
    if (prev === el) return;
    this.activeElement = el;
    if (prev && prev !== this.body) {
      prev.dispatchEvent(new FakeEvent('blur', { bubbles: false, relatedTarget: el }));
      prev.dispatchEvent(new FakeEvent('focusout', { bubbles: true, relatedTarget: el }));
    }
    if (el && el !== this.body) {
      el.dispatchEvent(new FakeEvent('focus', { bubbles: false, relatedTarget: prev }));
      el.dispatchEvent(new FakeEvent('focusin', { bubbles: true, relatedTarget: prev }));
    }
  }

  // A removed element cannot keep focus; the browser drops it to the body.
  forgetFocus(node) {
    const active = this.activeElement;
    if (active && active !== this.body && node.nodeType === 1 && (node === active || node.contains(active))) {
      this.activeElement = this.body;
    }
  }
}

/** Build a document from HTML text. Scripts and styles are kept as empty nodes. */
export function parseHtml(html) {
  const doc = new FakeDocument();
  const root = new FakeElement(doc, '#root');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const tag = m[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
    } else if (m[2]) {
      const el = new FakeElement(doc, m[2]);
      const attrRe = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let a;
      while ((a = attrRe.exec(m[3] || ''))) {
        el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
      }
      top.appendChild(el);
      if (!m[4] && !VOID.has(m[2].toLowerCase())) stack.push(el);
    } else if (m[5]) {
      top.appendChild(new FakeText(doc, decode(m[5])));
    }
  }
  const html0 = root.children.find((el) => el.tagName === 'HTML') || root;
  html0.parentNode = doc;
  doc.childNodes = [html0];
  doc.documentElement = html0;
  doc.activeElement = doc.body;
  return doc;
}

export function keyEvent(key, init = {}) {
  return new FakeEvent('keydown', { bubbles: true, key, ...init });
}

export { FakeEvent, FakeElement, FakeDocument };
