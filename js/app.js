import { h, icon, toast } from './dom.js';
import { Feed, loadSnapshot, parseAddress, ptz } from './reolink.js';
import {
  deleteCamera, findCamera, forgetAll, getRemember, newId, save, setRemember, state, upsertCamera,
} from './store.js';

const REFRESH_OPTIONS = [
  { ms: 5000, label: 'Saver' },
  { ms: 2000, label: 'Normal' },
  { ms: 1000, label: 'Fast' },
  { ms: 250, label: 'Max' },
];

const SPEED_OPTIONS = [
  { value: 8, label: 'Slow' },
  { value: 32, label: 'Medium' },
  { value: 64, label: 'Fast' },
];

const QUALITY_OPTIONS = [
  { value: 'smooth', label: 'Low quality' },
  { value: 'detail', label: 'High quality' },
];

const root = document.getElementById('app');
const leaveHandlers = [];

function onLeave(fn) {
  leaveHandlers.push(fn);
}

function route() {
  leaveHandlers.splice(0).forEach((fn) => fn());
  root.replaceChildren();
  window.scrollTo(0, 0);

  const [page, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (page === 'camera' && id) viewCamera(id);
  else if (page === 'settings' && id) viewForm(id === 'new' ? null : id);
  else if (page === 'settings') viewSettings();
  else viewGrid();
}

function topBar(title, { back, actions = [] } = {}) {
  return h('header', { class: 'bar' },
    back && h('a', { class: 'iconbtn', href: back, 'aria-label': 'Back' }, icon('back')),
    h('h1', {}, title),
    actions);
}

function segmented(label, options, current, onChange) {
  const buttons = options.map((option) => h('button', {
    type: 'button',
    'aria-pressed': String(option.value === current),
    onclick: () => {
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === buttons[options.indexOf(option)])));
      onChange(option.value);
    },
  }, option.label));
  return h('div', { class: 'seg', role: 'group', 'aria-label': label }, buttons);
}

function createStage(cam, { interval, reduced, inView, maxInFlight, showRate = false }) {
  const layer = h('div', { class: 'layer' });
  const time = h('span', { class: 'time' }, 'Connecting…');
  const errorCard = h('div', { class: 'feed-error', hidden: true },
    h('strong', {}, 'Can’t load this camera'),
    h('p', {}, 'Open it once to accept its certificate, then check the address and login.'),
    h('div', { class: 'row' },
      h('a', { class: 'btn small', href: cam.address, target: '_blank', rel: 'noopener noreferrer' }, 'Open camera'),
      h('button', { class: 'btn small', type: 'button', onclick: () => feed.retry() }, 'Retry')));
  const stage = h('div', { class: 'stage', 'data-status': 'connecting' },
    layer,
    h('div', { class: 'hud' },
      h('span', { class: 'dot' }),
      h('span', { class: 'name' }, cam.name),
      time),
    errorCard);

  const feed = new Feed(cam, layer, {
    interval,
    reduced,
    inView,
    maxInFlight,
    onState({ status, hasFrame, at, fps, ratio }) {
      stage.dataset.status = status;
      errorCard.hidden = !(status === 'error' && !hasFrame);
      if (ratio) stage.style.aspectRatio = String(ratio);
      if (at) time.textContent = showRate && fps != null ? `${fps.toFixed(1)} fps · ${at.toLocaleTimeString()}` : at.toLocaleTimeString();
      else if (status === 'error') time.textContent = 'Reconnecting…';
      else if (status === 'connecting') time.textContent = 'Connecting…';
    },
  });

  return { stage, layer, feed };
}

/* Camera grid */

function viewGrid() {
  root.append(topBar('Cameras', {
    actions: [h('a', { class: 'iconbtn', href: '#/settings', 'aria-label': 'Settings' }, icon('gear'))],
  }));

  if (!state.cameras.length) {
    root.append(emptyState());
    return;
  }

  const feeds = new Map();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => feeds.get(entry.target)?.setInView(entry.isIntersecting));
  }, { rootMargin: '100px' });

  const grid = h('main', { class: 'grid' });
  for (const cam of state.cameras) {
    const { stage, feed } = createStage(cam, {
      interval: state.refreshMs,
      reduced: state.reduced,
      inView: false,
    });
    stage.append(h('a', { class: 'tile-hit', href: `#/camera/${cam.id}`, 'aria-label': `Open ${cam.name}` }));
    feeds.set(stage, feed);
    grid.append(stage);
    observer.observe(stage);
  }
  root.append(grid);

  onLeave(() => {
    observer.disconnect();
    feeds.forEach((feed) => feed.destroy());
  });
}

function emptyState() {
  return h('main', { class: 'page' },
    h('p', { class: 'lead' }, 'View your Reolink cameras from this phone. Your logins stay on this device.'),
    h('ol', { class: 'card steps' },
      h('li', {}, 'Make sure this device is on the same network as your cameras, or connected by VPN.'),
      h('li', {}, 'Add a camera using its IP address and login.'),
      h('li', {}, 'Tap Open camera once and accept the certificate warning, so this browser can load its pictures.')),
    h('a', { class: 'btn primary block', href: '#/settings/new' }, 'Add a camera'));
}

/* Single camera */

function viewCamera(id) {
  const cam = findCamera(id);
  if (!cam) {
    location.replace('#/');
    return;
  }

  const count = state.cameras.length;
  const index = state.cameras.indexOf(cam);
  const siblingHref = (step) => `#/camera/${state.cameras[(index + step + count) % count].id}`;
  const actions = count > 1 ? [
    h('a', { class: 'iconbtn', href: siblingHref(-1), 'aria-label': 'Previous camera' }, icon('chevron', 180)),
    h('a', { class: 'iconbtn', href: siblingHref(1), 'aria-label': 'Next camera' }, icon('chevron')),
  ] : [];
  root.append(topBar(cam.name, { back: '#/', actions }));

  const { stage, layer, feed } = createStage(cam, {
    interval: state.refreshMs / 8,
    reduced: state.quality === 'smooth',
    inView: true,
    maxInFlight: 3,
    showRate: true,
  });
  attachZoom(stage, layer);
  onLeave(() => feed.destroy());

  const quality = segmented('Picture quality', QUALITY_OPTIONS, state.quality, (value) => {
    state.quality = value;
    save();
    feed.reduced = value === 'smooth';
  });

  const viewer = h('main', { class: 'viewer' }, stage);
  viewer.append(cam.ptz
    ? ptzControls(cam, quality)
    : h('section', { class: 'controls' }, quality, h('p', { class: 'hint' }, 'Pinch or double-tap the picture to zoom.')));
  root.append(viewer);
}

function ptzControls(cam, quality) {
  let moving = false;

  const send = (op) => {
    ptz(cam, op, state.ptzSpeed).catch(() => toast('Couldn’t reach the camera.'));
  };
  const begin = (op) => {
    moving = true;
    send(op);
  };
  const end = () => {
    if (!moving) return;
    moving = false;
    send('Stop');
  };

  // Never leave a camera turning after the screen or page goes away.
  const stopIfHidden = () => { if (document.hidden) end(); };
  document.addEventListener('visibilitychange', stopIfHidden);
  window.addEventListener('pagehide', end);
  onLeave(() => {
    end();
    document.removeEventListener('visibilitychange', stopIfHidden);
    window.removeEventListener('pagehide', end);
  });

  const hold = (op, label, content) => {
    const button = h('button', { class: 'hold', type: 'button', 'aria-label': label }, content);
    holdable(button, () => begin(op), end);
    return button;
  };
  const arrow = (op, label, rotation) => hold(op, label, icon('chevron', rotation));

  return h('section', { class: 'controls', 'aria-label': 'Camera movement' },
    h('div', { class: 'ptz-row' },
      h('div', { class: 'pad' },
        arrow('LeftUp', 'Up left', 225),
        arrow('Up', 'Up', 270),
        arrow('RightUp', 'Up right', 315),
        arrow('Left', 'Left', 180),
        h('button', {
          class: 'hold stop',
          type: 'button',
          onclick: () => { moving = false; send('Stop'); },
        }, 'STOP'),
        arrow('Right', 'Right', 0),
        arrow('LeftDown', 'Down left', 135),
        arrow('Down', 'Down', 90),
        arrow('RightDown', 'Down right', 45)),
      h('div', { class: 'zoom-col' },
        hold('ZoomInc', 'Zoom in', icon('plus')),
        hold('ZoomDec', 'Zoom out', icon('minus')))),
    segmented('Movement speed', SPEED_OPTIONS, state.ptzSpeed, (value) => {
      state.ptzSpeed = value;
      save();
    }),
    quality,
    h('p', { class: 'hint' }, 'Hold an arrow to move. Release to stop.'));
}

function holdable(button, onStart, onEnd) {
  let active = false;
  const start = () => {
    if (active) return;
    active = true;
    button.classList.add('held');
    navigator.vibrate?.(10);
    onStart();
  };
  const finish = () => {
    if (!active) return;
    active = false;
    button.classList.remove('held');
    onEnd();
  };

  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    start();
  });
  button.addEventListener('pointerup', finish);
  button.addEventListener('pointercancel', finish);
  button.addEventListener('lostpointercapture', finish);
  button.addEventListener('contextmenu', (event) => event.preventDefault());
  button.addEventListener('keydown', (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      start();
    }
  });
  button.addEventListener('keyup', finish);
  button.addEventListener('blur', finish);
}

function attachZoom(stage, layer) {
  const MAX_SCALE = 6;
  const pointers = new Map();
  let scale = 1;
  let x = 0;
  let y = 0;
  let pinch = null;
  let lastTap = 0;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const apply = () => {
    const limitX = ((scale - 1) / 2) * stage.clientWidth;
    const limitY = ((scale - 1) / 2) * stage.clientHeight;
    x = clamp(x, -limitX, limitX);
    y = clamp(y, -limitY, limitY);
    layer.style.transform = scale === 1 ? '' : `translate(${x}px, ${y}px) scale(${scale})`;
    stage.classList.toggle('zoomed', scale > 1);
  };
  const distance = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  stage.addEventListener('pointerdown', (event) => {
    if (event.target.closest('a, button')) return;
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      pinch = { distance: distance(), scale };
    } else if (pointers.size === 1) {
      const now = performance.now();
      if (now - lastTap < 300) {
        scale = scale > 1 ? 1 : 2.5;
        x = 0;
        y = 0;
        apply();
        lastTap = 0;
      } else {
        lastTap = now;
      }
    }
  });

  stage.addEventListener('pointermove', (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const current = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, current);
    if (pinch && pointers.size === 2) {
      scale = clamp((pinch.scale * distance()) / pinch.distance, 1, MAX_SCALE);
      apply();
    } else if (pointers.size === 1 && scale > 1) {
      x += current.x - previous.x;
      y += current.y - previous.y;
      apply();
    }
  });

  const release = (event) => {
    pointers.delete(event.pointerId);
    pinch = null;
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    scale = clamp(scale * Math.exp(-event.deltaY / 400), 1, MAX_SCALE);
    apply();
  }, { passive: false });
}

/* Settings */

function viewSettings() {
  root.append(topBar('Settings', { back: '#/' }));

  const cameraRows = state.cameras.map((cam) => h('a', { class: 'list-row', href: `#/settings/${cam.id}` },
    h('div', { class: 'main' },
      h('div', { class: 'title' }, cam.name),
      h('div', { class: 'sub' }, `${cam.address.replace(/^https:\/\//, '')} · channel ${cam.channel}`)),
    h('span', { class: 'chev' }, icon('chevron'))));

  root.append(h('main', { class: 'page' },
    h('section', { class: 'section' },
      h('h2', {}, 'Cameras'),
      cameraRows.length > 0 && h('div', { class: 'card' }, cameraRows),
      h('a', { class: 'btn primary block', href: '#/settings/new' }, 'Add a camera')),
    h('section', { class: 'section' },
      h('h2', {}, 'Refresh speed'),
      segmented('Refresh speed', REFRESH_OPTIONS.map(({ ms, label }) => ({ value: ms, label })), state.refreshMs, (value) => {
        state.refreshMs = value;
        save();
      }),
      h('p', { class: 'hint' }, 'Faster refreshes use more data and battery.')),
    h('section', { class: 'section' },
      h('h2', {}, 'This device'),
      h('label', { class: 'toggle' },
        h('input', {
          type: 'checkbox',
          checked: state.reduced,
          onchange: (event) => { state.reduced = event.target.checked; save(); },
        }),
        h('span', { class: 'main' }, 'Smaller pictures in the grid',
          h('span', { class: 'sub' }, 'Loads faster. Some cameras ignore this.'))),
      h('label', { class: 'toggle' },
        h('input', {
          type: 'checkbox',
          checked: getRemember(),
          onchange: (event) => setRemember(event.target.checked),
        }),
        h('span', { class: 'main' }, 'Remember cameras and logins',
          h('span', { class: 'sub' }, 'When off, they’re cleared when you close this tab.'))),
      h('button', {
        class: 'btn danger block',
        type: 'button',
        onclick: () => {
          if (confirm('Remove all cameras and logins from this device?')) {
            forgetAll();
            location.hash = '#/';
          }
        },
      }, 'Remove everything from this device'))));
}

function viewForm(id) {
  const existing = id ? findCamera(id) : null;
  if (id && !existing) {
    location.replace('#/settings');
    return;
  }

  root.append(topBar(existing ? 'Edit camera' : 'Add camera', { back: '#/settings' }));

  const field = (label, input, help) => {
    input.id = `field-${label.replace(/\W+/g, '-').toLowerCase()}`;
    return h('div', { class: 'field' },
      h('label', { htmlFor: input.id }, label),
      input.parentElement ?? input,
      help && h('div', { class: 'help' }, help));
  };

  const plain = { autocapitalize: 'none', autocorrect: false, spellcheck: false };
  const name = h('input', { type: 'text', value: existing?.name ?? '', required: true, maxLength: 40, autocomplete: 'off', placeholder: 'Driveway' });
  const address = h('input', { type: 'text', ...plain, inputMode: 'url', value: existing?.address.replace(/^https:\/\//, '') ?? '', required: true, autocomplete: 'off', placeholder: '192.168.1.50' });
  const username = h('input', { type: 'text', ...plain, value: existing?.username ?? 'admin', required: true, autocomplete: 'off' });
  const password = h('input', { type: 'password', value: existing?.password ?? '', autocomplete: 'new-password' });
  const channel = h('input', { type: 'number', inputMode: 'numeric', min: 0, max: 63, step: 1, value: existing?.channel ?? 0, required: true });
  const ptzBox = h('input', { type: 'checkbox', checked: existing?.ptz ?? false });

  const reveal = h('button', {
    type: 'button',
    onclick: () => {
      const show = password.type === 'password';
      password.type = show ? 'text' : 'password';
      reveal.textContent = show ? 'Hide' : 'Show';
    },
  }, 'Show');
  h('div', { class: 'password-wrap' }, password, reveal);

  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const testResult = h('div', { class: 'test-result', 'aria-live': 'polite' });

  const fail = (message) => {
    error.textContent = message;
    error.hidden = false;
    return null;
  };

  const readForm = () => {
    error.hidden = true;
    const origin = parseAddress(address.value);
    if (!origin) return fail('Enter just the camera address, such as 192.168.1.50 or 192.168.1.50:8443.');
    if (origin.startsWith('http:') && location.protocol === 'https:') {
      return fail('This page can only load cameras over https. Use the https address.');
    }
    if (!name.value.trim()) return fail('Give this camera a name.');
    if (!username.value.trim()) return fail('Enter the camera username.');
    const channelNumber = Number(channel.value);
    if (!Number.isInteger(channelNumber) || channelNumber < 0) return fail('Channel must be 0 or higher.');
    return {
      id: existing?.id ?? newId(),
      name: name.value.trim(),
      address: origin,
      username: username.value.trim(),
      password: password.value,
      channel: channelNumber,
      ptz: ptzBox.checked,
    };
  };

  let testRun = 0;
  const runTest = async () => {
    const cam = readForm();
    if (!cam) return;
    const run = ++testRun;
    testResult.className = 'test-result';
    testResult.replaceChildren('Testing…');
    try {
      const img = await loadSnapshot(cam);
      if (run !== testRun) return;
      img.alt = 'Picture from this camera';
      testResult.className = 'test-result ok';
      testResult.replaceChildren('Connected.', img);
    } catch {
      if (run !== testRun) return;
      testResult.className = 'test-result bad';
      testResult.replaceChildren(
        h('span', {}, 'Couldn’t load a picture. Accept the camera’s certificate, then test again. If it still fails, check the address, username and password.'),
        h('a', { class: 'btn', href: cam.address, target: '_blank', rel: 'noopener noreferrer' }, 'Open camera'),
      );
    }
  };
  onLeave(() => { testRun += 1; });

  const form = h('form', {
    class: 'page',
    novalidate: true,
    onsubmit: (event) => {
      event.preventDefault();
      const cam = readForm();
      if (!cam) return;
      if (!upsertCamera(cam)) toast('Couldn’t save on this device. It will last until you close this tab.');
      location.hash = '#/settings';
    },
  },
    field('Name', name),
    field('Address', address, 'The IP you use to open the camera. Add :port if it isn’t 443.'),
    field('Username', username, 'A view-only account is safest if you don’t need camera movement.'),
    field('Password', password),
    field('Channel', channel, 'Use 0 for a single camera. For an NVR, add one entry per channel, starting at 0.'),
    h('label', { class: 'toggle' },
      ptzBox,
      h('span', { class: 'main' }, 'This camera can pan or tilt',
        h('span', { class: 'sub' }, 'Shows movement controls.'))),
    error,
    h('div', { class: 'section' },
      h('button', { class: 'btn block', type: 'button', onclick: runTest }, 'Test connection'),
      testResult),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Save camera'),
    existing && h('button', {
      class: 'btn danger block',
      type: 'button',
      onclick: () => {
        if (confirm(`Remove ${existing.name}?`)) {
          deleteCamera(existing.id);
          location.hash = '#/settings';
        }
      },
    }, 'Remove camera'));

  root.append(form);
}

window.addEventListener('hashchange', route);
route();
