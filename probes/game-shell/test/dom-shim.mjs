// Minimal DOM shim for the shell render tests.
//
// It supports exactly the surface shell.js uses: element creation, text nodes,
// attributes/dataset/classList, hidden/disabled/value, listeners, focus and a
// small querySelector subset. It is deliberately not a browser.

class TextNode {
  constructor(text, ownerDocument) {
    this.nodeType = 3;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this._text = String(text);
  }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); }
  get childNodes() { return []; }
}

function camelData(name) {
  return name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

class Element {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = Object.create(null);
    this.dataset = Object.create(null);
    this.style = Object.create(null);
    this._text = null;
    this._className = '';
    this._id = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.selected = false;
    this.value = '';
    this._listeners = new Map();
    this.classList = {
      add: (...names) => {
        const set = new Set(this._className.split(/\s+/).filter(Boolean));
        for (const name of names) set.add(name);
        this.className = [...set].join(' ');
      },
      remove: (...names) => {
        const set = new Set(this._className.split(/\s+/).filter(Boolean));
        for (const name of names) set.delete(name);
        this.className = [...set].join(' ');
      },
      contains: (name) => this._className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const has = this.classList.contains(name);
        const next = force === undefined ? !has : Boolean(force);
        if (next) this.classList.add(name); else this.classList.remove(name);
        return next;
      }
    };
  }

  get className() { return this._className; }
  set className(value) {
    this._className = String(value ?? '');
    this.attributes.class = this._className;
  }

  get id() { return this._id; }
  set id(value) {
    this._id = String(value ?? '');
    this.attributes.id = this._id;
  }

  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] ?? null; }

  get textContent() {
    if (this._text !== null) return this._text;
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    this._text = String(value ?? '');
  }

  appendChild(node) {
    if (node === null || node === undefined) throw new TypeError('parameter 1 is not of type Node');
    if (this._text !== null) {
      const text = new TextNode(this._text, this.ownerDocument);
      text.parentNode = this;
      this.childNodes.push(text);
      this._text = null;
    }
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') this.appendChild(new TextNode(node, this.ownerDocument));
      else this.appendChild(node);
    }
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this._text = null;
    this.append(...nodes);
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    const key = String(name);
    if (key === 'class') this.className = value;
    else if (key === 'id') this.id = value;
    else if (key === 'hidden') this.hidden = true;
    else if (key === 'disabled') this.disabled = true;
    else if (key.startsWith('data-')) this.dataset[camelData(key)] = String(value);
    else this.attributes[key] = String(value);
  }

  getAttribute(name) {
    const key = String(name);
    if (key === 'class') return this._className || null;
    if (key === 'id') return this._id || null;
    if (key === 'hidden') return this.hidden ? '' : null;
    if (key === 'disabled') return this.disabled ? '' : null;
    if (key.startsWith('data-')) {
      const value = this.dataset[camelData(key)];
      return value === undefined ? null : String(value);
    }
    return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }

  removeAttribute(name) {
    const key = String(name);
    if (key === 'hidden') this.hidden = false;
    else if (key === 'disabled') this.disabled = false;
    else if (key.startsWith('data-')) delete this.dataset[camelData(key)];
    else delete this.attributes[key];
  }

  addEventListener(name, handler) {
    if (!this._listeners.has(name)) this._listeners.set(name, new Set());
    this._listeners.get(name).add(handler);
  }

  removeEventListener(name, handler) {
    this._listeners.get(name)?.delete(handler);
  }

  dispatchEvent(event) {
    const payload = event ?? {};
    payload.target = payload.target ?? this;
    payload.currentTarget = this;
    payload.preventDefault = payload.preventDefault ?? function preventDefault() { this.defaultPrevented = true; };
    payload.defaultPrevented = payload.defaultPrevented ?? false;
    for (const handler of [...(this._listeners.get(payload.type) ?? [])]) handler(payload);
    return !payload.defaultPrevented;
  }

  click() {
    return this.dispatchEvent({ type: 'click' });
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }

  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  matches(selector) {
    return matchesCompound(this, selector.trim());
  }

  querySelectorAll(selector) {
    const result = [];
    const selectors = String(selector).split(',').map((entry) => entry.trim()).filter(Boolean);
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (selectors.some((entry) => matchesSelector(child, entry))) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function splitDescendant(selector) {
  // The shell's selectors have no quoted spaces; split is sufficient here.
  return selector.trim().split(/\s+/).filter(Boolean);
}

function matchesSelector(element, selector) {
  const parts = splitDescendant(selector);
  if (!parts.length) return false;
  if (!matchesCompound(element, parts[parts.length - 1])) return false;
  let ancestor = element.parentNode;
  for (let index = parts.length - 2; index >= 0; index--) {
    let found = false;
    while (ancestor) {
      if (ancestor.nodeType === 1 && matchesCompound(ancestor, parts[index])) {
        found = true;
        ancestor = ancestor.parentNode;
        break;
      }
      ancestor = ancestor.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

function matchesCompound(element, compound) {
  let text = compound.trim();
  if (!text) return false;
  const nots = [];
  text = text.replace(/:not\(([^)]*)\)/g, (_, inner) => {
    nots.push(inner.trim());
    return '';
  });
  if (nots.some((inner) => matchesCompound(element, inner))) return false;

  const attrMatches = [...text.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
  for (const [, name, value] of attrMatches) {
    const actual = element.getAttribute(name);
    if (actual === null) return false;
    if (value !== undefined && actual !== value) return false;
  }
  text = text.replace(/\[[^\]]+\]/g, '');

  const idMatch = /#([A-Za-z0-9_-]+)/.exec(text);
  if (idMatch && element.id !== idMatch[1]) return false;
  text = text.replace(/#[A-Za-z0-9_-]+/g, '');

  const classes = [...text.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((entry) => entry[1]);
  if (classes.some((name) => !element.classList.contains(name))) return false;
  text = text.replace(/\.[A-Za-z0-9_-]+/g, '');

  const tag = text.trim();
  if (tag && !tag.startsWith(':') && element.tagName !== tag.toUpperCase()) return false;
  return true;
}

export function createDocument() {
  const document = {
    title: '',
    activeElement: null,
    createElement: (tag) => new Element(tag, document),
    createTextNode: (text) => new TextNode(text, document),
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  document.documentElement = new Element('html', document);
  document.defaultView = {
    location: { pathname: '/probes/game-shell/demo.html', search: '' },
    history: { replaceState: () => {} },
    navigator: {},
    requestAnimationFrame: null,
    cancelAnimationFrame: null
  };
  return document;
}

export function createHost() {
  const document = createDocument();
  const host = document.createElement('div');
  host.id = 'shell';
  document.documentElement.appendChild(host);
  return { document, host };
}

export { Element, TextNode };
