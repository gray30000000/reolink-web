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
const PROBE_WINDOW_MS = 3000;
const PROBE_MIN_GAIN = 1.2;

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
  const stream = reduced ? '&snapType=sub' : '';
  return `${cam.address}/cgi-bin/api.cgi?cmd=Snap&channel=${cam.channel}&rs=${rs}${stream}&${authQuery(cam)}`;
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
 * Keeps a layer filled with fresh snapshots.
 *
 * Starts with one request at a time. If maxInFlight allows more, it tries
 * overlapping requests, spaced across the camera's response time, and keeps
 * each extra one only if the measured frame rate really improves. Cameras that
 * handle snapshots one by one therefore stay at a single request.
 */
export class Feed {
  constructor(cam, layer, { interval, reduced = false, inView = true, maxInFlight = 1, onState }) {
    Object.assign(this, { cam, layer, interval, reduced, inView, maxInFlight, onState });
    this.limit = 1;
    this.inFlight = new Set();
    this.nextStart = 0;
    this.lastSeq = 0;
    this.shownSeq = 0;
    this.latency = 0;
    this.fails = 0;
    this.fps = null;
    this.baselineFps = null;
    this.hasFrame = false;
    this.timer = null;
    this.destroyed = false;
    this.resetWindow();
    this.onVisibility = () => {
      this.resetWindow();
      this.sync();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.sync();
  }

  get shouldRun() {
    return !this.destroyed && this.inView && !document.hidden;
  }

  resetWindow() {
    this.windowStart = performance.now();
    this.windowFrames = 0;
  }

  setInView(inView) {
    this.inView = inView;
    this.resetWindow();
    this.sync();
  }

  retry() {
    this.fails = 0;
    this.nextStart = 0;
    clearTimeout(this.timer);
    this.timer = null;
    this.onState({ status: 'connecting', hasFrame: this.hasFrame });
    this.sync();
  }

  destroy() {
    this.destroyed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    clearTimeout(this.timer);
    this.inFlight.clear();
  }

  sync() {
    if (!this.shouldRun || this.timer || this.inFlight.size >= this.limit) return;
    const wait = this.nextStart - performance.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.sync();
      }, wait);
      return;
    }
    this.load();
  }

  load() {
    const started = performance.now();
    const token = { seq: ++this.lastSeq };
    this.inFlight.add(token);
    this.nextStart = started + (this.limit > 1 ? Math.max(this.interval, this.latency / this.limit) : this.interval);
    loadSnapshot(this.cam, { reduced: this.reduced }).then(
      (img) => this.finish(token, img, started),
      () => this.finish(token, null, started),
    );
    this.sync();
  }

  // Stacks the new frame over the old one and removes the old one only after
  // the new one has been painted, so the picture is never blank between frames.
  present(img) {
    this.layer.append(img);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      while (img.previousElementSibling) img.previousElementSibling.remove();
    }));
  }

  // Tries one more overlapping request each window, and backs out of any step
  // that didn't deliver a real gain in frame rate.
  measure(now) {
    const elapsed = now - this.windowStart;
    if (elapsed < PROBE_WINDOW_MS) return;
    this.fps = (this.windowFrames * 1000) / elapsed;
    this.resetWindow();

    if (this.baselineFps !== null && this.fps < this.baselineFps * PROBE_MIN_GAIN) {
      this.limit -= 1;
      this.maxInFlight = this.limit;
      this.baselineFps = null;
    } else if (this.limit < this.maxInFlight) {
      this.baselineFps = this.fps;
      this.limit += 1;
    } else {
      this.baselineFps = null;
    }
  }

  finish(token, img, started) {
    if (!this.inFlight.delete(token)) return;
    const now = performance.now();

    if (img) {
      const elapsed = now - started;
      this.latency = this.latency ? this.latency * 0.7 + elapsed * 0.3 : elapsed;
      this.fails = 0;
      // With overlapping requests, a frame can arrive after a newer one.
      if (token.seq > this.shownSeq) {
        if (!this.hasFrame) this.resetWindow();
        this.shownSeq = token.seq;
        this.hasFrame = true;
        img.alt = '';
        img.draggable = false;
        this.present(img);
        this.windowFrames += 1;
        this.measure(now);
        this.onState({
          status: 'live',
          hasFrame: true,
          at: new Date(),
          fps: this.fps,
          ratio: img.naturalWidth / img.naturalHeight,
        });
      }
    } else if (this.reduced && !this.hasFrame) {
      // Some firmware may reject the low-resolution option, so fall back to full size.
      this.reduced = false;
    } else {
      this.limit = 1;
      this.maxInFlight = 1;
      this.baselineFps = null;
      this.fails += 1;
      this.onState({ status: 'error', hasFrame: this.hasFrame });
      this.nextStart = now + Math.min(MAX_RETRY_MS, 1000 * 2 ** this.fails);
    }

    this.sync();
  }
}
