// Minimal DOM shim for the ui-screens renderer tests.
//
// It supports exactly the surface screens.js uses: element creation, text nodes,
// attributes/dataset/classList, hidden/disabled/checked/value/selected,
// listeners, focus, a small querySelector subset and a document keydown target.
// It is deliberately not a browser and makes no rendering claim.

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
    this.selectionStart = 0;
    this.selectionEnd = 0;
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
    else if (key === 'checked') this.checked = true;
    else if (key === 'selected') this.selected = true;
    else if (key === 'value') this.value = String(value);
    else if (key.startsWith('data-')) this.dataset[camelData(key)] = String(value);
    else this.attributes[key] = String(value);
  }

  getAttribute(name) {
    const key = String(name);
    if (key === 'class') return this._className || null;
    if (key === 'id') return this._id || null;
    if (key === 'hidden') return this.hidden ? '' : null;
    if (key === 'disabled') return this.disabled ? '' : null;
    if (key === 'checked') return this.checked ? '' : null;
    if (key === 'selected') return this.selected ? '' : null;
    if (key === 'value') return this.value === '' ? (Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null) : String(this.value);
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
    else if (key === 'checked') this.checked = false;
    else if (key === 'selected') this.selected = false;
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
    payload.stopPropagation = payload.stopPropagation ?? function stopPropagation() { this.propagationStopped = true; };
    payload.defaultPrevented = payload.defaultPrevented ?? false;
    payload.propagationStopped = payload.propagationStopped ?? false;
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

  select() {
    this.selected = true;
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
    _listeners: new Map(),
    addEventListener(name, handler) {
      if (!document._listeners.has(name)) document._listeners.set(name, new Set());
      document._listeners.get(name).add(handler);
    },
    removeEventListener(name, handler) {
      document._listeners.get(name)?.delete(handler);
    },
    dispatchEvent(event) {
      const payload = event ?? {};
      payload.target = payload.target ?? document;
      payload.currentTarget = document;
      payload.preventDefault = payload.preventDefault ?? function preventDefault() { this.defaultPrevented = true; };
      payload.stopPropagation = payload.stopPropagation ?? function stopPropagation() { this.propagationStopped = true; };
      payload.defaultPrevented = payload.defaultPrevented ?? false;
      for (const handler of [...(document._listeners.get(payload.type) ?? [])]) handler(payload);
      return !payload.defaultPrevented;
    }
  };
  document.documentElement = new Element('html', document);
  document.body = new Element('body', document);
  document.documentElement.appendChild(document.body);
  document.defaultView = {
    location: { pathname: '/probes/ui-screens/demo.html', search: '' },
    history: { replaceState: () => {} },
    navigator: {},
    matchMedia: (query) => ({ matches: false, media: query }),
    requestAnimationFrame: null,
    cancelAnimationFrame: null,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  return document;
}

export function createHost() {
  const document = createDocument();
  const host = document.createElement('div');
  host.id = 'ui-root';
  document.documentElement.appendChild(host);
  return { document, host };
}

/** Dispatch a keydown on the document (the renderer listens in capture phase). */
export function dispatchKey(document, key, options = {}) {
  const event = {
    type: 'keydown',
    key,
    code: options.code ?? null,
    shiftKey: options.shiftKey === true,
    ctrlKey: options.ctrlKey === true,
    altKey: options.altKey === true,
    metaKey: options.metaKey === true,
    repeat: options.repeat === true,
    defaultPrevented: false,
    propagationStopped: false
  };
  event.preventDefault = function preventDefault() { event.defaultPrevented = true; };
  event.stopPropagation = function stopPropagation() { event.propagationStopped = true; };
  document.dispatchEvent(event);
  return event;
}

export function keyEvent(key, options = {}) {
  const event = {
    type: 'keydown',
    key,
    code: options.code ?? null,
    shiftKey: options.shiftKey === true,
    repeat: options.repeat === true,
    defaultPrevented: false,
    propagationStopped: false
  };
  event.preventDefault = function preventDefault() { event.defaultPrevented = true; };
  event.stopPropagation = function stopPropagation() { event.propagationStopped = true; };
  return event;
}

export { Element, TextNode };
