// Histórico de downloads.
const path = require('path');
const { jsonStore } = require('./store');

let store = null;
const MAX = 2000;

function init(dir) {
  store = jsonStore(path.join(dir, 'historico.json'), []);
}

function add(entry) {
  const list = store.get();
  list.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, date: Date.now(), ...entry });
  if (list.length > MAX) list.length = MAX;
  store.set(list);
}

function list() {
  return store.get();
}

function update(id, patch) {
  const list = store.get();
  const item = list.find((e) => e.id === id);
  if (!item) return null;
  if (Array.isArray(patch.tags)) item.tags = patch.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  if (typeof patch.notes === 'string') item.notes = patch.notes.slice(0, 5000);
  store.set(list);
  return item;
}

function remove(id) {
  store.set(store.get().filter((e) => e.id !== id));
}

function clear() {
  store.set([]);
}

module.exports = { init, add, list, update, remove, clear, flush: () => store && store.flush() };
