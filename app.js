'use strict';
/* Семейные траты — мини-приложение Telegram «Наличные».
 * Данные идут в Apps Script таблицы; подпись Telegram проверяет сервер. Демо без Telegram: ?demo=1 */

// Адрес скрипта таблицы не хранится в репозитории: приходит в ссылке мини-приложения (?api=<id развёртывания>)
const API_ID = (new URLSearchParams(location.search).get('api') || '').trim();
const API = /^[A-Za-z0-9_-]{20,120}$/.test(API_ID) ? 'https://script.google.com/macros/s/' + API_ID + '/exec' : '';

const CAT_META = {
  'Продукты': ['🛒', 'Продукты'], 'Кафе и рестораны': ['☕', 'Кафе'], 'Транспорт и такси': ['🚕', 'Такси'],
  'Дом и быт': ['🏠', 'Дом'], 'Здоровье и аптека': ['💊', 'Аптека'], 'Красота': ['💅', 'Красота'],
  'Одежда и обувь': ['👗', 'Одежда'], 'Подарки': ['🎁', 'Подарки'], 'Развлечения и отдых': ['🎉', 'Отдых'],
  'Подписки и связь': ['📱', 'Связь'], 'ЖКХ': ['💡', 'ЖКХ'], 'Аренда': ['🔑', 'Аренда'],
  'Рассрочка': ['📆', 'Рассрочка'], 'Налоги': ['🧾', 'Налоги'], 'Переводы': ['💸', 'Переводы'], 'Другое': ['✨', 'Другое']
};
// базовый порядок; поверх него — частота трат из таблицы (catRank с сервера)
const BASE_CATS = ['Продукты', 'Кафе и рестораны', 'Здоровье и аптека', 'Транспорт и такси', 'Дом и быт', 'Одежда и обувь', 'Другое'];
function topCats() {
  const rank = (state.data && state.data.catRank) || [];
  const out = [];
  const NOT_CASH = ['Подписки и связь', 'Рассрочка', 'Налоги'];   // наличными не платят — в «Ещё»
  rank.concat(BASE_CATS).forEach((c) => { if (CAT_META[c] && NOT_CASH.indexOf(c) < 0 && out.indexOf(c) < 0 && out.length < 7) out.push(c); });
  return out;
}

const tg = window.Telegram && window.Telegram.WebApp;
const DEMO = new URLSearchParams(location.search).has('demo');
const initData = tg && tg.initData ? tg.initData : '';

const $ = (id) => document.getElementById(id);
const state = { mode: 'spend', amount: '', cat: 'Продукты', day: 'today', data: null, busy: false, reqId: null, lastAdded: null };

/* ---------- сервер ---------- */
async function api(body) {
  if (DEMO) return demoApi(body);
  if (!API) throw new Error('no_api');
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // простой запрос, без preflight
    body: JSON.stringify(Object.assign({ initData }, body)),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('http_' + res.status);
  return res.json();
}

/* ---------- экраны ---------- */
function show(id) {
  const splash = $('scr-loading');
  // заставка уходит плавно, а не пропадает рывком
  if (id !== 'scr-loading' && !splash.hidden && !splash.classList.contains('out')) {
    splash.classList.add('out');
    setTimeout(() => { splash.hidden = true; splash.classList.remove('out'); show(id); }, 330);
    return;
  }
  document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== id; });
  updateMainButton();
}

function haptic(kind) {
  try {
    if (!tg || !tg.HapticFeedback) return;
    if (kind === 'tap') tg.HapticFeedback.selectionChanged();
    else if (kind === 'ok') tg.HapticFeedback.notificationOccurred('success');
    else if (kind === 'err') tg.HapticFeedback.notificationOccurred('error');
    else tg.HapticFeedback.impactOccurred('light');
  } catch (e) { /* старый клиент */ }
}

let toastTimer;
function toast(text, isErr) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('err', !!isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

const ERRORS = {
  bad_auth: 'Не удалось проверить вход. Закройте и откройте приложение заново.',
  old_auth: 'Сессия устарела. Закройте и откройте приложение заново.',
  no_token: 'Бот ещё не настроен. Напишите Андрею.',
  no_invite: 'Нужна ссылка-приглашение от Андрея.',
  full: 'Уже подключено максимум людей.',
  bad_amount: 'Проверьте сумму.',
  no_api: 'Ссылка на приложение неполная. Напишите Андрею.',
  undo_expired: 'Отменить уже нельзя — прошло больше 10 минут. Напишите Андрею.'
};
function errText(e) { return ERRORS[e] || 'Нет связи с таблицей. Проверьте интернет и нажмите ещё раз.'; }

/* ---------- загрузка ---------- */
/* Последние остатки хранятся на телефоне: экран показывается сразу, свежие данные — в фоне */
const CACHE_KEY = 'state_v1';
function saveCache(d) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) { /* нет места */ } }
function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; } }

async function load() {
  const cached = DEMO ? null : readCache();
  if (cached && cached.registered) {
    state.data = cached;
    renderMain();
    show('scr-main');
    document.body.classList.add('stale');
  } else {
    show('scr-loading');
  }
  try {
    const d = await api({ action: 'state' });
    if (!d.ok) { if (!cached) fail(errText(d.error)); else toast(errText(d.error), true); return; }
    if (!d.registered) { localStorage.removeItem(CACHE_KEY); return d.canJoin ? showJoin(d.names) : show('scr-noinvite'); }
    state.data = d;
    saveCache(d);
    if ($('scr-main').hidden) { renderMain(); show('scr-main'); }
    else refreshMain();
  } catch (e) {
    if (cached) toast('Нет связи — показаны последние остатки', true);
    else fail(errText(e && e.message));
  } finally {
    document.body.classList.remove('stale');
  }
}

/* обновить цифры, не сбивая набранную сумму и выбранную категорию */
function refreshMain() {
  const d = state.data;
  $('bal-cash').textContent = d.cash;
  $('bal-perday').textContent = d.perDay;
  $('bal-card').textContent = d.card;
  renderCats();
  renderRecent();
  renderAmount();
}

function fail(text) {
  $('err-text').textContent = text;
  show('scr-error');
}

function showJoin(names) {
  const box = $('join-buttons');
  box.replaceChildren();
  names.forEach((n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-primary';
    b.textContent = n;
    b.addEventListener('click', () => join(n, b));
    box.appendChild(b);
  });
  show('scr-join');
}

async function join(name, btn) {
  btn.disabled = true;
  haptic('tap');
  // разрешить боту писать (остатки и уведомления); отказ не мешает вносить траты
  if (tg && tg.requestWriteAccess) {
    try { await new Promise((ok) => tg.requestWriteAccess(() => ok())); } catch (e) { /* нет поддержки */ }
  }
  try {
    const d = await api({ action: 'register', name });
    if (!d.ok) { btn.disabled = false; return toast(errText(d.error), true); }
    state.data = d;
    saveCache(d);
    renderMain();
    show('scr-main');
    toast('Готово! Теперь можно вносить наличные 👛');
  } catch (e) {
    btn.disabled = false;
    toast(errText(), true);
  }
}

/* ---------- главный экран ---------- */
function renderMain() {
  const d = state.data;
  $('bal-cash').textContent = d.cash;
  $('bal-perday').textContent = d.perDay;
  $('bal-card').textContent = d.card;
  renderCats();
  renderRecent();
  renderAmount();
}

function catButton(cat, cls) {
  const [e, label] = CAT_META[cat] || ['✨', cat];
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls + (cat === state.cat ? ' on' : '');
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', String(cat === state.cat));
  const em = document.createElement('span'); em.className = 'e'; em.textContent = e;
  const tx = document.createElement('span'); tx.textContent = label;
  b.append(em, tx);
  return b;
}

function renderCats() {
  const box = $('cats');
  box.replaceChildren();
  // 7 частых + выбранная редкая (если не из частых) + «Ещё»
  const list = topCats();
  if (list.indexOf(state.cat) < 0) list[list.length - 1] = state.cat;
  list.forEach((c) => {
    const b = catButton(c, 'cat');
    b.addEventListener('click', () => pickCat(c));
    box.appendChild(b);
  });
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'cat';
  const em = document.createElement('span'); em.className = 'e'; em.textContent = '•••';
  const tx = document.createElement('span'); tx.textContent = 'Ещё';
  more.append(em, tx);
  more.addEventListener('click', openSheet);
  box.appendChild(more);
}

function pickCat(c) {
  state.cat = c;
  haptic('tap');
  renderCats();
  updateMainButton();
}

function openSheet() {
  haptic('tap');
  const box = $('sheet-cats');
  box.replaceChildren();
  ((state.data && state.data.cats) || Object.keys(CAT_META)).forEach((c) => {
    const b = catButton(c, 'cat');
    b.addEventListener('click', () => { pickCat(c); closeSheet(); });
    box.appendChild(b);
  });
  $('sheet').hidden = false;
  $('sheet-back').hidden = false;
  if (tg && tg.BackButton) tg.BackButton.show();
}
function closeSheet() {
  $('sheet').hidden = true;
  $('sheet-back').hidden = true;
  if (tg && tg.BackButton) tg.BackButton.hide();
}

function renderRecent() {
  const list = (state.data && state.data.recent) || [];
  $('recent-wrap').hidden = list.length === 0;
  const ul = $('recent');
  ul.replaceChildren();
  list.forEach((r) => {
    const li = document.createElement('li');
    const main = document.createElement('div'); main.className = 'r-main';
    const desc = document.createElement('div'); desc.className = 'r-desc';
    desc.textContent = (r.inc ? '💵' : ((CAT_META[r.cat] || ['✨'])[0])) + ' ' + (r.desc || r.cat);
    const meta = document.createElement('div'); meta.className = 'r-meta';
    meta.textContent = r.date.slice(0, 5) + ' · ' + r.who;
    main.append(desc, meta);
    const sum = document.createElement('div'); sum.className = 'r-sum' + (r.inc ? ' r-inc' : ''); sum.textContent = (r.inc ? '+' : '') + r.sum;
    li.append(main, sum);
    ul.appendChild(li);
  });
}

/* тёплые фразы для Юлии: каждый раз случайная, без повтора подряд */
const WARM = [
  ['💜 Спасибо, что бережёшь наш бюджет 💜', 'Тебя очень любят и ценят)'],
  ['✨ Ты у нас лучший финансист семьи!', 'Тебя очень любят и ценят)'],
  ['🌷 С тобой в семье всегда порядок', 'Спасибо тебе за заботу 💜'],
  ['☀️ Ты делаешь наш дом теплее', 'Тебя очень любят 💜'],
  ['🏡 Наш семейный бюджет в надёжных руках', 'Спасибо, родная)'],
  ['💜 Самая заботливая и самая любимая', 'Спасибо, что ты есть'],
  ['🌸 Умница и красавица — это про тебя', 'Тебя ценят и обожают)'],
  ['🍀 Пусть денег становится всё больше', 'А любви — ещё больше 💜'],
  ['⭐ Ты лучшая хозяйка на свете', 'Тебя очень любят)'],
  ['🌹 Спасибо за каждую мелочь, которую ты делаешь', 'Это очень ценят 💜'],
  ['💎 Ты наше главное богатство', 'Остальное — просто деньги)'],
  ['🧡 Рядом с тобой всё получается', 'Спасибо тебе за всё'],
  ['🌼 Ты — лучшее, что есть в этой таблице', 'И в жизни тоже 💜'],
  ['🎀 Каждый лари под твоим присмотром', 'Тебя любят и тобой гордятся)'],
  ['🌙 Спасибо за твою мудрость и терпение', 'Тебя очень ценят 💜']
];
function pickWarm() {
  let last = -1;
  try { last = Number(localStorage.getItem('warmLast')); } catch (e) { /* нет памяти */ }
  let i = Math.floor(Math.random() * WARM.length);
  if (i === last) i = (i + 1 + Math.floor(Math.random() * (WARM.length - 1))) % WARM.length;
  try { localStorage.setItem('warmLast', String(i)); } catch (e) { /* нет памяти */ }
  return WARM[i];
}

/* текст в режиме «Приход»: Юлии — тёплый, Андрею — только про банкомат */
function renderIncomeNote() {
  const box = $('income-note');
  const atm = 'Снятие в банкомате можно не вносить — оно уже само записано по SMS.';
  const lines = (state.data && state.data.name === 'Юлия') ? pickWarm().concat([atm]) : [atm];
  box.replaceChildren(...lines.map((t, i) => {
    const d = document.createElement('div');
    d.textContent = t;
    if (lines.length > 1 && i < 2) d.className = 'note-warm';
    return d;
  }));
}

function setMode(m) {
  state.mode = m;
  document.body.classList.toggle('income', m === 'income');
  document.querySelectorAll('.mode-btn').forEach((b) => {
    const on = b.dataset.mode === m;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  $('income-note').hidden = m !== 'income';
  if (m === 'income') renderIncomeNote();
  if (m === 'income') $('desc').value = '';   // у прихода описания нет
  renderAmount();
}

/* сумма: цифры, одна запятая, 2 знака после, без ведущих нулей */
function press(k) {
  let a = state.amount;
  if (k === 'del') a = a.slice(0, -1);
  else if (k === ',') { if (a.indexOf(',') >= 0) return bump(); a = (a || '0') + ','; }
  else {
    if (a.indexOf(',') >= 0 && a.split(',')[1].length >= 2) return bump();
    if (a.replace(',', '').length >= 7) return bump();
    a = (a === '0') ? k : a + k;
  }
  state.amount = a;
  haptic('tap');
  renderAmount();
}
function bump() {
  haptic('err');
  const el = $('amount');
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
}

function amountNum() { return Number((state.amount || '0').replace(',', '.')); }
function fmt(n) { const r = Math.round(n * 100) / 100; return (Number.isInteger(r) ? String(r) : r.toFixed(2)).replace('.', ','); }

function renderAmount() {
  const n = amountNum();
  $('amount-text').textContent = state.amount || '0';
  $('amount').classList.toggle('empty', !state.amount);
  const hint = $('amount-hint');
  hint.classList.remove('warn');
  hint.textContent = '';
  if (n > 0 && state.data && state.mode === 'income') {
    hint.textContent = 'Наличных станет ' + fmt((state.data.cashNum || 0) + n) + ' ₾';
    if (n >= 2000) { hint.textContent = 'Крупная сумма — проверьте, нет ли лишнего нуля'; hint.classList.add('warn'); }
  } else if (n > 0 && state.data) {
    const left = (state.data.cashNum || 0) - n;
    if (n >= 500) { hint.textContent = 'Крупная сумма — проверьте, нет ли лишнего нуля'; hint.classList.add('warn'); }
    else if (left < 0) { hint.textContent = 'По таблице наличных ' + state.data.cash + ' — можно записать, Андрей сверит'; hint.classList.add('warn'); }
    else hint.textContent = 'Останется ' + fmt(left) + ' ₾';
  }
  updateMainButton();
}

function saveLabel() {
  if (state.mode === 'income') return 'Добавить приход ' + (state.amount || '0') + ' ₾';
  const [e, label] = CAT_META[state.cat] || ['', state.cat];
  return 'Записать ' + (state.amount || '0') + ' ₾ · ' + label;
}

/* Сохранение: одна кнопка на странице (и нативная Telegram — если доступна) */
function updateMainButton() {
  const onMain = !$('scr-main').hidden && $('sheet').hidden;
  const ready = amountNum() > 0 && !state.busy;
  const btn = $('save');
  btn.disabled = !ready;
  btn.textContent = state.busy ? 'Записываю…' : (amountNum() > 0 ? saveLabel() : 'Введите сумму');
  if (!tg || !tg.MainButton || DEMO) return;
  // нативная кнопка Telegram дублирует нашу — прячем её, чтобы не было двух кнопок
  tg.MainButton.hide();
  if (!onMain) return;
}

/* ---------- анимация сохранения ---------- */
let busyStart = 0;
function startBusy(mode) {
  const box = $('busy'), coins = $('coins');
  coins.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const c = document.createElement('img');
    c.className = 'coin';
    c.src = 'coin.png';
    c.alt = '';
    const side = i % 2 ? 1 : -1;
    c.style.setProperty('--dx', (side * (25 + Math.random() * 75)).toFixed(0) + 'px');
    c.style.setProperty('--r', (side * (90 + Math.random() * 270)).toFixed(0) + 'deg');
    c.style.setProperty('--d', (i * 0.16).toFixed(2) + 's');
    coins.appendChild(c);
  }
  box.classList.toggle('income', mode === 'income');
  box.classList.remove('out');
  $('busy-text').textContent = mode === 'income' ? 'Кладу в кошелёк…' : 'Записываю…';
  box.hidden = false;
  busyStart = Date.now();
}
async function stopBusy() {
  const box = $('busy');
  if (box.hidden) return;
  const left = 1100 - (Date.now() - busyStart);          // анимацию видно хотя бы ~1 с
  if (left > 0) await new Promise((r) => setTimeout(r, left));
  box.classList.add('out');
  await new Promise((r) => setTimeout(r, 240));
  box.hidden = true;
  box.classList.remove('out');
}

async function save() {
  if (state.busy || !(amountNum() > 0)) return;
  state.busy = true;
  if (!state.reqId) state.reqId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  $('desc').blur();
  updateMainButton();
  haptic();
  startBusy(state.mode);
  try {
    const d = await api({ action: state.mode === 'income' ? 'income' : 'add', amount: state.amount, cat: state.cat, desc: $('desc').value.trim(), day: state.day, reqId: state.reqId });
    if (!d.ok) throw new Error(d.error || 'server');
    state.data = d;
    saveCache(d);
    state.lastAdded = d.added;
    state.reqId = null;
    await stopBusy();
    showDone(d);
  } catch (e) {
    await stopBusy();
    haptic('err');
    toast(errText(e && e.message), true);   // reqId сохраняется: повтор не создаст дубль
  } finally {
    state.busy = false;
    updateMainButton();
  }
}

/* награда после расхода: 30 фраз в духе «Страдающего Средневековья», за круг каждая по одному разу */
const JOKES = [
  ['📜 Летописец внёс сие в свиток.', 'Казна вздохнула, но держится.'],
  ['🏰 Казначей королевства одобрил.', 'Почти не плакал.'],
  ['🐌 Рыцарь опять проиграл улитке.', 'А у нас всё записано — победа!'],
  ['⚔️ Деньги ушли в крестовый поход.', 'Обещали вернуться с трофеями.'],
  ['🍞 Хлеб куплен, королевство спасено.', 'До ужина можно не воевать.'],
  ['👑 Её величество изволили потратить.', 'Летописец записал и никому не скажет.'],
  ['🕯️ Монах внёс трату в книгу расходов.', 'И пошёл молиться за бюджет.'],
  ['🐉 Дракон, стерегущий казну, всё видел.', 'Но промолчал. Он тоже любит вкусное.'],
  ['📯 Глашатаи разнесли весть по округе:', 'в доме снова есть продукты!'],
  ['🦁 Лев одобрительно кивнул.', 'Он тоже за полный холодильник.'],
  ['😭 Кошелёк немного пострадал.', 'Ничего, в Средневековье страдали больше.'],
  ['🧙 Алхимик так и не научился делать золото.', 'Поэтому мы честно всё записываем.'],
  ['🏰 Запасы в замке пополнены.', 'Осаду переживём.'],
  ['📜 Абсолютно никто:', 'Ты: аккуратно ведёшь семейный учёт ✨'],
  ['🐈 Кот из рукописи одобрил покупку.', 'Он вообще всё одобряет за еду.'],
  ['🛡️ Бюджет держит оборону.', 'Потери учтены, паники нет.'],
  ['⏳ Деньги приходят и уходят.', 'А таблица вечна.'],
  ['🍷 Сие было необходимо.', 'Летопись подтверждает.'],
  ['🐺 Волки сыты, лари учтены.', 'Средневековая гармония.'],
  ['🧾 Всё по канонам.', 'Даже инквизиции не к чему придраться.'],
  ['🐓 Петух прокричал трижды:', 'трата записана, можно жить дальше.'],
  ['🏹 Стрела попала точно в цель.', 'Цель — продуктовый магазин.'],
  ['🎺 Трубы трубят, барабаны бьют:', 'ещё одна трата учтена!'],
  ['🧝 Эльфы-бухгалтеры довольны.', 'Редкий случай, между прочим.'],
  ['🗝️ Ключ от казны на месте.', 'Просто дверь иногда открывается.'],
  ['🐸 Жаба с полей рукописи задумалась.', 'Но душить не стала.'],
  ['⛪ Святые отцы проверили смету.', 'Грехов не обнаружено.'],
  ['🐴 Конь устал, но довёз покупки.', 'Слава коню!'],
  ['🌧️ За окном опять страдание.', 'Зато трата записана красиво.'],
  ['🍲 Котёл полон, очаг горит.', 'Королевство довольно.']
];
function pickJoke() {
  let deck = [];
  try { deck = JSON.parse(localStorage.getItem('jokeDeck') || '[]'); } catch (e) { deck = []; }
  deck = deck.filter((i) => Number.isInteger(i) && i >= 0 && i < JOKES.length);
  if (!deck.length) {                                  // новый круг: перемешать все фразы
    deck = JOKES.map((_, i) => i);
    for (let k = deck.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [deck[k], deck[j]] = [deck[j], deck[k]]; }
  }
  const i = deck.shift();
  try { localStorage.setItem('jokeDeck', JSON.stringify(deck)); } catch (e) { /* нет памяти */ }
  return JOKES[i];
}
function renderJoke() {
  const box = $('done-joke');
  const [a, b] = pickJoke();
  const l1 = document.createElement('div'); l1.className = 'joke-1'; l1.textContent = a;
  const l2 = document.createElement('div'); l2.className = 'joke-2'; l2.textContent = b;
  box.replaceChildren(l1, l2);
  box.hidden = false;
}

function showDone(d) {
  const a = d.added;
  if (a.kind === 'income') {
    $('done-joke').hidden = true;
    $('done-title').textContent = 'Приход ' + fmt(a.amount) + ' ₾';
    $('done-text').textContent = '💵 ' + a.desc + (state.day === 'yesterday' ? ' · вчера' : '');
    $('done-cash').textContent = '👛 Наличных стало ' + d.cash;
    $('done-undo').hidden = false;         // после прихода — «ОК» и отмена ошибочной записи
    $('done-more').hidden = true;
    $('done-close').textContent = 'ОК';
    $('done-close').className = 'btn btn-primary';
    show('scr-done');
    haptic('ok');
    return;
  }
  const [e, label] = CAT_META[a.cat] || ['✨', a.cat];
  $('done-title').textContent = 'Записано ' + fmt(a.amount) + ' ₾';
  $('done-text').textContent = e + ' ' + (a.desc && a.desc !== a.cat ? a.desc + ' · ' : '') + label +
    (state.day === 'yesterday' ? ' · вчера' : '');
  $('done-cash').textContent = '👛 Наличных осталось ' + d.cash;
  $('done-more').hidden = false;
  $('done-close').textContent = 'Готово';
  $('done-close').className = 'btn btn-ghost';
  renderJoke();
  $('done-undo').hidden = false;
  show('scr-done');
  haptic('ok');
}

function resetForm() {
  state.amount = '';
  state.day = 'today';
  state.cat = 'Продукты';
  setMode('spend');
  $('desc').value = '';
  document.querySelectorAll('.seg-btn').forEach((b) => {
    const on = b.dataset.day === 'today';
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  renderMain();
}

async function undo() {
  if (!state.lastAdded || state.busy) return;
  state.busy = true;
  $('done-undo').disabled = true;
  try {
    const d = await api({ action: 'undo', row: state.lastAdded.row, kind: state.lastAdded.kind || 'spend' });
    if (!d.ok) throw new Error(d.error);
    state.data = d;
    saveCache(d);
    state.lastAdded = null;
    resetForm();
    show('scr-main');
    toast('Запись отменена');
  } catch (e) {
    toast(errText(e && e.message), true);
  } finally {
    state.busy = false;
    $('done-undo').disabled = false;
    updateMainButton();
  }
}

/* ---------- события ---------- */
function bind() {
  $('amount').addEventListener('click', () => { if (!state.amount) { toast('Наберите сумму на кнопках ниже 👇'); bump(); } });
  $('keypad').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (b) press(b.dataset.k);
  });
  document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
    state.day = b.dataset.day;
    document.querySelectorAll('.seg-btn').forEach((x) => {
      const on = x === b;
      x.classList.toggle('on', on);
      x.setAttribute('aria-checked', String(on));
    });
    haptic('tap');
  }));
  $('desc').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.target.blur(); });
  $('desc').addEventListener('focus', () => {
    document.body.classList.add('typing');
    setTimeout(() => $('desc').scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);   // после появления клавиатуры
  });
  $('desc').addEventListener('blur', () => { document.body.classList.remove('typing'); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('save').addEventListener('click', save);
  document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => { haptic('tap'); setMode(b.dataset.mode); }));
  $('sheet-back').addEventListener('click', closeSheet);
  $('err-retry').addEventListener('click', load);
  $('done-more').addEventListener('click', () => { resetForm(); show('scr-main'); });
  $('done-close').addEventListener('click', () => { if (tg && tg.close && !DEMO) tg.close(); else { resetForm(); show('scr-main'); } });
  $('done-undo').addEventListener('click', undo);
  if (tg && tg.BackButton) tg.BackButton.onClick(closeSheet);
  // физическая клавиатура (на компьютере)
  document.addEventListener('keydown', (ev) => {
    if (document.activeElement === $('desc') || $('scr-main').hidden) return;
    if (/^[0-9]$/.test(ev.key)) press(ev.key);
    else if (ev.key === ',' || ev.key === '.') press(',');
    else if (ev.key === 'Backspace') press('del');
    else if (ev.key === 'Enter') save();
  });
}

/* ---------- демо без Telegram (?demo=1) ---------- */
const demo = { cash: 14, rows: [
  { row: 28, date: '26.11.2026', sum: '7,00 ₾', cat: 'Другое', desc: 'шоколадка', who: 'Юлия' },
  { row: 26, date: '25.11.2026', sum: '46,00 ₾', cat: 'Продукты', desc: 'Рынок', who: 'Юлия' }
], reg: false, next: 29, seen: {} };
function demoState() {
  return { ok: true, registered: true, name: 'Юлия', cats: Object.keys(CAT_META),
    catRank: ['Продукты', 'Другое', 'Кафе и рестораны', 'Подписки и связь', 'Одежда и обувь'], cash: fmt(demo.cash) + ' ₾', cashNum: demo.cash, card: '81,88 ₾', perDay: '6,71 ₾', reserve: '123,30 $', recent: demo.rows.slice(0, 5) };
}
function demoApi(b) {
  return new Promise((ok) => setTimeout(() => {
    if (b.action === 'state') return ok(demo.reg ? demoState() : { ok: true, registered: false, canJoin: true, names: ['Андрей', 'Юлия'] });
    if (b.action === 'register') { demo.reg = true; return ok(demoState()); }
    if (b.action === 'income') {
      if (demo.seen[b.reqId]) { const s1 = demoState(); s1.added = demo.seen[b.reqId]; return ok(s1); }
      const amount = Number(String(b.amount).replace(',', '.'));
      demo.cash = Math.round((demo.cash + amount) * 100) / 100;
      const added = { kind: 'income', row: 5, amount, desc: b.desc || 'Приход наличных', date: '26.11.2026' };
      demo.seen[b.reqId] = added; demo.lastIncome = amount;
      const s = demoState(); s.added = added; return ok(s);
    }
    if (b.action === 'undo' && b.kind === 'income') { demo.cash = Math.round((demo.cash - (demo.lastIncome || 0)) * 100) / 100; return ok(demoState()); }
    if (b.action === 'add') {
      if (demo.seen[b.reqId]) { const s0 = demoState(); s0.added = demo.seen[b.reqId]; return ok(s0); }
      const amount = Number(String(b.amount).replace(',', '.'));
      demo.cash = Math.round((demo.cash - amount) * 100) / 100;
      const added = { row: demo.next++, amount, cat: b.cat, desc: b.desc || b.cat, date: '26.11.2026' };
      demo.rows.unshift({ row: added.row, date: added.date, sum: fmt(amount) + ' ₾', cat: b.cat, desc: added.desc, who: 'Юлия' });
      demo.seen[b.reqId] = added;
      const s = demoState(); s.added = added; return ok(s);
    }
    if (b.action === 'undo') {
      const i = demo.rows.findIndex((r) => r.row === b.row);
      if (i >= 0) { demo.cash += Number(demo.rows[i].sum.replace(/[^\d,]/g, '').replace(',', '.')); demo.rows.splice(i, 1); }
      return ok(demoState());
    }
    ok({ ok: false, error: 'unknown' });
  }, 500));
}

/* высота экрана: меньшее из того, что сообщает Telegram, и реального окна (не во время набора текста) */
function fitHeight() {
  if (document.body.classList.contains('typing')) return;
  const tgH = tg && initData && tg.viewportStableHeight ? tg.viewportStableHeight : Infinity;
  const h = Math.min(window.innerHeight, tgH);
  if (h > 300 && isFinite(h)) document.documentElement.style.setProperty('--app-h', h + 'px');
}

/* ---------- старт ---------- */
(function start() {
  if (tg && initData) {
    tg.ready();
    tg.expand();
    document.documentElement.classList.add('tg');
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) { /* старый клиент */ }
  }
  bind();
  fitHeight();
  window.addEventListener('resize', fitHeight);
  if (tg && initData && tg.onEvent) tg.onEvent('viewportChanged', (e) => { if (!e || e.isStateStable) fitHeight(); });
  if (!initData && !DEMO) return show('scr-outside');
  load();
})();
