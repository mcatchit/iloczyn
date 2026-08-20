// ============================================================
// Config & state
// ============================================================

const QUEUE_CAP = 10;
const CITY_CODES = ['WA', 'KR', 'EL', 'DW', 'GD', 'KT', 'PO', 'SK', 'ZS', 'LU'];

// Belarusian plates show up as an occasional variant among the Polish ones
const BY_PLATE_CHANCE = 0.1;
// real plates only use letters shared by the Belarusian Cyrillic and Latin
// alphabets — no M or Y, unlike the Russian road-alphabet set
const BY_LETTER_CHARS = ['A', 'B', 'C', 'E', 'H', 'I', 'K', 'O', 'P', 'T', 'X'];
// index i => region (i+1); region 3 is weighted well above the rest
const BY_REGION_WEIGHTS = [1, 1, 5, 1, 1, 1, 1, 1];

const state = {
  score: 0,
  processed: 0,
  streak: 0,
  queue: [],
  active: null,
  rule: null,
  lives: 3,
  maxLives: 3,
  maxDigit: 3,
  maxDigitCap: 9,
  carsPerDigit: 4,
  activeDigits: 3,
  activeDigitsCap: 5,
  carsPerActiveDigit: 3,
  gameOver: false,
  dragging: false,
  startX: 0,
  currentX: 0,
  activeId: 0,
  carsCreated: 0,
  lastPlateText: null,
};

// ============================================================
// DOM references
// ============================================================

const $ = id => document.getElementById(id);

const scoreEl = $('score');
const processedEl = $('processed');
const processedLabelEl = $('processedLabel');
const ruleEl = $('rule');
const checkpoint = $('checkpoint');
const queueEl = $('queue');
const toast = $('toast');
const leftMark = $('leftMark');
const rightMark = $('rightMark');
const livesEl = $('lives');
const capacityEl = $('capacity');

// ============================================================
// Formatting helpers
// ============================================================

function carWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'машина';
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 'машины';
  return 'машин';
}

function updateHUD() {
  scoreEl.textContent = state.score;
  processedEl.textContent = state.processed;
  processedLabelEl.textContent = carWord(state.processed);
}

// ============================================================
// Lives
// ============================================================

const HEART_PATH = 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';

function renderLives() {
  livesEl.innerHTML = Array.from({ length: state.maxLives }, (_, i) =>
    `<svg class="heart${i >= state.lives ? ' lost' : ''}" viewBox="0 0 24 24"><path d="${HEART_PATH}"/></svg>`
  ).join('');
}

// ============================================================
// Random helpers
// ============================================================

function randInt(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isPrime(n) {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let i = 3; i * i <= n; i += 2) if (n % i === 0) return false;
  return true;
}

// ============================================================
// Plate number generation
// ============================================================

// active-digit weights: 0 and 1 are real outcomes, just uncommon ones, rather
// than being excluded from the pool entirely — 0 is very rare since a stray
// zero collapses the whole product (23011 → 0), 1 is a step more common than
// that but still well below 2..maxDigit, since multiplying by 1 does nothing
const DIGIT_WEIGHT_ZERO = 1;
const DIGIT_WEIGHT_ONE = 4;
const DIGIT_WEIGHT_REST = 10;

// even past the opening plates (see ACTIVE_DIGITS_WARMUP_CARS below), 0s and 1s
// landing in the active slots make the product trivial (1×2). Throttle both
// weights toward zero for the first WARMUP_CARS processed, then ramp back up
// to the normal design weights above.
const WARMUP_CARS = 10;

function pickDigit(maxDigit) {
  const warmup = Math.min(1, state.processed / WARMUP_CARS);
  const zeroWeight = DIGIT_WEIGHT_ZERO * warmup;
  const oneWeight = DIGIT_WEIGHT_ONE * (0.25 + 0.75 * warmup);
  const total = zeroWeight + oneWeight + DIGIT_WEIGHT_REST * (maxDigit - 1);
  let r = Math.random() * total;
  if ((r -= zeroWeight) < 0) return 0;
  if ((r -= oneWeight) < 0) return 1;
  return 2 + Math.floor(r / DIGIT_WEIGHT_REST);
}

// each active digit is drawn independently from that weighted range, but retries
// a few times against digits already picked — plain repeats like 21112 (2×2) or
// 11113 (1×1) are trivial to multiply and got common enough to feel repetitive,
// so this pushes toward distinct values (23252, 33625) while still leaving rarer
// patterns like 33325 or 66666 possible once the retry budget runs out
function pickActiveDigits(count, maxDigit) {
  const values = [];
  for (let i = 0; i < count; i++) {
    let v, guard = 0;
    do { v = pickDigit(maxDigit); } while (values.includes(v) && guard++ < 3);
    values.push(v);
  }
  return values;
}

// after the single-digit opener (car 1), this many plates get exactly 2 active
// digits — a plain a×b multiplication like 12211 — before the count jumps
// straight to 3 and stays there. Without this cap the a×b pattern kept showing
// up for the first several plates, since activeDigits only climbs on processed
// successes and a couple of easy plates were already queued up before that
// caught up.
const ACTIVE_DIGITS_WARMUP_CARS = 2;

// difficulty comes from how many digits force a real multiplication step, not
// from the final product size — 92111 (one active digit) is a single 9×2 no
// matter how big the 9 is, while 24631 (four active digits) needs several
// chained steps. activeDigits sets the count of non-trivial slots; the rest
// are filler 1s, same as any other slot landing on a 1.
function makeNumber(activeDigits) {
  const activeSlots = new Set(shuffle([0, 1, 2, 3, 4]).slice(0, activeDigits));
  const activeValues = pickActiveDigits(activeDigits, state.maxDigit);

  let nextActive = 0;
  const digits = [];
  for (let i = 0; i < 5; i++) {
    digits.push(activeSlots.has(i) ? activeValues[nextActive++] : 1);
  }
  return digits.join('');
}

function pickByLetters() {
  return BY_LETTER_CHARS[randInt(0, BY_LETTER_CHARS.length - 1)] + BY_LETTER_CHARS[randInt(0, BY_LETTER_CHARS.length - 1)];
}

function pickByRegion() {
  const total = BY_REGION_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < BY_REGION_WEIGHTS.length; i++) {
    if ((r -= BY_REGION_WEIGHTS[i]) < 0) return i + 1;
  }
  return BY_REGION_WEIGHTS.length;
}

// Belarusian plates: 4-digit number + 2 letters + a region digit (1-8). Unlike
// Polish plates there are no filler 1s here — all 5 digits (the 4-digit number
// plus the region) are real values that go into the product, so a BY plate is
// always a full 5-digit multiplication regardless of the current activeDigits ramp.
function makeByPlate() {
  const digits = pickActiveDigits(4, state.maxDigit);
  const region = pickByRegion();
  return { plate: [...digits, region].join(''), letters: pickByLetters() };
}

function product(digits) {
  return [...digits].reduce((acc, d) => acc * Number(d), 1);
}

// ============================================================
// Rule generation & matching
// ============================================================

function pickInRange(lo, hi, exclude) {
  lo = Math.max(1, Math.round(lo));
  hi = Math.max(lo, Math.round(hi));
  let v, guard = 0;
  do { v = randInt(lo, hi); } while (v === exclude && guard++ < 10);
  return v;
}

// '=' targets skip primes: unreachably large ones (11, 13, 17...) can never be hit by a
// digit product, and reachable ones (7) are only hit by one narrow digit pattern
function pickEqualsTarget(lo, hi, exact) {
  lo = Math.max(1, Math.round(lo));
  hi = Math.max(lo, Math.round(hi));
  if (exact !== null && !isPrime(exact) && Math.random() < 0.5) return exact;
  let v, guard = 0;
  do { v = randInt(lo, hi); guard++; } while ((v === exact || isPrime(v)) && guard < 30);
  return v;
}

function makeRule(targetProduct) {
  const typePool = ['>', '<', '='];
  const type = typePool[randInt(0, typePool.length - 1)];

  if (targetProduct === 0) {
    // a proportional range collapses to zero when the actual product is 0, so fall back
    // to a small absolute range instead
    const fallbackHi = Math.max(6, state.maxDigit * 6);
    const target = type === '=' ? pickEqualsTarget(1, fallbackHi, null) : randInt(1, fallbackHi);
    return { type, target, text: `${type} ${target}` };
  }

  const lo = targetProduct * 0.75;
  const hi = targetProduct * 1.5;
  if (type === '=') {
    const target = pickEqualsTarget(lo, hi, targetProduct);
    return { type, target, text: `= ${target}` };
  }
  const target = pickInRange(lo, hi, targetProduct);
  return { type, target, text: `${type} ${target}` };
}

function matches(digits, rule) {
  const actual = product(digits);
  if (rule.type === '>') return actual > rule.target;
  if (rule.type === '<') return actual < rule.target;
  return actual === rule.target;
}

function chooseRule(car) {
  const rule = makeRule(product(car.plate));
  state.rule = rule;
  ruleEl.textContent = rule.text;
}

function updateProgression() {
  state.maxDigit = Math.min(state.maxDigitCap, 3 + Math.floor(state.processed / state.carsPerDigit));
  // floor of 3 (not 2) once past the opening plates — see ACTIVE_DIGITS_WARMUP_CARS
  // in createCar, which is what actually gates the easy 2-digit plates
  state.activeDigits = Math.min(state.activeDigitsCap, 3 + Math.floor(state.processed / state.carsPerActiveDigit));
}

// ============================================================
// Car queue
// ============================================================

function rollCar() {
  // car 1 is a single-digit warm-up, the next ACTIVE_DIGITS_WARMUP_CARS are a
  // plain 2-digit multiplication, gated on carsCreated (not the processed-driven
  // state.activeDigits) so it's exactly this many plates no matter how the queue
  // is buffered ahead of it when this fires
  const pastWarmup = state.carsCreated > 1 + ACTIVE_DIGITS_WARMUP_CARS;

  // BY plates always multiply all 5 digits, so they'd blow past the easy
  // opening window — only roll for one once the PL ramp is past it too
  if (pastWarmup && Math.random() < BY_PLATE_CHANCE) {
    const by = makeByPlate();
    return { plate: by.plate, byLetters: by.letters, country: 'BY', entering: true };
  }

  const activeDigits = state.carsCreated === 1 ? 1 : pastWarmup ? state.activeDigits : 2;
  return {
    plate: makeNumber(activeDigits),
    cityCode: CITY_CODES[randInt(0, CITY_CODES.length - 1)],
    country: 'PL',
    entering: true,
  };
}

function createCar() {
  state.carsCreated++;

  // the early digit pool is narrow (activeDigits=2, maxDigit=3), so two
  // independent rolls land on the same-looking plate often enough to notice —
  // retry a few times rather than show the same plate twice in a row
  let car = rollCar();
  let guard = 0;
  while (plateText(car) === state.lastPlateText && guard++ < 5) {
    car = rollCar();
  }
  state.lastPlateText = plateText(car);

  car.id = ++state.activeId;
  return car;
}

function plateText(car) {
  if (car.country === 'BY') {
    return `${car.plate.slice(0, 4)} ${car.byLetters}-${car.plate.slice(4)}`;
  }
  return `${car.cityCode} ${car.plate}`;
}

function renderQueue() {
  queueEl.innerHTML = '';
  for (let i = 0; i < Math.min(state.queue.length, QUEUE_CAP); i++) {
    const el = document.createElement('div');
    el.className = 'qcar';
    el.innerHTML = '<img src="queue_car.svg" alt="" draggable="false">';
    queueEl.appendChild(el);
  }
  renderCapacity();
}

function renderCapacity() {
  const total = Math.min(QUEUE_CAP, state.queue.length);
  const danger = total >= QUEUE_CAP - 2;
  capacityEl.innerHTML = Array.from({ length: QUEUE_CAP }, (_, i) => {
    const filled = i < total;
    return `<div class="cap-seg${filled ? ' filled' : ''}${danger ? ' warn' : ''}"></div>`;
  }).join('');
}

// five-pointed star polygon, points computed rather than hand-typed so the
// EU ring below stays exact
function starPolygon(cx, cy, outerR, innerR) {
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const angle = (-90 + k * 36) * Math.PI / 180;
    const r = k % 2 === 0 ? outerR : innerR;
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`);
  }
  return pts.join(' ');
}

// the real EU band: 12 gold stars evenly spaced around a ring, each point-up
const EU_STARS = Array.from({ length: 12 }, (_, i) => {
  const angle = i * 30 * Math.PI / 180;
  const cx = 10 + 6.4 * Math.sin(angle);
  const cy = 10 - 6.4 * Math.cos(angle);
  return `<polygon points="${starPolygon(cx, cy, 1.7, 0.65)}" fill="#FC0"/>`;
}).join('');
const EU_EMBLEM_SVG = `<svg class="badge-flag" viewBox="0 0 20 20" aria-hidden="true">${EU_STARS}</svg>`;

// Belarusian flag: red over green (2:1), plus the ornament stripe at the hoist,
// simplified to a repeating row of small diamonds rather than the full weave
const BY_ORNAMENT = Array.from({ length: 5 }, (_, i) => {
  const cy = 0.22 + i * 0.4;
  return `<rect x="0.09" y="${(cy - 0.09).toFixed(2)}" width="0.18" height="0.18" fill="#C8102E" transform="rotate(45 0.18 ${cy.toFixed(2)})"/>`;
}).join('');
const BY_FLAG_SVG = `<svg class="badge-flag" viewBox="0 0 3 2" aria-hidden="true">
  <rect width="3" height="2" fill="#C8102E"/>
  <rect y="1.333" width="3" height="0.667" fill="#4AA657"/>
  <rect width="0.36" height="2" fill="#fff"/>
  ${BY_ORNAMENT}
</svg>`;

function renderActive() {
  checkpoint.innerHTML = '';
  if (!state.active) return;

  const wrap = document.createElement('div');
  wrap.className = 'car-wrap';
  wrap.id = 'activeCar';
  const isBy = state.active.country === 'BY';
  const badge = isBy
    ? `<div class="plate-badge by">${BY_FLAG_SVG}<div class="badge-code">BY</div></div>`
    : `<div class="plate-badge eu">${EU_EMBLEM_SVG}<div class="badge-code">PL</div></div>`;
  wrap.innerHTML = `<div class="car">
    <img class="car-img" src="car.svg" alt="" draggable="false">
    <div class="plate">${badge}<div class="plate-number">${plateText(state.active)}</div></div>
  </div>`;
  checkpoint.appendChild(wrap);
  attachSwipe(wrap);

  if (state.active.entering) {
    wrap.style.transform = 'translateX(-150px) scale(.92)';
    requestAnimationFrame(() => {
      wrap.style.transition = 'transform .55s cubic-bezier(.2,.8,.2,1)';
      wrap.style.transform = 'translateX(0) scale(1)';
    });
    state.active.entering = false;
  }
}

function activateNext() {
  if (state.gameOver) return;
  if (state.active || state.queue.length === 0) return;

  state.active = state.queue.shift();
  renderQueue();
  chooseRule(state.active);
  renderActive();

  if (state.queue.length === 0) enqueue();
}

function enqueue() {
  if (state.gameOver) return;
  if (state.queue.length + (state.active ? 1 : 0) >= QUEUE_CAP) {
    endGame('queue');
    return;
  }
  state.queue.push(createCar());
  renderQueue();
  activateNext();
}

// ============================================================
// Swipe / verdict handling
// ============================================================

function showToast(text, miss) {
  toast.textContent = text;
  toast.classList.toggle('miss', !!miss);
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 900);
}

function finishSwipe(dir) {
  if (!state.active || state.gameOver) return;

  const car = state.active;
  const shouldPass = matches(car.plate, state.rule);
  const correct = (dir === 'right') === shouldPass;

  const wrap = $('activeCar');
  if (!wrap) return;
  wrap.style.transition = 'transform .35s cubic-bezier(.2,.8,.2,1),opacity .25s';
  wrap.style.transform = `translateX(${dir === 'right' ? '130' : '-130'}vw) rotate(${dir === 'right' ? '8' : '-8'}deg)`;
  wrap.style.opacity = '0';

  if (correct) {
    state.processed++;
    state.streak++;
    const streakTier = state.streak % 5 === 0 ? state.streak / 5 : 0;
    const gain = 1 + streakTier;
    state.score += gain;
    showToast(streakTier ? `серия +${gain}` : '+1');
    state.active = null;
    updateProgression();
    updateHUD();
    renderCapacity();
    setTimeout(() => activateNext(), 260);
  } else {
    state.streak = 0;
    state.lives--;
    renderLives();
    showToast('упс...', true);
    state.active = null;
    renderCapacity();
    setTimeout(() => {
      if (state.lives <= 0) { endGame('lives'); return; }
      activateNext();
    }, 330);
  }
}

function setSideActive(dir) {
  leftMark.classList.toggle('active', dir === 'left');
  rightMark.classList.toggle('active', dir === 'right');
}

leftMark.addEventListener('click', () => finishSwipe('left'));
rightMark.addEventListener('click', () => finishSwipe('right'));

function attachSwipe(wrap) {
  let pointerId = null;

  wrap.addEventListener('pointerdown', e => {
    pointerId = e.pointerId;
    state.dragging = true;
    state.startX = e.clientX;
    state.currentX = e.clientX;
    wrap.setPointerCapture(pointerId);
    wrap.classList.add('dragging');
  });

  wrap.addEventListener('pointermove', e => {
    if (pointerId !== e.pointerId || !state.dragging) return;
    state.currentX = e.clientX;
    const dx = state.currentX - state.startX;
    wrap.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
    setSideActive(Math.abs(dx) < 20 ? null : (dx > 0 ? 'right' : 'left'));
  });

  const end = e => {
    if (pointerId !== e.pointerId || !state.dragging) return;
    state.dragging = false;
    wrap.classList.remove('dragging');
    const dx = state.currentX - state.startX;
    pointerId = null;
    setSideActive(null);
    if (Math.abs(dx) < 60) {
      wrap.style.transition = 'transform .18s';
      wrap.style.transform = 'translateX(0) rotate(0)';
      return;
    }
    finishSwipe(dx > 0 ? 'right' : 'left');
  };

  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
}

// ============================================================
// Best score persistence
// ============================================================

function loadBest() {
  try {
    const v = JSON.parse(localStorage.getItem('checkpointBest'));
    if (v && Number.isFinite(v.score) && Number.isFinite(v.processed)) return v;
  } catch (e) {}
  // fall back to the old score-only record format
  const legacy = Number(localStorage.getItem('checkpointBestScore'));
  return { score: Number.isFinite(legacy) ? legacy : 0, processed: 0 };
}

// ============================================================
// Game flow
// ============================================================

function endGame(reason) {
  state.gameOver = true;

  let best = loadBest();
  if (state.score > best.score) best = { score: state.score, processed: state.processed };
  localStorage.setItem('checkpointBest', JSON.stringify(best));

  const reasonEl = $('gameoverReason');
  reasonEl.textContent = reason === 'queue' ? 'очередь переполнена' : '';
  reasonEl.classList.toggle('show', reason === 'queue');

  $('finalScore').textContent = state.score;
  $('finalProcessed').textContent = `${state.processed} ${carWord(state.processed)}`;
  $('bestScore').textContent = `рекорд: ${best.score} · ${best.processed} ${carWord(best.processed)}`;
  $('gameover').classList.add('show');
}

function goToStart() {
  $('gameover').classList.remove('show');
  $('start').classList.remove('hide');
}

function stopGame() {
  if (state.gameOver) return;
  state.gameOver = true;

  let best = loadBest();
  if (state.score > best.score) best = { score: state.score, processed: state.processed };
  localStorage.setItem('checkpointBest', JSON.stringify(best));

  goToStart();
}

$('cancelBtn').addEventListener('click', stopGame);
$('toStart').addEventListener('click', goToStart);

function reset() {
  state.score = 0;
  state.processed = 0;
  state.streak = 0;
  state.queue = [];
  state.active = null;
  state.gameOver = false;
  state.maxDigit = 3;
  state.activeDigits = 3;
  state.carsCreated = 0;
  state.lastPlateText = null;
  state.rule = null;
  state.lives = state.maxLives;
  spawnTimer = 0;

  $('gameover').classList.remove('show');
  updateHUD();
  renderLives();
  enqueue();
}

$('restart').addEventListener('click', reset);

// ============================================================
// Game loop
// ============================================================

let last = performance.now();
let spawnTimer = 0;

function spawnInterval() {
  return 5000 + (state.maxDigit - 3) * 300;
}

function loop(now) {
  // clamp dt so a backgrounded/paused tab (rAF stalls while hidden) can't
  // dump a huge elapsed time into spawnTimer in one frame
  const dt = Math.min(now - last, 250);
  last = now;

  if (!state.gameOver) {
    spawnTimer += dt;
    const interval = spawnInterval();
    if (spawnTimer >= interval) {
      spawnTimer -= interval;
      enqueue();
    }
  }
  requestAnimationFrame(loop);
}

// ============================================================
// Bootstrap
// ============================================================

renderLives();
updateHUD();

let loopRunning = false;

$('startBtn').addEventListener('click', () => {
  $('start').classList.add('hide');
  reset();
  if (!loopRunning) {
    loopRunning = true;
    last = performance.now();
    spawnTimer = 0;
    requestAnimationFrame(loop);
  }
});
