// Talks to the camera's HTTP API directly from the browser.
//
// Reolink cameras don't send CORS headers, so a page hosted elsewhere cannot
// read API responses. Two things still work without them:
//   - <img> can display the Snap endpoint, which gives us the live view.
//   - A "no-cors" POST reaches the camera, so commands can be sent, but the
//     reply can't be read. A network failure is the only error we can detect.

const FRAME_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 5000;
const MAX_RETRY_MS = 15000;

/** Returns the camera origin such as https://192.168.1.50:8443, or null if invalid. */
export function parseAddress(input) {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    const isWeb = url.protocol === 'https:' || url.protocol === 'http:';
    const hasExtras = url.username || url.password || url.pathname !== '/' || url.search || url.hash;
    return isWeb && !hasExtras ? url.origin : null;
  } catch {
    return null;
  }
}

function authQuery(cam) {
  return `user=${encodeURIComponent(cam.username)}&password=${encodeURIComponent(cam.password)}`;
}

export function snapshotUrl(cam, { reduced = false } = {}) {
  const rs = Math.random().toString(36).slice(2, 12);
  const size = reduced ? '&width=640&height=360' : '';
  return `${cam.address}/cgi-bin/api.cgi?cmd=Snap&channel=${cam.channel}&rs=${rs}${size}&${authQuery(cam)}`;
}

// Commands for a camera run one at a time so a Stop can never overtake the
// move it is meant to end.
const queues = new Map();

function enqueue(cam, task) {
  const previous = queues.get(cam.id) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(cam.id, next);
  return next;
}

export function sendCommand(cam, cmd, param) {
  const url = `${cam.address}/cgi-bin/api.cgi?cmd=${cmd}&${authQuery(cam)}`;
  return enqueue(cam, () => fetch(url, {
    method: 'POST',
    mode: 'no-cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    keepalive: true,
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify([{ cmd, action: 0, param }]),
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  }));
}

export function ptz(cam, op, speed) {
  const param = { channel: cam.channel, op };
  if (op !== 'Stop') param.speed = speed;
  return sendCommand(cam, 'PtzCtrl', param);
}

/** Loads one snapshot. Resolves with the loaded image, rejects on failure. */
export function loadSnapshot(cam, options) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'sync';
    const timer = setTimeout(() => { img.src = ''; reject(new Error('timeout')); }, FRAME_TIMEOUT_MS);
    // Wait for the decode as well as the download, so the frame can paint at once.
    img.onload = () => {
      clearTimeout(timer);
      img.decode().catch(() => {}).then(() => resolve(img));
    };
    img.onerror = () => { clearTimeout(timer); reject(new Error('load failed')); };
    img.src = snapshotUrl(cam, options);
  });
}

/**
 * Keeps a layer filled with fresh snapshots. Each frame is fully loaded before
 * it replaces the previous one, and the next request waits for the last, so a
 * slow camera or connection never builds up a backlog.
 */
export class Feed {
  constructor(cam, layer, { interval, reduced = false, inView = true, onState }) {
    Object.assign(this, { cam, layer, interval, reduced, inView, onState });
    this.fails = 0;
    this.hasFrame = false;
    this.timer = null;
    this.pending = null;
    this.destroyed = false;
    this.onVisibility = () => this.sync();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.sync();
  }

  get shouldRun() {
    return !this.destroyed && this.inView && !document.hidden;
  }

  setInView(inView) {
    this.inView = inView;
    this.sync();
  }

  retry() {
    this.fails = 0;
    clearTimeout(this.timer);
    this.timer = null;
    this.onState({ status: 'connecting', hasFrame: this.hasFrame });
    this.sync();
  }

  destroy() {
    this.destroyed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    clearTimeout(this.timer);
    this.pending = null;
  }

  sync() {
    if (this.shouldRun && !this.pending && !this.timer) this.load();
  }

  load() {
    const started = performance.now();
    const token = {};
    this.pending = token;
    loadSnapshot(this.cam, { reduced: this.reduced }).then(
      (img) => this.finish(token, img, started),
      () => this.finish(token, null, started),
    );
  }

  // Stacks the new frame over the old one and removes the old one only after
  // the new one has been painted, so the picture is never blank between frames.
  present(img) {
    this.layer.append(img);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      while (img.previousElementSibling) img.previousElementSibling.remove();
    }));
  }

  finish(token, img, started) {
    if (this.pending !== token) return;
    this.pending = null;

    let delay;
    if (img) {
      this.fails = 0;
      this.hasFrame = true;
      img.alt = '';
      img.draggable = false;
      this.present(img);
      this.onState({
        status: 'live',
        hasFrame: true,
        at: new Date(),
        ratio: img.naturalWidth / img.naturalHeight,
      });
      delay = Math.max(0, this.interval - (performance.now() - started));
    } else if (this.reduced && !this.hasFrame) {
      // Some firmware rejects the width/height options, so fall back to full size.
      this.reduced = false;
      delay = 0;
    } else {
      this.fails += 1;
      this.onState({ status: 'error', hasFrame: this.hasFrame });
      delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** this.fails);
    }

    if (!this.shouldRun) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sync();
    }, delay);
  }
}
