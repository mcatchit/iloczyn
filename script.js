// ============================================================
// Config & state
// ============================================================

const QUEUE_CAP = 10;
const CITY_CODES = ['WA', 'KR', 'EL', 'DW', 'GD', 'KT', 'PO', 'SK', 'ZS', 'LU'];

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
  activeDigits: 2,
  activeDigitsCap: 5,
  carsPerActiveDigit: 3,
  gameOver: false,
  dragging: false,
  startX: 0,
  currentX: 0,
  activeId: 0,
  carsCreated: 0,
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

function pickDigit(maxDigit) {
  const total = DIGIT_WEIGHT_ZERO + DIGIT_WEIGHT_ONE + DIGIT_WEIGHT_REST * (maxDigit - 1);
  let r = Math.random() * total;
  if ((r -= DIGIT_WEIGHT_ZERO) < 0) return 0;
  if ((r -= DIGIT_WEIGHT_ONE) < 0) return 1;
  return 2 + Math.floor(r / DIGIT_WEIGHT_REST);
}

// each active digit is drawn independently from that weighted range, so any
// repeat pattern can come up on its own — distinct permutations, a single pair,
// triples like 33325, non-adjacent repeats like 23252, even 66666 on rare luck
function pickActiveDigits(count, maxDigit) {
  return Array.from({ length: count }, () => pickDigit(maxDigit));
}

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
  state.activeDigits = Math.min(state.activeDigitsCap, 2 + Math.floor(state.processed / state.carsPerActiveDigit));
}

// ============================================================
// Car queue
// ============================================================

function createCar() {
  state.carsCreated++;
  // the very first car of a game is a single-digit warm-up, however many are
  // already buffered ahead of it in the queue when this fires
  const activeDigits = state.carsCreated === 1 ? 1 : state.activeDigits;
  return {
    id: ++state.activeId,
    plate: makeNumber(activeDigits),
    cityCode: CITY_CODES[randInt(0, CITY_CODES.length - 1)],
    entering: true,
  };
}

function plateText(car) {
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
  capacityEl.innerHTML = Array.from({ length: QUEUE_CAP }, (_, i) => {
    const filled = i < total;
    const warn = filled && total >= QUEUE_CAP - 2;
    return `<div class="cap-seg${filled ? ' filled' : ''}${warn ? ' warn' : ''}"></div>`;
  }).join('');
}

function renderActive() {
  checkpoint.innerHTML = '';
  if (!state.active) return;

  const wrap = document.createElement('div');
  wrap.className = 'car-wrap';
  wrap.id = 'activeCar';
  wrap.innerHTML = `<div class="car">
    <img class="car-img" src="car.svg" alt="" draggable="false">
    <div class="plate"><div class="plate-eu"><div class="eu-stars"></div><div class="eu-code">PL</div></div><div class="plate-number">${plateText(state.active)}</div></div>
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
  state.activeDigits = 2;
  state.carsCreated = 0;
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
  return 6000 + (state.maxDigit - 3) * 300;
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
