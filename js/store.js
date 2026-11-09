// Everything is kept in this browser only. Nothing is sent anywhere except to
// the camera addresses the user enters.

const DATA_KEY = 'reolink-web:data';
const REMEMBER_KEY = 'reolink-web:remember';

const DEFAULTS = { cameras: [], refreshMs: 1000, reduced: false, ptzSpeed: 32 };

function read(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}

function write(storage, key, value) {
  try { storage.setItem(key, value); return true; } catch { return false; }
}

function remove(storage, key) {
  try { storage.removeItem(key); } catch { /* storage unavailable */ }
}

export function getRemember() {
  return read(localStorage, REMEMBER_KEY) !== '0';
}

function load() {
  const raw = read(getRemember() ? localStorage : sessionStorage, DATA_KEY);
  if (!raw) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export const state = load();

export function save() {
  const remember = getRemember();
  const ok = write(remember ? localStorage : sessionStorage, DATA_KEY, JSON.stringify(state));
  remove(remember ? sessionStorage : localStorage, DATA_KEY);
  return ok;
}

export function setRemember(remember) {
  write(localStorage, REMEMBER_KEY, remember ? '1' : '0');
  save();
}

export function forgetAll() {
  remove(localStorage, DATA_KEY);
  remove(sessionStorage, DATA_KEY);
  Object.assign(state, DEFAULTS, { cameras: [] });
}

export function findCamera(id) {
  return state.cameras.find((cam) => cam.id === id);
}

export function upsertCamera(camera) {
  const index = state.cameras.findIndex((cam) => cam.id === camera.id);
  if (index >= 0) state.cameras[index] = camera;
  else state.cameras.push(camera);
  return save();
}

export function deleteCamera(id) {
  state.cameras = state.cameras.filter((cam) => cam.id !== id);
  save();
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
