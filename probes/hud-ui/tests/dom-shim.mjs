/**
 * Minimal DOM shim for the HUD unit suite. Not a browser: it implements exactly
 * the surface `hud.mjs` uses, plus enough traversal for assertions. A 2D canvas
 * context records operations instead of rasterising.
 */

class RecordingContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = [];
    this.strokeStyle = '#000';
    this.fillStyle = '#000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.globalAlpha = 1;
    this.font = '10px sans-serif';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this._dash = [];
  }

  _record(name) {
    this.calls.push(name);
  }

  setTransform() { this._record('setTransform'); }
  save() { this._record('save'); }
  restore() { this._record('restore'); }
  clearRect() { this._record('clearRect'); }
  fillRect() { this._record('fillRect'); }
  strokeRect() { this._record('strokeRect'); }
  beginPath() { this._record('beginPath'); }
  closePath() { this._record('closePath'); }
  moveTo() { this._record('moveTo'); }
  lineTo() { this._record('lineTo'); }
  arc() { this._record('arc'); }
  fill() { this._record('fill'); }
  stroke() { this._record('stroke'); }
  fillText() { this._record('fillText'); }
  drawImage() { this._record('drawImage'); }
  setLineDash(dash) { this._dash = dash; this._record('setLineDash'); }

  count(name) {
    let total = 0;
    for (let i = 0; i < this.calls.length; i += 1) if (this.calls[i] === name) total += 1;
    return total;
  }

  reset() {
    this.calls.length = 0;
  }
}

const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'canvas']);

function kebab(name) {
  return name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
}

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this._text = '';
    this._listeners = Object.create(null);
    this._className = '';
    this._classes = new Set();
    this.style = new StyleDeclaration();
    this.dataset = new Proxy(this, {
      get: (target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const attribute = 'data-' + kebab(prop);
        return target.attributes.has(attribute) ? target.attributes.get(attribute) : undefined;
      },
      set: (target, prop, value) => {
        target.setAttribute('data-' + kebab(prop), String(value));
        return true;
      },
      has: (target, prop) => typeof prop === 'string' && target.attributes.has('data-' + kebab(prop)),
      deleteProperty: (target, prop) => {
        target.removeAttribute('data-' + kebab(prop));
        return true;
      }
    });
    this.classList = {
      add: (...names) => {
        names.forEach((name) => this._classes.add(name));
        this._syncClassAttribute();
      },
      remove: (...names) => {
        names.forEach((name) => this._classes.delete(name));
        this._syncClassAttribute();
      },
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const next = force === undefined ? !this._classes.has(name) : force === true;
        if (next) this._classes.add(name);
        else this._classes.delete(name);
        this._syncClassAttribute();
        return next;
      }
    };
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value || '');
    this._classes = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  _syncClassAttribute() {
    this._className = [...this._classes].join(' ');
  }

  get hidden() {
    return this.attributes.has('hidden');
  }

  set hidden(value) {
    if (value) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  get src() {
    return this.getAttribute('src') ?? '';
  }

  set src(value) {
    this.setAttribute('src', String(value));
  }

  get alt() {
    return this.getAttribute('alt') ?? '';
  }

  set alt(value) {
    this.setAttribute('alt', String(value));
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    if (!child) throw new Error('appendChild(null)');
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const text = new TextNode(node, this.ownerDocument);
        this.appendChild(text);
      } else {
        this.appendChild(node);
      }
    }
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    let text = this._text;
    for (const child of this.children) text += child.textContent;
    return text;
  }

  set textContent(value) {
    this._text = value === null || value === undefined ? '' : String(value);
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
  }

  addEventListener(type, handler) {
    if (typeof handler !== 'function') return;
    (this._listeners[type] || (this._listeners[type] = [])).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this._listeners[type];
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type, event = {}) {
    const list = this._listeners[type];
    if (!list) return;
    for (const handler of list) handler({ type, target: this, ...event });
  }

  /** Test helper: every descendant with a data-field attribute. */
  fields() {
    const out = [];
    walk(this, (node) => {
      if (node.getAttribute && node.getAttribute('data-field')) out.push(node);
    });
    return out;
  }

  /** Test helper: first descendant (or self) matching a data-field value. */
  field(name) {
    if (this.getAttribute && this.getAttribute('data-field') === name) return this;
    let found = null;
    walk(this, (node) => {
      if (!found && node.getAttribute && node.getAttribute('data-field') === name) found = node;
    });
    return found;
  }

  querySelectorAll() {
    const out = [];
    walk(this, (node) => {
      if (node !== this) out.push(node);
    });
    return out;
  }

  get clientWidth() {
    return this._clientWidth || 0;
  }

  set clientWidth(value) {
    this._clientWidth = value;
  }

  get clientHeight() {
    return this._clientHeight || 0;
  }

  set clientHeight(value) {
    this._clientHeight = value;
  }
}

class TextNode {
  constructor(text, ownerDocument) {
    this.textValue = String(text);
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
  }

  get textContent() {
    return this.textValue;
  }

  set textContent(value) {
    this.textValue = String(value);
  }
}

class StyleDeclaration {
  constructor() {
    this.props = Object.create(null);
  }

  setProperty(name, value) {
    this.props[name] = String(value);
  }

  getPropertyValue(name) {
    return this.props[name] ?? '';
  }
}

class CanvasElement extends Element {
  constructor(ownerDocument) {
    super('canvas', ownerDocument);
    this.width = 0;
    this.height = 0;
    this._context = new RecordingContext2D(this);
  }

  getContext(kind) {
    return kind === '2d' ? this._context : null;
  }
}

function walk(node, visit) {
  visit(node);
  if (!node.children) return;
  for (const child of node.children) walk(child, visit);
}

function createDocument() {
  const doc = {
    createElement(tag) {
      const name = String(tag).toLowerCase();
      const node = name === 'canvas' ? new CanvasElement(doc) : new Element(name, doc);
      node.tagName = name.toUpperCase();
      return node;
    },
    createTextNode(text) {
      return new TextNode(text, doc);
    },
    createElementNS(namespace, tag) {
      return doc.createElement(tag);
    }
  };
  doc.body = doc.createElement('body');
  return doc;
}

export { createDocument, Element, CanvasElement, RecordingContext2D, walk };
