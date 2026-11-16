const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'modify-url-bar-icons.uc.js'), 'utf8');

// ---- Minimal DOM: just enough of Element for the script and the tests. ----

class Element {
  constructor(document, tag) {
    this.ownerDocument = document;
    this.tagName = tag;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = new Style();
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (name) => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
    };
  }
  get id() { return this.attributes.get('id') ?? ''; }
  set id(value) { this.attributes.set('id', value); }
  get className() { return this.attributes.get('class') ?? ''; }
  set className(value) { this.attributes.set('class', value); }
  get hidden() { return this.attributes.has('hidden'); }
  set hidden(value) { this.toggleAttribute('hidden', value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, force) {
    const on = force ?? !this.attributes.has(name);
    if (on) this.attributes.set(name, ''); else this.attributes.delete(name);
    return on;
  }
  get isConnected() {
    for (let node = this; node; node = node.parentNode) if (node === this.ownerDocument.documentElement) return true;
    return false;
  }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, ref) {
    if (ref && ref.parentNode !== this) throw new Error('NotFoundError: reference node is not a child');
    child.remove();
    const index = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(index, 0, child);
    child.parentNode = this;
    this.ownerDocument.mutated(this);
    return child;
  }
  removeChild(child) { child.remove(); return child; }
  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentNode = null;
    this.ownerDocument.mutated(parent);
  }
  replaceWith(node) {
    const parent = this.parentNode;
    const next = parent.children[parent.children.indexOf(this) + 1] ?? null;
    this.remove();
    parent.insertBefore(node, next);
  }
  *descendants() { for (const child of this.children) { yield child; yield* child.descendants(); } }
  matches(selector) {
    return selector.startsWith('#') ? this.id === selector.slice(1) : this.classList.contains(selector.slice(1));
  }
  querySelector(selector) { for (const node of this.descendants()) if (node.matches(selector)) return node; return null; }
  contains(node) { for (; node; node = node.parentNode) if (node === this) return true; return false; }
}

class Style {
  constructor() { this.props = new Map(); this.listStyleImage = ''; }
  getPropertyValue(name) { return this.props.get(name) ?? ''; }
  setProperty(name, value) { this.props.set(name, value); }
}

class Document {
  constructor() {
    this.observers = new Set();
    this.documentElement = new Element(this, 'html');
  }
  createXULElement(tag) { return new Element(this, tag); }
  getElementById(id) {
    if (this.documentElement.id === id) return this.documentElement;
    for (const node of this.documentElement.descendants()) if (node.id === id) return node;
    return null;
  }
  mutated(target) { for (const observer of this.observers) observer.notify(target); }
}

// ---- Fake CustomizableUI shared by every window, like the real module. ----

class FakeCustomizableUI {
  constructor() {
    this.PROVIDER_API = 'api';
    this.widgets = new Map();
    this.placements = new Map(); // widget id -> area id (persists like prefs)
    this.listeners = new Set();
    this.windows = [];
    this.created = [];
  }
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
  getWidget(id) { return this.widgets.has(id) ? { provider: this.PROVIDER_API } : null; }
  getPlacementOfWidget(id) { return this.placements.has(id) ? { area: this.placements.get(id) } : null; }
  notify(node, container, removal) {
    for (const listener of this.listeners) listener.onWidgetAfterDOMChange?.(node, null, container, removal);
  }
  container(window, area) { return window.document.getElementById(`${area}-customization-target`); }
  createWidget(props) {
    if (this.widgets.has(props.id)) throw new Error(`duplicate widget ${props.id}`);
    this.widgets.set(props.id, { ...props, instances: new Map() });
    this.created.push(props.id);
    if (this.placements.has(props.id)) for (const window of this.windows) this.insert(window, props.id);
  }
  insert(window, id) {
    const widget = this.widgets.get(id);
    let node = widget.instances.get(window.document);
    if (!node) { node = widget.onBuild(window.document); widget.instances.set(window.document, node); }
    const container = this.container(window, this.placements.get(id));
    container.appendChild(node);
    this.notify(node, container, false);
  }
  detach(window, id) {
    const node = this.widgets.get(id)?.instances.get(window.document);
    if (!node?.parentNode) return;
    const container = node.parentNode;
    node.remove();
    this.notify(node, container, true);
  }
  // What registerToolbarNode/buildArea do for a window that opens later.
  buildWindow(window) {
    for (const id of this.widgets.keys()) if (this.placements.has(id)) this.insert(window, id);
  }
  destroyWidget(id) {
    if (!this.widgets.has(id)) return;
    for (const window of this.windows) this.detach(window, id);
    this.widgets.delete(id);
  }
  // Test-side stand-ins for dragging in Customize mode.
  place(id, area) {
    this.placements.set(id, area);
    for (const window of this.windows) this.insert(window, id);
  }
  unplace(id) {
    this.placements.delete(id);
    for (const window of this.windows) this.detach(window, id);
  }
}

// ---- One browser window with a Zen-shaped URL bar. ----

function browser(cui, { os = 'Linux', prefs = {}, extension = false } = {}) {
  const document = new Document();
  const el = (tag, id, className, parent, attrs = {}) => {
    const node = document.createXULElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    parent?.appendChild(node);
    return node;
  };
  const toolbox = el('toolbox', 'navigator-toolbox', '', document.documentElement);
  const navBar = el('toolbar', 'nav-bar', '', toolbox);
  const navTarget = el('hbox', 'nav-bar-customization-target', '', navBar);
  const urlbarContainer = el('toolbaritem', 'urlbar-container', '', navTarget);
  const urlbar = el('moz-urlbar', 'urlbar', 'urlbar', urlbarContainer, { pageproxystate: 'valid' });
  const input = el('div', '', 'urlbar-input-container', urlbar);
  const identity = el('box', 'identity-box', 'identity-box', input);
  el('box', 'zen-site-data-icon-button', 'identity-box-button', identity);
  el('box', 'identity-icon-box', 'identity-box-button', identity);
  el('box', 'identity-permission-box', 'identity-box-button', identity);
  el('box', 'tracking-protection-icon-container', '', input);
  const actions = el('hbox', 'page-action-buttons', '', input);
  el('hbox', 'reader-mode-button', 'urlbar-page-action', actions, { hidden: '' });
  el('hbox', 'split-view-button', 'urlbar-page-action', actions, { hidden: '' });
  el('hbox', 'share-button', 'urlbar-page-action', actions, { hidden: '' });
  const mainButton = el('hbox', 'pageActionButton', 'urlbar-page-action', actions);
  if (extension) {
    const ext = el('hbox', 'pageAction-urlbar-ext_example_org', 'urlbar-page-action urlbar-addon-page-action', actions, { tooltiptext: 'Example Extension' });
    ext.style.setProperty('--pageAction-image', 'url("moz-extension://x/icon.png")');
  }
  const star = el('hbox', 'star-button-box', 'urlbar-page-action', actions);
  el('hbox', 'zen-copy-url-button', 'urlbar-page-action', input);
  const top = el('toolbar', 'zen-sidebar-top-buttons', '', toolbox);
  el('hbox', 'zen-sidebar-top-buttons-customization-target', '', top);

  const events = new Map();
  let unload;
  const window = {
    document,
    location: { href: 'chrome://browser/content/browser.xhtml' },
    closed: false,
    CustomizableUI: cui,
    BrowserPageActions: {
      mainButtonNode: mainButton,
      // Real one walks the ordered action list; stand-in answers with a chosen node.
      nextNode: star,
      _getNextNode(action, forUrlbar) { return this.nextNode; },
    },
    addEventListener(name, callback) { events.set(name, callback); },
    removeEventListener(name, callback) { if (events.get(name) === callback) events.delete(name); },
    addUnloadListener(callback) { unload = callback; },
  };
  const observers = document.observers;
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); }
    observe(target, options) { this.targets.add(target); this.options = options; observers.add(this); }
    disconnect() { observers.delete(this); }
    notify(target) { if (this.targets.has(target) && this.options.childList) this.callback([]); }
  }
  const context = vm.createContext({
    document, console, MutationObserver, Promise,
    Services: {
      appinfo: { OS: os },
      prefs: { getBoolPref: (name, fallback) => prefs[name] ?? fallback },
      wm: { getEnumerator: () => cui.windows },
    },
  });
  context.window = window;
  window.MutationObserver = MutationObserver;
  cui.windows.push(window);
  cui.buildWindow(window);
  const run = () => vm.runInContext(source, context);
  run();
  // Attribute changes are not routed through the fake DOM's mutation hook.
  const attributeObserver = () => [...observers].find((o) => o.targets.has(urlbar) && o.options.attributes);
  return {
    window, document, urlbar, input, actions, identity, star, run,
    slot: (id) => document.getElementById(`mubi-${id}`),
    byId: (id) => document.getElementById(id),
    disable: () => unload(),
    close() { window.closed = true; events.get('unload')(); },
    setUrlbarAttribute(name, value) {
      if (value === null) urlbar.removeAttribute(name); else urlbar.setAttribute(name, value);
      attributeObserver()?.callback([]);
    },
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

const ids = (node) => node.children.map((child) => child.id || child.className);

test('Sine metadata uses full repository URLs and ships its linked assets', () => {
  const theme = JSON.parse(fs.readFileSync(path.join(root, 'theme.json')));
  const repo = 'https://github.com/homura-ai/modify-url-bar-icons';
  assert.equal(theme.homepage, repo);
  for (const [field, file] of [['readme', 'README.md'], ['image', 'preview.svg']]) {
    assert.equal(theme[field], `${repo}/raw/refs/heads/main/${file}`);
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
  assert.ok(Date.parse(theme.updatedAt) > Date.parse('2026-09-21'));
  assert.notEqual(theme.version, '1.0.0');
});

test('registers a widget for each icon available on this platform, plus extension page actions', () => {
  const cui = new FakeCustomizableUI();
  browser(cui, { extension: true });
  const created = new Set(cui.created);
  for (const id of ['star-button-box', 'reader-mode-button', 'identity-box', 'zen-site-data-icon-button', 'zen-copy-url-button', 'tracking-protection-icon-container']) {
    assert.ok(created.has(`mubi-${id}`), id);
  }
  assert.ok(!created.has('mubi-share-button'), 'share is macOS/Windows only');
  assert.ok(!created.has('mubi-split-view-button'), 'split view is off in Zen');
  assert.ok(!created.has('mubi-pageActionButton'));
  const ext = cui.widgets.get('mubi-pageAction-urlbar-ext_example_org');
  assert.equal(ext.label, 'Example Extension');
  assert.equal(ext.type, 'custom');
  assert.equal(ext.removable, true);

  const windows = new FakeCustomizableUI();
  browser(windows, { os: 'WINNT', prefs: { 'browser.tabs.splitView.enabled': true } });
  assert.ok(windows.created.includes('mubi-share-button'));
  assert.ok(windows.created.includes('mubi-split-view-button'));
});

test('placing a widget moves the icon into the slot; unplacing returns it to the same spot', () => {
  const cui = new FakeCustomizableUI();
  const b = browser(cui);
  assert.deepEqual(ids(b.actions), ['reader-mode-button', 'split-view-button', 'share-button', 'pageActionButton', 'star-button-box']);

  cui.place('mubi-star-button-box', 'zen-sidebar-top-buttons');
  const slot = b.slot('star-button-box');
  assert.equal(slot.parentNode.id, 'zen-sidebar-top-buttons-customization-target');
  assert.equal(slot.getAttribute('label'), 'Bookmark star');
  assert.equal(b.star.parentNode, slot);
  assert.equal(b.star.getAttribute('mubi-relocated'), 'true');
  assert.deepEqual(ids(b.actions), ['reader-mode-button', 'split-view-button', 'share-button', 'pageActionButton', 'mubi-placeholder']);
  assert.ok(b.actions.children[4].hidden);

  cui.unplace('mubi-star-button-box');
  assert.deepEqual(ids(b.actions), ['reader-mode-button', 'split-view-button', 'share-button', 'pageActionButton', 'star-button-box']);
  assert.ok(!b.star.hasAttribute('mubi-relocated'));
  assert.equal(slot.children.length, 1, 'only the ghost remains in the slot');
});

test('page action insertion targets the placeholder of a relocated icon', () => {
  const cui = new FakeCustomizableUI();
  const b = browser(cui);
  const pageActions = b.window.BrowserPageActions;
  assert.equal(pageActions._getNextNode({}, true), b.star);
  cui.place('mubi-star-button-box', 'nav-bar');
  const placeholder = pageActions._getNextNode({}, true);
  assert.equal(placeholder.className, 'mubi-placeholder');
  assert.equal(placeholder.parentNode, b.actions);
  // Inserting before it must not throw, which is what Firefox does for new extension icons.
  const fresh = b.document.createXULElement('hbox');
  fresh.id = 'pageAction-urlbar-new';
  pageActions.mainButtonNode.parentNode.insertBefore(fresh, placeholder);
  assert.deepEqual(ids(b.actions).slice(-2), ['pageAction-urlbar-new', 'mubi-placeholder']);
  assert.equal(pageActions._getNextNode({}, false), b.star, 'panel lookups are untouched');
  b.disable();
  assert.equal(pageActions._getNextNode({}, true), b.star, 'patch removed on unload');
});

test('the site-data button can leave a relocated identity block and both restore cleanly', () => {
  const cui = new FakeCustomizableUI();
  const b = browser(cui);
  cui.place('mubi-identity-box', 'zen-sidebar-top-buttons');
  cui.place('mubi-zen-site-data-icon-button', 'nav-bar');
  const siteData = b.byId('zen-site-data-icon-button');
  assert.equal(b.identity.parentNode, b.slot('identity-box'));
  assert.equal(siteData.parentNode, b.slot('zen-site-data-icon-button'));
  assert.deepEqual(ids(b.identity), ['mubi-placeholder', 'identity-icon-box', 'identity-permission-box']);

  cui.unplace('mubi-identity-box');
  cui.unplace('mubi-zen-site-data-icon-button');
  assert.deepEqual(ids(b.input), ['identity-box', 'tracking-protection-icon-container', 'page-action-buttons', 'zen-copy-url-button']);
  assert.deepEqual(ids(b.identity), ['zen-site-data-icon-button', 'identity-icon-box', 'identity-permission-box']);
});

test('icons Zen adds after startup are attached once they appear', async () => {
  const cui = new FakeCustomizableUI();
  const b = browser(cui);
  const copy = b.byId('zen-copy-url-button');
  copy.remove();
  cui.place('mubi-zen-copy-url-button', 'nav-bar');
  assert.equal(b.slot('zen-copy-url-button').children.length, 1);
  b.input.appendChild(copy);
  await b.settle();
  assert.equal(copy.parentNode, b.slot('zen-copy-url-button'));
});

test('an extension icon Firefox removed is not revived; its replacement is picked up', async () => {
  const cui = new FakeCustomizableUI();
  const b = browser(cui, { extension: true });
  const id = 'pageAction-urlbar-ext_example_org';
  const old = b.byId(id);
  cui.place(`mubi-${id}`, 'nav-bar');
  assert.equal(old.parentNode, b.slot(id));
  assert.equal(b.slot(id).querySelector('.mubi-ghost').style.listStyleImage, 'url("moz-extension://x/icon.png")');

  old.remove();
  cui.unplace(`mubi-${id}`);
  assert.equal(b.byId(id), null, 'removed icon stays removed');
  assert.ok(!ids(b.actions).includes('mubi-placeholder'));

  cui.place(`mubi-${id}`, 'nav-bar');
  const fresh = b.document.createXULElement('hbox');
  fresh.id = id;
  fresh.className = 'urlbar-page-action urlbar-addon-page-action';
  b.actions.insertBefore(fresh, b.star);
  await b.settle();
  assert.equal(fresh.parentNode, b.slot(id));
});

test('mirrors URL bar editing state onto the toolbox', () => {
  const cui = new FakeCustomizableUI();
  const b = browser(cui);
  const toolbox = b.byId('navigator-toolbox');
  assert.ok(!toolbox.hasAttribute('mubi-editing'));
  b.setUrlbarAttribute('pageproxystate', 'invalid');
  assert.ok(toolbox.hasAttribute('mubi-editing'));
  b.setUrlbarAttribute('pageproxystate', 'valid');
  assert.ok(!toolbox.hasAttribute('mubi-editing'));
  b.setUrlbarAttribute('usertyping', '');
  assert.ok(toolbox.hasAttribute('mubi-editing'));
  b.disable();
  assert.ok(!toolbox.hasAttribute('mubi-editing'));
  b.setUrlbarAttribute('usertyping', '');
  assert.ok(!toolbox.hasAttribute('mubi-editing'), 'observer disconnected');
});

test('a second window reuses the registrations; closing the owner hands them over', () => {
  const cui = new FakeCustomizableUI();
  const a = browser(cui);
  cui.place('mubi-star-button-box', 'zen-sidebar-top-buttons');
  const registered = cui.created.length;
  const b = browser(cui);
  assert.equal(cui.created.length, registered, 'no duplicate widgets');
  assert.equal(b.star.parentNode, b.slot('star-button-box'), 'existing placement applied to the new window');

  a.close();
  assert.equal(a.star.parentNode, a.actions, 'closing window returned its icon');
  assert.equal(a.window.__modifyUrlBarIcons, undefined);
  assert.ok(cui.widgets.has('mubi-star-button-box'), 'the other window re-registered');
  assert.equal(b.star.parentNode, b.slot('star-button-box'));
  assert.equal(cui.placements.get('mubi-star-button-box'), 'zen-sidebar-top-buttons');

  b.disable();
  b.disable();
  assert.equal(b.star.parentNode, b.actions);
  assert.equal(cui.widgets.size, 0, 'last window removed every widget');
  assert.equal(cui.listeners.size, 0);
  assert.equal(cui.placements.get('mubi-star-button-box'), 'zen-sidebar-top-buttons', 'placements survive for re-enable');

  b.run();
  assert.equal(b.star.parentNode, b.slot('star-button-box'), 'reload restores the placement');
});

test('package references existing files and settings default to the mod defaults', () => {
  const theme = JSON.parse(fs.readFileSync(path.join(root, 'theme.json')));
  const prefs = JSON.parse(fs.readFileSync(path.join(root, theme.preferences)));
  for (const script of Object.keys(theme.scripts)) assert.ok(fs.existsSync(path.join(root, script)));
  assert.ok(fs.existsSync(path.join(root, theme.style)));
  assert.equal(theme.supportsUnload, true);
  const css = fs.readFileSync(path.join(root, theme.style), 'utf8');
  for (const pref of prefs) {
    if (!pref.property) continue;
    // A preference Sine has not written yet reads as false, so defaults must be false.
    assert.equal(pref.defaultValue, false, pref.property);
    assert.ok(css.includes(`-moz-pref("${pref.property}")`), pref.property);
  }
});
