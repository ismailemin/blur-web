/**
 * Blur Web — UI screen renderer.
 *
 * Framework-free DOM renderer over `screens.mjs`. It owns no simulation state
 * and applies no setting itself: every change becomes an event for the host.
 *
 *   import { mountUiScreens } from './screens.js';
 *   const ui = mountUiScreens(document.getElementById('ui-root'), {
 *     context: 'race',
 *     mode: 'solo',
 *     profileSettings: profile.settings,
 *     profileRevision: profile.revision
 *   });
 *   ui.on('settings-commit', ({ profilePatch }) => profileStore.updateSettings(profilePatch));
 *   ui.open('pause');
 *
 * Storage: nothing is written here. The host persists `localSettings` and the
 * profile patch.
 */

import {
  BINDING_ACTIONS,
  BINDING_BY_ID,
  BROWSER_REQUIREMENTS,
  ERROR_CATALOG,
  PROJECT_LAYOUT_NOTE,
  SCREEN_DEFS,
  SETTINGS_BY_PATH,
  SETTINGS_SCHEMA,
  SETTINGS_SECTIONS,
  UI_LOCAL_SETTINGS_KEY,
  UI_SCREENS_VERSION,
  activeScreen,
  bindingCodes,
  buildDiagnostic,
  closeScreen,
  createUiState,
  diagnosticText,
  fnv1a32,
  isOpen,
  navigateFocus,
  pausePolicy,
  reduce,
  resolveError,
  settingsFromProfile,
  trapFocusIndex
} from './screens.mjs';

export const UI_RENDERER_VERSION = 1;

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

const TITLE_ID = 'uis-title';
const DESC_ID = 'uis-desc';

function h(doc, tag, props = {}, children = []) {
  const element = doc.createElement(tag);
  if (props.class) element.className = props.class;
  if (props.id) element.id = props.id;
  if (props.type) element.setAttribute('type', props.type);
  if (props.role) element.setAttribute('role', props.role);
  if (props.title) element.setAttribute('title', props.title);
  if (props.href) element.setAttribute('href', props.href);
  if (props.for) element.setAttribute('for', props.for);
  if (props.name) element.setAttribute('name', props.name);
  if (props.placeholder) element.setAttribute('placeholder', props.placeholder);
  if (props.autocomplete) element.setAttribute('autocomplete', props.autocomplete);
  if (props.tabindex !== undefined) element.setAttribute('tabindex', String(props.tabindex));
  if (props.min !== undefined) element.setAttribute('min', String(props.min));
  if (props.max !== undefined) element.setAttribute('max', String(props.max));
  if (props.step !== undefined) element.setAttribute('step', String(props.step));
  if (props.hidden) element.hidden = true;
  if (props.disabled) element.disabled = true;
  if (props.checked) element.checked = true;
  if (props.selected) element.selected = true;
  if (props.value !== undefined) element.value = props.value;
  if (props.text !== undefined) element.textContent = String(props.text);
  if (props.style) {
    for (const [key, value] of Object.entries(props.style)) element.style[key] = value;
  }
  if (props.dataset) {
    for (const [key, value] of Object.entries(props.dataset)) {
      if (value !== null && value !== undefined) element.dataset[key] = String(value);
    }
  }
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (props.on) {
    for (const [name, handler] of Object.entries(props.on)) element.addEventListener(name, handler);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      for (const nested of child) if (nested !== null && nested !== undefined && nested !== false) add(doc, element, nested);
    } else {
      add(doc, element, child);
    }
  }
  return element;
}

function add(doc, element, child) {
  if (child === null || child === undefined || child === false) return;
  if (typeof child === 'string' || typeof child === 'number') {
    element.appendChild(doc.createTextNode(String(child)));
  } else {
    element.appendChild(child);
  }
}

function chip(doc, text, tone = '') {
  return h(doc, 'span', {
    class: 'uis-chip' + (tone ? ' uis-chip-' + tone : ''),
    text
  });
}

function button(doc, label, options = {}) {
  return h(doc, 'button', {
    class: 'uis-button' + (options.primary ? ' uis-button-primary' : '') +
      (options.danger ? ' uis-button-danger' : '') + (options.small ? ' uis-button-small' : ''),
    type: 'button',
    text: label,
    disabled: options.disabled === true,
    dataset: { focus: options.focus ?? null, autofocus: options.autofocus ? '1' : null },
    attrs: {
      'aria-label': options.ariaLabel ?? null,
      'aria-describedby': options.describedBy ?? null
    },
    on: options.on ? { click: options.on } : {}
  });
}

function copyButton(doc, onClick, focus) {
  return button(doc, 'COPY DIAGNOSTICS', { focus, small: true, on: onClick });
}

function projectNote(doc) {
  return h(doc, 'p', {
    class: 'uis-project-note',
    text: PROJECT_LAYOUT_NOTE,
    dataset: { retailDerived: 'false' }
  });
}

function screenHeading(doc, screen, titleOverride = null) {
  return h(doc, 'header', { class: 'uis-head' }, [
    h(doc, 'p', { class: 'uis-eyebrow', text: screen.eyebrow }),
    h(doc, 'h2', {
      class: 'uis-title',
      id: TITLE_ID,
      text: titleOverride ?? screen.title,
      tabindex: -1
    }),
    h(doc, 'p', { class: 'uis-description', id: DESC_ID, text: screen.description })
  ]);
}

export function mountUiScreens(host, options = {}) {
  if (!host || typeof host.appendChild !== 'function') {
    throw new TypeError('mountUiScreens(host, options): host must be a DOM element');
  }
  const doc = host.ownerDocument ?? globalThis.document;
  if (!doc) throw new Error('mountUiScreens(host, options): no document available');

  let state = createUiState(options);
  const listeners = new Map();
  let destroyed = false;
  let previousFocus = null;
  let lastScreen = null;
  let gamepadPrevious = { buttons: [], axes: [] };
  let gamepadFrame = null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const reducedMotion = options.reducedMotion === true;
  let copyText = typeof options.copyText === 'function' ? options.copyText : null;

  const root = h(doc, 'div', {
    class: 'uis-root',
    hidden: true,
    dataset: {
      uiScreensVersion: String(UI_SCREENS_VERSION),
      reducedMotion: reducedMotion ? 'true' : 'auto'
    },
    attrs: { 'data-testid': 'ui-screens' }
  });
  const backdrop = h(doc, 'div', { class: 'uis-backdrop', attrs: { 'aria-hidden': 'true' } });
  const panel = h(doc, 'section', {
    class: 'uis-panel',
    role: 'dialog',
    attrs: {
      'aria-modal': 'true',
      'aria-labelledby': TITLE_ID,
      'aria-describedby': DESC_ID
    }
  });
  const head = h(doc, 'div', { class: 'uis-panel-head' });
  const body = h(doc, 'div', { class: 'uis-panel-body' });
  const foot = h(doc, 'footer', { class: 'uis-panel-foot' });
  const live = h(doc, 'div', {
    class: 'uis-live',
    role: 'status',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' }
  });
  panel.append(head, body, live, foot);
  root.append(backdrop, panel);
  host.appendChild(root);

  function emit(name, payload) {
    const set = listeners.get(name);
    if (!set) return;
    for (const handler of [...set]) handler(payload, state);
  }

  function on(name, handler) {
    if (typeof handler !== 'function') throw new TypeError('on(name, handler): handler must be a function');
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
    return () => listeners.get(name)?.delete(handler);
  }

  function announce(text) {
    live.textContent = String(text ?? '');
  }

  function dispatch(action) {
    if (destroyed) return state;
    const before = state;
    state = reduce(state, action);
    if (state === before) return state;
    for (const effect of state.effects) {
      emit(effect.type, effect);
      emit('effect', effect);
    }
    if (Array.isArray(state.effects)) {
      for (const effect of state.effects) {
        if (effect.type === 'open') announce(effect.screen + ' opened');
        else if (effect.type === 'close') announce(effect.screen + ' closed');
        else if (effect.type === 'settings-commit') announce('Settings committed');
        else if (effect.type === 'settings-rejected') announce('Setting rejected: ' + effect.reason);
        else if (effect.type === 'binding-captured') announce('Bound ' + effect.action + ' to ' + effect.code);
        else if (effect.type === 'binding-rejected') announce('Binding rejected: ' + effect.reason);
        else if (effect.type === 'connection-retry') announce('Retrying connection, attempt ' + effect.attempt);
      }
    }
    render();
    if (state.stack.length !== before.stack.length || activeScreen(state)?.id !== activeScreen(before)?.id) {
      emit('screen', { screen: activeScreen(state)?.id ?? null, paused: state.paused });
    }
    return state;
  }

  // ------------------------------------------------------------------ focus

  function focusKeyOf(element) {
    return element?.dataset?.focus ?? null;
  }

  function focusables() {
    if (!isOpen(state)) return [];
    return [...panel.querySelectorAll(FOCUSABLE)].filter((element) =>
      element.hidden !== true && element.disabled !== true);
  }

  function restoreFocus(key) {
    if (!key) return false;
    const escaped = String(key).replace(/"/g, '\\"');
    const element = panel.querySelector('[data-focus="' + escaped + '"]');
    if (element?.focus) {
      element.focus();
      return true;
    }
    return false;
  }

  function focusInitial(screenId) {
    const auto = panel.querySelector('[data-autofocus="1"]');
    if (auto?.focus) {
      auto.focus();
      return;
    }
    const heading = panel.querySelector('#' + TITLE_ID);
    if (heading?.focus) heading.focus();
  }

  // ----------------------------------------------------------------- render

  function render() {
    if (destroyed) return;
    if (!isOpen(state)) {
      if (!root.hidden) {
        root.hidden = true;
        panel.setAttribute('aria-hidden', 'true');
      }
      lastScreen = null;
      if (previousFocus?.focus) {
        previousFocus.focus();
        previousFocus = null;
      }
      return;
    }
    if (root.hidden) {
      root.hidden = false;
      panel.removeAttribute('aria-hidden');
      if (!previousFocus) previousFocus = doc.activeElement;
    }
    const focused = doc.activeElement;
    const key = focusKeyOf(focused);
    const top = activeScreen(state);
    const screen = SCREEN_DEFS[top.id];
    const changed = lastScreen !== top.id;
    lastScreen = top.id;

    root.dataset.context = state.context;
    root.dataset.mode = state.mode;
    root.dataset.paused = state.paused ? 'true' : 'false';
    root.dataset.screen = top.id;
    head.replaceChildren(...renderHead(doc, screen, top));
    body.replaceChildren(...renderBody(doc, top));
    foot.replaceChildren(...renderFoot(doc, top));

    if (changed) focusInitial(top.id);
    else if (!restoreFocus(key)) focusInitial(top.id);
  }

  function renderHead(doc, screen, top) {
    const policy = pausePolicy(state);
    const title = top.id === 'pause'
      ? (policy.pausesSimulation ? 'Paused' : 'Session menu')
      : screen.title;
    return [
      h(doc, 'div', { class: 'uis-head-row' }, [
        h(doc, 'div', {}, [
          h(doc, 'p', { class: 'uis-eyebrow', text: screen.eyebrow }),
          h(doc, 'h2', { class: 'uis-title', id: TITLE_ID, text: title, tabindex: -1 }),
          h(doc, 'p', {
            class: 'uis-description',
            id: DESC_ID,
            text: top.id === 'pause' ? policy.reason : screen.description
          })
        ]),
        h(doc, 'span', {
          class: 'uis-badge' + (policy.pausesSimulation ? ' uis-badge-paused' : ''),
          text: policy.pausesSimulation ? 'SIM PAUSED' : (state.context === 'race' ? 'ROOM LIVE' : 'MENU')
        })
      ]),
      projectNote(doc)
    ];
  }

  function renderFoot(doc, top) {
    const policy = pausePolicy(state);
    const parts = [];
    if (state.capture) parts.push('CAPTURING — press a key, Esc cancels');
    else if (top.id === 'settings' && state.settings.dirty) parts.push('UNSAVED CHANGES');
    else if (top.id === 'settings' && state.settings.profileReadOnly) parts.push('PROFILE READ-ONLY');
    else if (state.context === 'race' && !policy.pausesSimulation) parts.push('ROOM CONTINUES');
    else parts.push('Esc closes this screen');
    return [
      h(doc, 'span', { class: 'uis-foot-note', text: parts.join('  /  ') }),
      h(doc, 'span', {
        class: 'uis-foot-meta',
        text: 'ui-screens ' + UI_SCREENS_VERSION + '  /  project layout'
      })
    ];
  }

  // ----------------------------------------------------------------- screens

  function renderBody(doc, top) {
    switch (top.id) {
      case 'pause': return renderPause(doc);
      case 'settings': return renderSettings(doc);
      case 'controls': return renderControls(doc);
      case 'loading': return renderLoading(doc);
      case 'connection-lost': return renderConnection(doc);
      case 'version-mismatch': return renderVersion(doc);
      case 'unsupported-browser': return renderBrowser(doc);
      case 'confirm-quit': return renderConfirmQuit(doc);
      case 'error-details': return renderError(doc);
      default:
        return [h(doc, 'p', { text: 'Unknown screen ' + top.id })];
    }
  }

  function renderPause(doc) {
    const policy = pausePolicy(state);
    const room = state.connection?.roomCode ?? activeScreen(state)?.params?.roomCode ?? null;
    const actions = h(doc, 'div', { class: 'uis-actions' }, [
      button(doc, policy.pausesSimulation ? 'RESUME' : 'BACK TO RACE', {
        primary: true,
        autofocus: true,
        focus: 'resume',
        on: () => dispatch({ type: 'ui/back' })
      }),
      button(doc, 'SETTINGS', {
        focus: 'pause-settings',
        on: () => dispatch({ type: 'ui/open', screen: 'settings' })
      }),
      button(doc, 'CONTROLS', {
        focus: 'pause-controls',
        on: () => dispatch({ type: 'ui/open', screen: 'controls' })
      }),
      button(doc, policy.roomContinues ? 'LEAVE ROOM' : 'LEAVE RACE', {
        danger: true,
        focus: 'pause-quit',
        on: () => dispatch({ type: 'quit/request', target: policy.roomContinues ? 'room' : 'menu' })
      })
    ]);
    return [
      h(doc, 'div', {
        class: 'uis-panel-block' + (policy.pausesSimulation ? '' : ' uis-warn'),
        dataset: { pauseAuthority: policy.authority }
      }, [
        h(doc, 'p', { class: 'uis-block-title', text: policy.pausesSimulation ? 'SIMULATION PAUSED' : 'ROOM CONTINUES' }),
        h(doc, 'p', { text: policy.reason }),
        policy.roomContinues ? h(doc, 'p', {
          class: 'uis-hint',
          text: 'The host owns the room clock. Opening this menu does not stop other players and does not give a tactical pause.'
        }) : null
      ]),
      room ? h(doc, 'p', { class: 'uis-room', text: 'ROOM ' + room }) : null,
      actions,
      h(doc, 'p', { class: 'uis-hint', text: 'Pause, settings and help are project screens; retail layout and art are not claimed.' })
    ];
  }

  function renderSettings(doc) {
    const nodes = [];
    if (state.settings.profileReadOnly) {
      nodes.push(h(doc, 'div', { class: 'uis-panel-block uis-error', role: 'alert' }, [
        h(doc, 'p', { class: 'uis-block-title', text: 'PROFILE IS READ-ONLY' }),
        h(doc, 'p', { text: 'Settings changes are applied for this session but cannot be saved over the profile.' })
      ]));
    }
    if (state.settings.issues.length) {
      nodes.push(h(doc, 'p', {
        class: 'uis-hint uis-warn-text',
        text: state.settings.issues.length + ' stored setting(s) were invalid and use the default: ' +
          state.settings.issues.map((issue) => issue.path + ' (' + issue.reason + ')').join(', ')
      }));
    }
    for (const section of SETTINGS_SECTIONS) {
      const fields = SETTINGS_SCHEMA.filter((entry) => entry.section === section.id);
      if (!fields.length) continue;
      nodes.push(h(doc, 'fieldset', { class: 'uis-group', dataset: { section: section.id } }, [
        h(doc, 'legend', { text: section.label }),
        h(doc, 'p', { class: 'uis-group-note', text: section.note }),
        ...fields.map((entry) => renderField(doc, entry))
      ]));
    }

    const resetBlock = state.settings.resetPending
      ? h(doc, 'div', { class: 'uis-panel-block uis-error', role: 'alert' }, [
        h(doc, 'p', { class: 'uis-block-title', text: 'RESET ALL SETTINGS?' }),
        h(doc, 'p', { text: 'Profile quality, volumes, camera, steering and HUD return to their documented defaults. Display scale, vsync and language also reset. Bindings are not changed.' }),
        h(doc, 'div', { class: 'uis-actions' }, [
          button(doc, 'YES, RESET', {
            danger: true, focus: 'reset-confirm',
            on: () => dispatch({ type: 'settings/reset-confirm' })
          }),
          button(doc, 'CANCEL', { focus: 'reset-cancel', on: () => dispatch({ type: 'settings/reset-cancel' }) })
        ])
      ])
      : null;

    nodes.push(resetBlock ?? h(doc, 'div', { class: 'uis-actions uis-actions-end' }, [
      button(doc, 'RESET TO DEFAULTS', {
        focus: 'reset-request', on: () => dispatch({ type: 'settings/reset-request' })
      }),
      button(doc, 'REVERT', {
        focus: 'settings-revert',
        disabled: !state.settings.dirty,
        on: () => dispatch({ type: 'settings/revert' })
      }),
      button(doc, 'APPLY & CLOSE', {
        primary: true, focus: 'settings-close',
        on: () => {
          dispatch({ type: 'settings/commit' });
          dispatch({ type: 'ui/back' });
        }
      })
    ]));

    return nodes;
  }

  function renderField(doc, entry) {
    const id = 'uis-field-' + entry.path.replace(/\./g, '-');
    const value = readValue(state.settings.values, entry.path);
    const scope = entry.scope === 'profile' ? 'profile' : 'project';
    const badge = chip(doc, scope, scope === 'project' ? 'project' : 'profile');
    const help = entry.help ? h(doc, 'p', { class: 'uis-field-help', text: entry.help }) : null;
    const control = controlFor(doc, entry, id, value);
    if (entry.type === 'boolean') {
      return h(doc, 'div', { class: 'uis-field uis-field-check', dataset: { field: entry.path } }, [
        h(doc, 'label', { class: 'uis-check', for: id }, [control, h(doc, 'span', { text: entry.label })]),
        h(doc, 'span', { class: 'uis-field-side' }, [badge]),
        help
      ]);
    }
    return h(doc, 'div', { class: 'uis-field', dataset: { field: entry.path } }, [
      h(doc, 'label', { class: 'uis-field-label', for: id }, [
        h(doc, 'span', { text: entry.label }),
        badge
      ]),
      control,
      help
    ]);
  }

  function readValue(values, path) {
    return path.split('.').reduce((cursor, part) => (
      cursor && typeof cursor === 'object' ? cursor[part] : undefined), values);
  }

  function commitSetting(path, value, event) {
    dispatch({ type: 'settings/set', path, value, commit: true, force: true });
    dispatch({ type: 'settings/commit' });
  }

  function controlFor(doc, entry, id, value) {
    const focus = 'setting-' + entry.path;
    if (entry.type === 'enum') {
      return h(doc, 'select', {
        id,
        class: 'uis-select',
        value,
        dataset: { focus, settingPath: entry.path },
        attrs: { 'aria-label': entry.label },
        on: {
          change: (event) => commitSetting(entry.path, event.currentTarget?.value ?? event.target?.value, event)
        }
      }, entry.values.map((optionValue) => h(doc, 'option', {
        value: optionValue,
        text: optionValue,
        selected: optionValue === value
      })));
    }
    if (entry.type === 'boolean') {
      return h(doc, 'input', {
        id,
        class: 'uis-checkbox',
        type: 'checkbox',
        checked: value === true,
        dataset: { focus, settingPath: entry.path },
        attrs: { 'aria-label': entry.label },
        on: {
          change: (event) => commitSetting(entry.path, event.target.checked === true, event)
        }
      });
    }
    if (entry.type === 'number') {
      const output = h(doc, 'output', {
        class: 'uis-range-value',
        for: id,
        text: Number(value).toFixed(entry.decimals ?? 2),
        dataset: { valueFor: entry.path }
      });
      return h(doc, 'div', { class: 'uis-range-row' }, [
        h(doc, 'input', {
          id,
          class: 'uis-range',
          type: 'range',
          value: String(value),
          min: entry.min,
          max: entry.max,
          step: entry.step,
          dataset: { focus, settingPath: entry.path },
          attrs: { 'aria-label': entry.label, 'aria-valuetext': String(value) },
          on: {
            input: (event) => {
              const next = event.target.value;
              dispatch({ type: 'settings/set', path: entry.path, value: next });
              output.textContent = Number(next).toFixed(entry.decimals ?? 2);
            },
            change: (event) => commitSetting(entry.path, event.target.value, event)
          }
        }),
        output
      ]);
    }
    if (entry.readOnly) {
      return h(doc, 'div', { class: 'uis-readonly' }, [
        h(doc, 'code', { text: String(value), dataset: { focus, settingPath: entry.path } }),
        button(doc, 'CHANGE IN CONTROLS', {
          small: true,
          focus: 'binding-open-' + entry.path,
          on: () => dispatch({ type: 'ui/open', screen: 'controls' })
        })
      ]);
    }
    return h(doc, 'input', {
      id,
      class: 'uis-input',
      type: 'text',
      value: String(value ?? ''),
      dataset: { focus, settingPath: entry.path }
    });
  }

  function renderControls(doc) {
    const nodes = [];
    if (state.capture) {
      const target = BINDING_BY_ID[state.capture.action];
      nodes.push(h(doc, 'div', {
        class: 'uis-panel-block uis-capture',
        role: 'alert',
        dataset: { capture: state.capture.action, device: state.capture.device }
      }, [
        h(doc, 'p', { class: 'uis-block-title', text: 'PRESS AN INPUT' }),
        h(doc, 'p', { text: 'Binding ' + (target?.label ?? state.capture.action) + ' (' + state.capture.device + '). Esc cancels.' }),
        state.capture.conflict ? h(doc, 'p', {
          class: 'uis-warn-text',
          text: 'Already used by ' + state.capture.conflict.label + ' in the ' + state.capture.conflict.context + ' context.'
        }) : null,
        button(doc, 'CANCEL CAPTURE', {
          small: true, focus: 'capture-cancel',
          on: () => dispatch({ type: 'binding/capture-cancel' })
        })
      ]));
    }
    if (!state.capture) {
      nodes.push(h(doc, 'p', {
        class: 'uis-hint',
        text: 'Keyboard and gamepad bindings follow INPUT1. Rebinding changes the event payload; this screen does not write storage. Conflicts inside one context are rejected.'
      }));
    }

    const list = h(doc, 'div', { class: 'uis-bindings', attrs: { 'aria-label': 'input bindings' } });
    for (const action of BINDING_ACTIONS) {
      const keyboard = bindingCodes(state.bindings, action.id, 'keyboard') ?? [];
      const pad = bindingCodes(state.bindings, action.id, 'pad') ?? [];
      const capturing = state.capture?.action === action.id;
      list.appendChild(h(doc, 'div', {
        class: 'uis-binding' + (capturing ? ' is-capturing' : ''),
        dataset: { binding: action.id, context: action.context }
      }, [
        h(doc, 'span', { class: 'uis-binding-name' }, [
          h(doc, 'strong', { text: action.label }),
          h(doc, 'span', { class: 'uis-binding-context', text: action.context })
        ]),
        h(doc, 'span', { class: 'uis-binding-codes' }, [
          h(doc, 'span', { class: 'uis-code', text: keyboard.length ? keyboard.join(' / ') : 'unbound' }),
          h(doc, 'span', { class: 'uis-code uis-code-pad', text: pad.length ? pad.join(' / ') : (action.axis ? 'keyboard only' : 'unbound') })
        ]),
        h(doc, 'span', { class: 'uis-binding-actions' }, [
          button(doc, 'KEY', {
            small: true,
            focus: 'bind-keyboard-' + action.id,
            ariaLabel: 'Rebind keyboard for ' + action.label,
            on: () => dispatch({ type: 'binding/capture-start', action: action.id, device: 'keyboard' })
          }),
          action.axis ? null : button(doc, 'PAD', {
            small: true,
            focus: 'bind-pad-' + action.id,
            ariaLabel: 'Rebind gamepad for ' + action.label,
            on: () => dispatch({ type: 'binding/capture-start', action: action.id, device: 'pad' })
          })
        ])
      ]));
    }
    nodes.push(list);
    nodes.push(h(doc, 'div', { class: 'uis-actions uis-actions-end' }, [
      button(doc, 'RESET BINDINGS', {
        focus: 'bindings-reset', on: () => dispatch({ type: 'binding/reset' })
      }),
      button(doc, 'BACK', {
        primary: true, focus: 'controls-back', on: () => dispatch({ type: 'ui/back' })
      })
    ]));
    return nodes;
  }

  function renderLoading(doc) {
    const loading = state.loading ?? { label: 'Loading race', progress: null, attempt: 1, canCancel: true };
    const progress = loading.progress;
    return [
      h(doc, 'div', { class: 'uis-loading' }, [
        h(doc, 'p', { class: 'uis-loading-label', text: loading.label }),
        h(doc, 'div', {
          class: 'uis-progress',
          role: 'progressbar',
          attrs: {
            'aria-label': loading.label,
            'aria-valuemin': '0',
            'aria-valuemax': '100',
            'aria-valuenow': progress === null ? '0' : String(Math.round(progress * 100))
          }
        }, [
          h(doc, 'i', {
            class: 'uis-progress-fill' + (progress === null ? ' is-indeterminate' : ''),
            style: { width: progress === null ? '100%' : (Math.round(progress * 100) + '%') }
          })
        ]),
        h(doc, 'p', { class: 'uis-hint', text: progress === null
          ? 'Attempt ' + loading.attempt + ' — progress is not reported by this stage.'
          : Math.round(progress * 100) + '% · attempt ' + loading.attempt })
      ]),
      loading.code ? h(doc, 'div', { class: 'uis-panel-block uis-error', role: 'alert' }, [
        h(doc, 'p', { class: 'uis-block-title', text: loading.code }),
        button(doc, 'VIEW ERROR DETAILS', {
          small: true, focus: 'loading-error-details',
          on: () => dispatch({ type: 'ui/open', screen: 'error-details', params: { code: loading.code } })
        })
      ]) : null,
      h(doc, 'div', { class: 'uis-actions uis-actions-end' }, [
        loading.canCancel === false ? null : button(doc, 'CANCEL', {
          primary: true, autofocus: true, focus: 'loading-cancel',
          on: () => dispatch({ type: 'loading/cancel' })
        })
      ])
    ];
  }

  function renderConnection(doc) {
    const connection = state.connection ?? {
      code: 'NETWORK_LOST', status: 'lost', attempt: 0, maxAttempts: 3, roomCode: null, latencyMs: null
    };
    const entry = resolveError(connection.code);
    return [
      h(doc, 'div', { class: 'uis-panel-block uis-error', role: 'alert' }, [
        h(doc, 'p', { class: 'uis-error-code', text: entry.code }),
        h(doc, 'p', { class: 'uis-block-title', text: entry.title }),
        h(doc, 'p', { text: entry.explanation })
      ]),
      h(doc, 'dl', { class: 'uis-facts' }, [
        h(doc, 'dt', { text: 'ROOM' }),
        h(doc, 'dd', { text: connection.roomCode ?? 'unknown' }),
        h(doc, 'dt', { text: 'ATTEMPT' }),
        h(doc, 'dd', { text: connection.attempt + ' / ' + connection.maxAttempts }),
        connection.latencyMs === null ? null : h(doc, 'dt', { text: 'LAST LATENCY' }),
        connection.latencyMs === null ? null : h(doc, 'dd', { text: Math.round(connection.latencyMs) + ' ms' })
      ]),
      h(doc, 'div', { class: 'uis-actions' }, [
        button(doc, 'RETRY', {
          primary: true, autofocus: true, focus: 'connection-retry',
          disabled: connection.attempt >= connection.maxAttempts,
          on: () => dispatch({ type: 'connection/retry' })
        }),
        button(doc, 'CANCEL', {
          focus: 'connection-cancel',
          on: () => dispatch({ type: 'connection/cancel' })
        }),
        button(doc, 'ERROR DETAILS', {
          focus: 'connection-details',
          on: () => dispatch({ type: 'ui/open', screen: 'error-details', params: { code: connection.code } })
        })
      ]),
      connection.attempt >= connection.maxAttempts
        ? h(doc, 'p', { class: 'uis-warn-text', text: 'Retry limit reached. Cancel to return; the room is not left automatically.' })
        : null
    ];
  }

  function renderVersion(doc) {
    const info = state.versionInfo ?? { expected: 'unknown', actual: 'unknown', kind: 'room', code: 'VERSION_MISMATCH' };
    const entry = resolveError(info.code);
    return [
      h(doc, 'div', { class: 'uis-panel-block uis-error', role: 'alert' }, [
        h(doc, 'p', { class: 'uis-error-code', text: entry.code }),
        h(doc, 'p', { class: 'uis-block-title', text: entry.title }),
        h(doc, 'p', { text: entry.explanation })
      ]),
      h(doc, 'dl', { class: 'uis-facts' }, [
        h(doc, 'dt', { text: 'EXPECTED' }),
        h(doc, 'dd', { text: info.expected }),
        h(doc, 'dt', { text: 'THIS BUILD' }),
        h(doc, 'dd', { text: info.actual }),
        h(doc, 'dt', { text: 'KIND' }),
        h(doc, 'dd', { text: info.kind })
      ]),
      h(doc, 'div', { class: 'uis-actions' }, [
        button(doc, 'BACK', {
          primary: true, autofocus: true, focus: 'version-back',
          on: () => dispatch({ type: 'ui/back' })
        }),
        copyButton(doc, () => copyError(info.code), 'version-copy')
      ]),
      h(doc, 'p', { class: 'uis-hint', text: info.kind === 'profile'
        ? 'The newer profile was not loaded and is never overwritten by this build.'
        : 'Nothing was downloaded or overwritten; the room handshake stopped at the version check.' })
    ];
  }

  function renderBrowser(doc) {
    const browser = state.browser ?? { missing: [], code: 'BROWSER_UNSUPPORTED', allowContinue: false };
    const labels = browser.missing.map((code) => {
      const entry = ERROR_CATALOG[code] ?? ERROR_CATALOG.UNKNOWN_ERROR;
      const requirement = BROWSER_REQUIREMENTS.find((item) => item.id === code)?.label ?? null;
      return { code, title: entry.title, explanation: entry.explanation, requirement };
    });
    return [
      h(doc, 'div', { class: 'uis-panel-block uis-error', role: 'alert' }, [
        h(doc, 'p', { class: 'uis-error-code', text: resolveError(browser.code).code }),
        h(doc, 'p', { class: 'uis-block-title', text: 'Missing browser capabilities' }),
        h(doc, 'p', { text: browser.missing.length
          ? browser.missing.length + ' required capability check(s) failed.'
          : 'No capability list was supplied; the typed code is preserved.' })
      ]),
      h(doc, 'ul', { class: 'uis-missing' }, labels.map((item) => h(doc, 'li', {
        dataset: { missingCode: item.code }
      }, [
        h(doc, 'code', { text: item.code }),
        h(doc, 'strong', { text: item.title }),
        h(doc, 'span', { text: item.explanation }),
        item.requirement ? h(doc, 'span', { class: 'uis-hint', text: 'Needs: ' + item.requirement }) : null
      ]))),
      h(doc, 'div', { class: 'uis-actions' }, [
        button(doc, 'VIEW DETAILS', {
          primary: true, autofocus: true, focus: 'browser-details',
          on: () => dispatch({ type: 'browser/details' })
        }),
        button(doc, 'CONTINUE ANYWAY', {
          focus: 'browser-continue',
          disabled: browser.allowContinue !== true,
          describedBy: 'uis-browser-continue-note',
          on: () => dispatch({ type: 'ui/back' })
        })
      ]),
      h(doc, 'p', {
        id: 'uis-browser-continue-note',
        class: 'uis-hint',
        text: browser.allowContinue === true
          ? 'The host allowed a degraded start; the missing features stay reported.'
          : 'Continue is disabled: the renderer and map verification need every listed capability.'
      }),
      browser.userAgent ? h(doc, 'p', { class: 'uis-hint', text: 'User agent: ' + sanitizeUserAgent(browser.userAgent) }) : null
    ];
  }

  function sanitizeUserAgent(value) {
    return String(value).replace(/[A-Za-z]:\\[^\s"'<>]+/g, '<path>').slice(0, 180);
  }

  function renderConfirmQuit(doc) {
    const confirm = state.confirmQuit ?? { target: 'menu', roomCode: null };
    const room = confirm.target === 'room';
    return [
      h(doc, 'div', { class: 'uis-panel-block uis-warn', role: 'alert' }, [
        h(doc, 'p', { class: 'uis-block-title', text: room ? 'LEAVE THE ROOM?' : 'LEAVE THE RACE?' }),
        h(doc, 'p', { text: room
          ? 'The room is host-authoritative. Leaving cannot be undone, and the host cannot pause the room for you.'
          : 'The current race will end. Local progress already saved by the profile store is kept.' }),
        confirm.roomCode ? h(doc, 'p', { class: 'uis-room', text: 'ROOM ' + confirm.roomCode }) : null
      ]),
      h(doc, 'div', { class: 'uis-actions' }, [
        button(doc, room ? 'LEAVE ROOM' : 'LEAVE RACE', {
          danger: true, autofocus: true, focus: 'quit-confirm',
          on: () => dispatch({ type: 'quit/confirm' })
        }),
        button(doc, 'CANCEL', {
          focus: 'quit-cancel', on: () => dispatch({ type: 'quit/cancel' })
        })
      ])
    ];
  }

  function renderError(doc) {
    const error = state.error ?? resolveError('UNKNOWN_ERROR');
    const diagnostic = error.diagnostic ?? buildDiagnostic(state, error.requestedCode ?? error.code, null);
    const text = diagnosticText(diagnostic);
    return [
      h(doc, 'div', { class: 'uis-panel-block uis-error', role: 'alert' }, [
        h(doc, 'p', { class: 'uis-error-code', text: error.code }),
        h(doc, 'p', { class: 'uis-block-title', text: error.title }),
        h(doc, 'p', { text: error.explanation }),
        error.known === false ? h(doc, 'p', {
          class: 'uis-warn-text',
          text: 'Reported code ' + error.requestedCode + ' has no catalog entry; it is shown unchanged.'
        }) : null,
        error.detail ? h(doc, 'p', { class: 'uis-error-detail', text: sanitizeUserAgent(error.detail) }) : null
      ]),
      h(doc, 'div', { class: 'uis-diag' }, [
        h(doc, 'div', { class: 'uis-diag-head' }, [
          h(doc, 'h3', { text: 'DIAGNOSTIC BLOCK' }),
          copyButton(doc, () => copyDiagnostic(text), 'error-copy')
        ]),
        h(doc, 'pre', {
          class: 'uis-diag-pre',
          id: 'uis-diagnostic',
          tabindex: 0,
          text,
          dataset: { diagnosticCode: error.code }
        }),
        h(doc, 'p', { class: 'uis-hint', text: 'Copyable. No tokens, cookies, credentials, player names or local paths are included.' })
      ]),
      h(doc, 'div', { class: 'uis-actions uis-actions-end' }, [
        error.retryable ? button(doc, 'RETRY', {
          primary: true, focus: 'error-retry',
          on: () => dispatch({ type: 'error/retry', code: error.code })
        }) : null,
        button(doc, 'CLOSE', {
          primary: !error.retryable, autofocus: !error.retryable, focus: 'error-close',
          on: () => dispatch({ type: 'ui/back' })
        })
      ])
    ];
  }

  // ------------------------------------------------------------------ copy

  function fallbackCopy(text) {
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    (doc.body ?? root).appendChild(area);
    if (typeof area.select === 'function') area.select();
    area.remove?.();
    return false;
  }

  async function copyTextToClipboard(text) {
    if (copyText) {
      try {
        const result = await copyText(text);
        return result !== false;
      } catch {
        return false;
      }
    }
    const nav = doc.defaultView?.navigator ?? (typeof navigator !== 'undefined' ? navigator : null);
    if (nav?.clipboard?.writeText) {
      try {
        await nav.clipboard.writeText(text);
        return true;
      } catch {
        return fallbackCopy(text);
      }
    }
    return fallbackCopy(text);
  }

  function copyDiagnostic(text) {
    const attempt = copyTextToClipboard(text);
    Promise.resolve(attempt).then((ok) => {
      emit('copy', { kind: 'diagnostic', ok, length: text.length, hash: fnv1a32(text) });
      announce(ok ? 'Diagnostic block copied' : 'Clipboard unavailable; select the block manually');
    });
    return attempt;
  }

  function copyError(code) {
    const diagnostic = buildDiagnostic(state, code, null);
    return copyDiagnostic(diagnosticText(diagnostic));
  }

  // --------------------------------------------------------------- keyboard

  function handleKey(event) {
    if (destroyed || !isOpen(state)) return false;
    if (!event || typeof event.key !== 'string') return false;

    if (state.capture && state.capture.waiting) {
      if (event.key === 'Escape') {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        dispatch({ type: 'binding/capture-cancel' });
        return true;
      }
      if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') {
        return true;
      }
      const code = typeof event.code === 'string' && event.code ? event.code : keyToCode(event.key);
      if (!code) return true;
      if (event.preventDefault) event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      dispatch({ type: 'binding/capture-key', code });
      return true;
    }

    if (event.key === 'Escape') {
      if (event.preventDefault) event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      dispatch({ type: 'ui/escape' });
      return true;
    }

    if (event.key === 'Tab') {
      const list = focusables();
      if (!list.length) return false;
      const active = doc.activeElement;
      let index = list.indexOf(active);
      if (index < 0) index = event.shiftKey ? list.length : -1;
      const next = trapFocusIndex(index, list.length, event.shiftKey === true);
      if (event.preventDefault) event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      list[next]?.focus?.();
      return true;
    }

    const active = doc.activeElement;
    const tag = active?.tagName;
    const type = active?.getAttribute?.('type');
    if (tag === 'INPUT' && type === 'range') return false;
    if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && type !== 'checkbox')) return false;

    const intent = keyIntent(event.key);
    if (!intent) return false;
    const list = focusables();
    if (!list.length) return false;
    const index = Math.max(0, list.indexOf(active));
    const next = navigateFocus(index, list.length, intent, 1);
    if (next < 0 || next === index) {
      if (event.preventDefault) event.preventDefault();
      return true;
    }
    if (event.preventDefault) event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    list[next]?.focus?.();
    return true;
  }

  function keyIntent(key) {
    if (key === 'ArrowUp') return 'up';
    if (key === 'ArrowDown') return 'down';
    if (key === 'ArrowLeft') return 'left';
    if (key === 'ArrowRight') return 'right';
    if (key === 'Home') return 'home';
    if (key === 'End') return 'end';
    return null;
  }

  function keyToCode(key) {
    if (/^[a-zA-Z0-9]$/.test(key)) return 'Key' + key.toUpperCase();
    const map = {
      ' ': 'Space', Escape: 'Escape', Enter: 'Enter', Tab: 'Tab',
      ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
      Shift: 'ShiftLeft', Control: 'ControlLeft', Alt: 'AltLeft', Meta: 'MetaLeft'
    };
    return map[key] ?? null;
  }

  // ---------------------------------------------------------------- gamepad

  function gamepadButtonsToArray(pad) {
    return Array.from(pad?.buttons ?? [], (entry) => (
      typeof entry === 'number' ? entry > 0 : entry?.pressed === true || Number(entry?.value) > 0.5));
  }

  const PAD_NAMES = Object.freeze([
    'A', 'B', 'X', 'Y', 'LeftShoulder', 'RightShoulder', 'LeftTrigger', 'RightTrigger',
    'Back', 'Start', 'LeftThumb', 'RightThumb',
    'DPadUp', 'DPadDown', 'DPadLeft', 'DPadRight'
  ]);

  function handleGamepad(pad) {
    if (destroyed || !pad) return null;
    const buttons = gamepadButtonsToArray(pad);
    const axes = [Number(pad.axes?.[0] ?? 0), Number(pad.axes?.[1] ?? 0)];
    const previous = gamepadPrevious;
    const pressed = [];
    for (let index = 0; index < buttons.length; index += 1) {
      if (buttons[index] === true && previous.buttons?.[index] !== true) pressed.push(index);
    }
    const intent = gamepadIntentLocal(buttons, axes, previous);
    gamepadPrevious = { buttons, axes };

    if (state.capture?.waiting && state.capture.device === 'pad') {
      const index = pressed.find((candidate) => PAD_NAMES[candidate]);
      if (index !== undefined) {
        dispatch({ type: 'binding/capture-pad', button: PAD_NAMES[index] });
        return 'capture';
      }
      return null;
    }
    if (!isOpen(state)) {
      if (intent === 'pause') emit('pause-requested', { source: 'gamepad' });
      return intent;
    }
    if (intent === 'back') {
      dispatch({ type: 'ui/escape' });
      return intent;
    }
    if (intent === 'confirm') {
      const active = doc.activeElement;
      if (active && typeof active.click === 'function') active.click();
      return intent;
    }
    if (['up', 'down', 'left', 'right'].includes(intent)) {
      const list = focusables();
      if (list.length) {
        const index = Math.max(0, list.indexOf(doc.activeElement));
        const next = navigateFocus(index, list.length, intent, 1);
        list[next]?.focus?.();
      }
    }
    return intent;
  }

  function gamepadIntentLocal(buttons, axes, previous) {
    // Kept local so the renderer does not need a second import path.
    const down = (index) => buttons[index] === true;
    const was = (index) => previous.buttons?.[index] === true;
    if (down(9) && !was(9)) return 'pause';
    if (down(8) && !was(8)) return 'back';
    if (down(1) && !was(1)) return 'back';
    if (down(0) && !was(0)) return 'confirm';
    if (down(12) && !was(12)) return 'up';
    if (down(13) && !was(13)) return 'down';
    if (down(14) && !was(14)) return 'left';
    if (down(15) && !was(15)) return 'right';
    const x = Number(axes[0] ?? 0);
    const y = Number(axes[1] ?? 0);
    const px = Number(previous.axes?.[0] ?? 0);
    const py = Number(previous.axes?.[1] ?? 0);
    if (y < -0.5 && py >= -0.5) return 'up';
    if (y > 0.5 && py <= 0.5) return 'down';
    if (x < -0.5 && px >= -0.5) return 'left';
    if (x > 0.5 && px <= 0.5) return 'right';
    return null;
  }

  function pollGamepad() {
    if (destroyed || typeof options.gamepadSource !== 'function') return;
    let pads = [];
    try { pads = options.gamepadSource() ?? []; } catch { pads = []; }
    const pad = Array.from(pads).find((entry) => entry && entry.connected !== false) ?? null;
    if (pad) handleGamepad(pad);
  }

  function startGamepadLoop() {
    const view = doc.defaultView;
    if (!view || typeof view.requestAnimationFrame !== 'function') return;
    const tick = () => {
      if (destroyed) return;
      pollGamepad();
      gamepadFrame = view.requestAnimationFrame(tick);
    };
    gamepadFrame = view.requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- public

  function handleDocumentKey(event) {
    if (!isOpen(state)) return;
    handleKey(event);
  }

  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('keydown', handleDocumentKey, true);
  }
  if (typeof options.gamepadSource === 'function') startGamepadLoop();

  render();

  const api = {
    element: root,
    version: UI_RENDERER_VERSION,
    open: (screen, params) => dispatch({ type: 'ui/open', screen, params }),
    close: () => dispatch({ type: 'ui/back' }),
    back: () => dispatch({ type: 'ui/back' }),
    dispatch,
    state: () => state,
    setContext: (context, mode) => dispatch({ type: 'ui/set-context', context, mode }),
    setProfile: (profile, profileOptions = {}) => {
      const read = settingsFromProfile(profile?.settings, {
        readOnly: profileOptions.readOnly === true || profile?.schemaVersion > 1,
        schemaVersion: profile?.schemaVersion ?? 1
      });
      const dispatchable = reduce(state, {
        type: 'settings/load',
        profileSettings: profile?.settings,
        readOnly: read.readOnly,
        schemaVersion: profile?.schemaVersion ?? 1,
        revision: profile?.revision ?? 0,
        local: profileOptions.local ?? null
      });
      state = dispatchable;
      for (const effect of state.effects) { emit(effect.type, effect); emit('effect', effect); }
      render();
      return state;
    },
    on,
    handleKey,
    handleGamepad,
    pollGamepad,
    focusables,
    previewDiagnostic: (code, context) => buildDiagnostic(state, code, context),
    diagnosticText: (code, context) => diagnosticText(buildDiagnostic(state, code, context)),
    copyDiagnostic,
    render,
    snapshot: () => snapshotOf(state),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      if (typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', handleDocumentKey, true);
      if (gamepadFrame !== null && typeof doc.defaultView?.cancelAnimationFrame === 'function') {
        doc.defaultView.cancelAnimationFrame(gamepadFrame);
      }
      root.remove?.();
      if (host.__uiScreens === api) delete host.__uiScreens;
    }
  };
  host.__uiScreens = api;
  return api;
}

function snapshotOf(state) {
  return {
    screen: activeScreen(state)?.id ?? null,
    paused: state.paused,
    context: state.context,
    mode: state.mode,
    stack: state.stack.map((entry) => entry.id),
    settings: { values: { ...state.settings.values }, dirty: state.settings.dirty },
    bindings: JSON.parse(JSON.stringify(state.bindings)),
    capture: state.capture ? { ...state.capture } : null,
    error: state.error ? { code: state.error.code, requestedCode: state.error.requestedCode } : null
  };
}

export { UI_LOCAL_SETTINGS_KEY, UI_SCREENS_VERSION };
