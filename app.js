'use strict';

// ---------- 定数 ----------

const CATEGORIES = ['野菜', '肉', '魚介', '卵・乳製品', '豆腐・大豆', '主食', '調味料', '冷凍食品', 'その他'];
const UNITS = ['個', '本', '玉', '束', '袋', 'パック', '枚', '丁', '切れ', 'g', 'ml'];
const BIG_STEP_UNITS = ['g', 'ml'];
const QUICK_PROMPTS = [
  '今ある在庫で夕飯のメニューを3つ',
  '使い切りたい食材を優先して',
  '20分以内で作れるもの',
  '主菜と副菜の組み合わせ',
  '子どもが喜ぶメニュー',
  '何を買い足すと作れる幅が広がる？',
];
// 「条件を選んで頼む」の選択肢。multi: 複数選択可、default: 初期選択
const TEMPLATE_GROUPS = [
  { key: 'count', label: '品数', multi: false, default: ['3品'],
    options: ['1品', '2品', '3品', '4品', '5品'] },
  { key: 'type', label: '料理の種類', multi: false, default: ['おまかせ'],
    options: ['おまかせ', '主菜', '副菜', '汁物・スープ', '主菜＋副菜＋汁物の献立', '丼・麺・ご飯もの', 'お弁当のおかず', 'おつまみ'] },
  { key: 'flavor', label: '味付け（複数可）', multi: true, default: ['おまかせ'],
    options: ['おまかせ', '醤油', '味噌', '塩', '甘辛', '照り焼き', 'ポン酢・さっぱり', '和風だし', 'コンソメ・洋風', 'トマト', 'クリーム・チーズ', '中華', 'カレー・スパイス', 'ピリ辛', 'ごま'] },
  { key: 'time', label: '調理時間', multi: false, default: ['指定なし'],
    options: ['指定なし', '10分以内', '20分以内', '30分以内', '時間をかけてOK'] },
  { key: 'method', label: '調理法（複数可）', multi: true, default: ['おまかせ'],
    options: ['おまかせ', '炒める', '煮る', '焼く', '揚げる', '蒸す', 'レンジだけ', '火を使わない'] },
  { key: 'wish', label: 'こだわり（複数可）', multi: true, default: [],
    options: ['使い切りたい食材を優先', '在庫だけで作る', '子ども向け', 'ヘルシー', 'ボリューム重視', '作り置きできる', '洗い物を少なく'] },
];
const ANY_OPTIONS = ['おまかせ', '指定なし'];

const VIEW_TITLES ={ stock: '在庫', chef: 'AIシェフ', history: '作った履歴', settings: '設定' };
const ADJUST_DELAY_MS = 700;

const KEY_SETTINGS = 'fr.settings';
const KEY_CHAT = 'fr.chat';
const KEY_STOCK = 'fr.stock';
const KEY_TEMPLATE = 'fr.template';

// ---------- 状態 ----------

const state = {
  items: [],
  history: [],
  chat: [],
  category: 'すべて',
  search: '',
  editingId: null,
  chatBusy: false,
};
const pendingDeltas = new Map(); // id -> { delta, timer }

// ---------- ユーティリティ ----------

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

function fmt(n) {
  return String(Math.round(Number(n) * 100) / 100);
}

function stepFor(unit) {
  return BIG_STEP_UNITS.includes(unit) ? 50 : 1;
}

let toastTimer;
function toast(message, isError) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('error', !!isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 4500 : 2200);
}

let loadingCount = 0;
function setLoading(on) {
  loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
  $('#loading').hidden = loadingCount === 0;
}

// ---------- 設定・API ----------

function getSettings() {
  return Object.assign({ passcode: '', servings: 3, apiUrl: '' }, load(KEY_SETTINGS, {}));
}

function apiUrl() {
  return getSettings().apiUrl || (window.APP_CONFIG && window.APP_CONFIG.API_URL) || '';
}

async function api(action, payload) {
  const url = apiUrl();
  if (!url) throw new Error('サーバーURLが未設定です（config.js を確認してください）');
  const { passcode } = getSettings();
  if (!passcode) throw new Error('設定画面で合言葉を入力してください');

  // text/plain で送ると CORS のプリフライトが発生せず GAS で受け取れる
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action, passcode }, payload)),
  });
  if (!res.ok) throw new Error('通信エラー (' + res.status + ')');
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(data.error || 'エラーが発生しました');
    err.code = data.code;
    throw err;
  }
  return data;
}

function handleError(err) {
  console.error(err);
  toast(err.message || String(err), true);
  if (err.code === 'AUTH') showView('settings');
}

// ---------- 在庫 ----------

function setItems(items) {
  state.items = items;
  // まだ送信していない増減を上乗せして、画面の数字が戻らないようにする
  for (const [id, p] of pendingDeltas) {
    const it = state.items.find((x) => x.id === id);
    if (it) it.amount = Math.max(0, it.amount + p.delta);
  }
  save(KEY_STOCK, state.items);
  renderStock();
}

async function refreshStock(quiet) {
  if (!quiet) setLoading(true);
  try {
    const data = await api('list');
    setItems(data.items);
  } catch (err) {
    handleError(err);
  } finally {
    if (!quiet) setLoading(false);
  }
}

function adjust(id, delta) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  const next = Math.max(0, it.amount + delta);
  const applied = next - it.amount;
  if (applied === 0) return;
  it.amount = next;
  renderStock();

  const p = pendingDeltas.get(id) || { delta: 0, timer: null };
  p.delta += applied;
  clearTimeout(p.timer);
  p.timer = setTimeout(() => flushAdjust(id), ADJUST_DELAY_MS);
  pendingDeltas.set(id, p);
}

async function flushAdjust(id) {
  const p = pendingDeltas.get(id);
  if (!p) return;
  pendingDeltas.delete(id);
  if (p.delta === 0) return;
  try {
    const data = await api('adjust', { id, delta: p.delta });
    setItems(data.items);
  } catch (err) {
    handleError(err);
    refreshStock(true);
  }
}

function renderCategoryFilter() {
  const wrap = $('#category-filter');
  wrap.replaceChildren(
    ...['すべて', ...CATEGORIES].map((c) =>
      el('button', {
        class: 'chip' + (state.category === c ? ' active' : ''),
        onclick: () => {
          state.category = c;
          renderCategoryFilter();
          renderStock();
        },
      }, c)
    )
  );
}

function renderStock() {
  const list = $('#stock-list');
  const q = state.search.trim().toLowerCase();
  const items = state.items.filter(
    (it) =>
      (state.category === 'すべて' || it.category === state.category) &&
      (!q || it.name.toLowerCase().includes(q) || it.memo.toLowerCase().includes(q))
  );

  if (!items.length) {
    list.replaceChildren(
      el('div', { class: 'empty' },
        state.items.length ? '該当する食材がありません' : 'まだ食材がありません。「＋ 追加」から登録しましょう')
    );
    return;
  }

  const order = (c) => {
    const i = CATEGORIES.indexOf(c);
    return i < 0 ? CATEGORIES.length : i;
  };
  const groups = new Map();
  [...items]
    .sort((a, b) => order(a.category) - order(b.category) || a.name.localeCompare(b.name, 'ja'))
    .forEach((it) => {
      if (!groups.has(it.category)) groups.set(it.category, []);
      groups.get(it.category).push(it);
    });

  const nodes = [];
  for (const [cat, group] of groups) {
    nodes.push(el('div', { class: 'cat-heading' }, cat));
    for (const it of group) {
      const step = stepFor(it.unit);
      nodes.push(
        el('div', { class: 'stock-item' + (it.amount <= 0 ? ' zero' : '') },
          el('div', { class: 'stock-main', onclick: () => openItemDialog(it) },
            el('div', { class: 'stock-name' }, it.name),
            it.memo ? el('div', { class: 'stock-memo' }, it.memo) : null
          ),
          el('div', { class: 'stock-amount' }, it.amount <= 0 ? 'なし' : [fmt(it.amount), el('small', {}, it.unit)]),
          el('button', { class: 'step-btn', 'aria-label': it.name + 'を減らす', onclick: () => adjust(it.id, -step) }, '−'),
          el('button', { class: 'step-btn', 'aria-label': it.name + 'を増やす', onclick: () => adjust(it.id, step) }, '＋')
        )
      );
    }
  }
  list.replaceChildren(...nodes);
}

function openItemDialog(item) {
  state.editingId = item ? item.id : null;
  $('#item-dialog-title').textContent = item ? '食材を編集' : '食材を追加';
  $('#item-name').value = item ? item.name : '';
  $('#item-amount').value = item ? fmt(item.amount) : 1;
  $('#item-unit').value = item ? item.unit : '個';
  $('#item-category').value = item ? item.category : (state.category !== 'すべて' ? state.category : '野菜');
  $('#item-memo').value = item ? item.memo : '';
  $('#item-delete').hidden = !item;
  $('#item-dialog').showModal();
  if (!item) $('#item-name').focus();
}

async function submitItem(e) {
  e.preventDefault();
  const item = {
    id: state.editingId,
    name: $('#item-name').value.trim(),
    amount: Number($('#item-amount').value) || 0,
    unit: $('#item-unit').value.trim(),
    category: $('#item-category').value,
    memo: $('#item-memo').value.trim(),
  };
  if (!item.name) return;
  $('#item-dialog').close();
  setLoading(true);
  try {
    const data = await api('save', { item });
    setItems(data.items);
    toast(item.id ? '更新しました' : item.name + 'を追加しました');
  } catch (err) {
    handleError(err);
  } finally {
    setLoading(false);
  }
}

async function deleteItem() {
  const id = state.editingId;
  const it = state.items.find((x) => x.id === id);
  if (!it || !confirm(it.name + 'を削除しますか？')) return;
  $('#item-dialog').close();
  setLoading(true);
  try {
    const data = await api('remove', { id });
    setItems(data.items);
    toast('削除しました');
  } catch (err) {
    handleError(err);
  } finally {
    setLoading(false);
  }
}

// ---------- AIシェフ ----------

function saveChat() {
  save(KEY_CHAT, state.chat.slice(-60));
}

/** API に渡す会話履歴。レシピは題名だけ添えてトークンを節約する */
function chatForApi() {
  return state.chat
    .filter((m) => m.role === 'user' || m.role === 'model')
    .map((m) => ({
      role: m.role,
      text: m.role === 'model' && m.recipes && m.recipes.length
        ? m.text + '\n[提案したレシピ: ' + m.recipes.map((r) => r.title).join('、') + ']'
        : m.text,
    }));
}

async function sendChat(text) {
  text = text.trim();
  if (!text || state.chatBusy) return;
  state.chatBusy = true;
  state.chat.push({ role: 'user', text });
  $('#chat-input').value = '';
  autoResize();
  renderChat(true);

  try {
    const data = await api('chat', { messages: chatForApi(), servings: getSettings().servings });
    state.chat.push({ role: 'model', text: data.reply || '', recipes: data.recipes || [] });
  } catch (err) {
    state.chat.push({ role: 'error', text: err.message || String(err) });
    if (err.code === 'AUTH') handleError(err);
  } finally {
    state.chatBusy = false;
    saveChat();
    renderChat(false);
    // AI が使う在庫を最新にしておく（他の家族の変更を反映）
    refreshStock(true);
  }
}

function findStockFor(ing) {
  if (ing.inventoryId) {
    const byId = state.items.find((x) => x.id === ing.inventoryId);
    if (byId) return byId;
  }
  const name = (ing.name || '').trim();
  if (!name) return null;
  return state.items.find((x) => x.name === name) ||
    state.items.find((x) => x.name.includes(name) || name.includes(x.name)) || null;
}

function renderRecipe(recipe, collapsed) {
  const card = el('div', { class: 'recipe' + (collapsed ? ' collapsed' : '') });
  const meta = [
    recipe.flavor ? '🧂 ' + recipe.flavor : null,
    recipe.minutes ? '⏱ 約' + recipe.minutes + '分' : null,
    recipe.servings ? '🍽 ' + recipe.servings + '人分' : null,
  ].filter(Boolean).join('　');
  const tips = recipe.tips || [];

  card.append(
    el('div', { class: 'recipe-head', onclick: () => card.classList.toggle('collapsed') },
      el('h3', { class: 'recipe-title' }, recipe.title),
      meta ? el('div', { class: 'recipe-meta' }, meta) : null,
      recipe.description ? el('p', { class: 'recipe-desc' }, recipe.description) : null
    ),
    el('div', { class: 'recipe-body' },
      el('h4', {}, '材料'),
      el('ul', { class: 'ing-list' },
        (recipe.ingredients || []).map((ing) => {
          const stock = findStockFor(ing);
          return el('li', {},
            el('span', {}, ing.name,
              stock && stock.amount > 0
                ? el('span', { class: 'tag have' }, '在庫あり')
                : el('span', { class: 'tag missing' }, '在庫なし')),
            el('span', {}, ing.display || '')
          );
        })
      ),
      el('h4', {}, '作り方'),
      el('ol', { class: 'steps' }, (recipe.steps || []).map((s) => el('li', {}, s))),
      tips.length ? el('h4', {}, 'コツ・ポイント') : null,
      tips.length ? el('ul', { class: 'tips' }, tips.map((t) => el('li', {}, t))) : null
    ),
    el('div', { class: 'recipe-foot' },
      el('button', { class: 'btn primary', onclick: () => openCookDialog(recipe) }, 'これを作る')
    )
  );
  return card;
}

function renderChat(thinking) {
  const log = $('#chat-log');
  const nodes = [];
  if (!state.chat.length) {
    nodes.push(
      el('div', { class: 'msg model' },
        el('div', { class: 'bubble' },
          'こんにちは！在庫を見ながらメニューを考えます。\n下のボタンを押すか、食べたいものを自由に書いてください。'))
    );
  }
  for (const m of state.chat) {
    if (m.text) nodes.push(el('div', { class: 'msg ' + m.role }, el('div', { class: 'bubble' }, m.text)));
    // 複数品のときは折りたたんで、タップで詳細を開く
    const recipes = m.recipes || [];
    for (const r of recipes) nodes.push(renderRecipe(r, recipes.length > 1));
  }
  if (thinking) {
    nodes.push(el('div', { class: 'msg model' }, el('div', { class: 'bubble' }, el('span', { class: 'typing' }, el('i'), el('i'), el('i')))));
  }
  log.replaceChildren(...nodes);
  $('#chat-send').disabled = state.chatBusy;
  requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
}

function renderQuickPrompts() {
  $('#quick-prompts').replaceChildren(
    el('button', { class: 'chip tpl', type: 'button', onclick: openTemplateDialog }, '📝 条件を選んで頼む'),
    ...QUICK_PROMPTS.map((p) => el('button', { class: 'chip', type: 'button', onclick: () => sendChat(p) }, p))
  );
}

// ---------- 条件を選んで頼む（テンプレート） ----------

function defaultTemplate() {
  const t = {};
  for (const g of TEMPLATE_GROUPS) t[g.key] = [...g.default];
  return t;
}

let template = null;

function loadTemplate() {
  const saved = load(KEY_TEMPLATE, {});
  template = defaultTemplate();
  for (const g of TEMPLATE_GROUPS) {
    // 選択肢を後から変えても壊れないよう、存在する値だけ復元する
    const valid = (saved[g.key] || []).filter((v) => g.options.includes(v));
    if (valid.length) template[g.key] = valid;
  }
}

function toggleTemplateOption(group, option) {
  let selected = template[group.key];
  if (!group.multi) {
    selected = [option];
  } else if (selected.includes(option)) {
    selected = selected.filter((v) => v !== option);
  } else if (ANY_OPTIONS.includes(option)) {
    selected = [option];
  } else {
    selected = [...selected.filter((v) => !ANY_OPTIONS.includes(v)), option];
  }
  // 「おまかせ」がある項目で全部外したら「おまかせ」に戻す
  if (!selected.length) selected = group.options.filter((v) => ANY_OPTIONS.includes(v)).slice(0, 1);
  template[group.key] = selected;
  renderTemplate();
}

function renderTemplate() {
  $('#tpl-groups').replaceChildren(
    ...TEMPLATE_GROUPS.map((g) =>
      el('div', { class: 'tpl-group' },
        el('div', { class: 'tpl-label' }, g.label),
        el('div', { class: 'chips wrap' },
          g.options.map((o) =>
            el('button', {
              type: 'button',
              class: 'chip' + (template[g.key].includes(o) ? ' active' : ''),
              onclick: () => toggleTemplateOption(g, o),
            }, o)
          )
        )
      )
    )
  );
}

function openTemplateDialog() {
  if (state.chatBusy) return;
  loadTemplate();
  renderTemplate();
  $('#tpl-servings').value = getSettings().servings;
  $('#tpl-note').value = '';
  $('#tpl-dialog').showModal();
}

function buildTemplatePrompt() {
  const lines = ['次の条件でメニューを提案してください。'];
  for (const g of TEMPLATE_GROUPS) {
    const values = template[g.key].filter((v) => !ANY_OPTIONS.includes(v));
    if (!values.length) continue;
    const label = g.label.replace('（複数可）', '');
    lines.push('・' + label + ': ' + values.join('、'));
  }
  lines.push('・人数: ' + (Math.max(1, Number($('#tpl-servings').value) || getSettings().servings)) + '人分');
  const note = $('#tpl-note').value.trim();
  if (note) lines.push('・その他: ' + note);
  return lines.join('\n');
}

function submitTemplate(e) {
  e.preventDefault();
  save(KEY_TEMPLATE, template);
  const prompt = buildTemplatePrompt();
  $('#tpl-dialog').close();
  sendChat(prompt);
}

function autoResize() {
  const ta = $('#chat-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, 120) + 'px';
}

// ---------- 作る（消費） ----------

let cookRecipe = null;

function stockOptions(selectedId) {
  const sorted = [...state.items].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return [
    el('option', { value: '' }, '（在庫から引かない）'),
    ...sorted.map((it) =>
      el('option', { value: it.id, selected: it.id === selectedId }, it.name + '（' + fmt(it.amount) + it.unit + '）'))
  ];
}

function makeCookRow(label, display, stock, amount) {
  const check = el('input', { type: 'checkbox' });
  const select = el('select', {}, stockOptions(stock ? stock.id : ''));
  const input = el('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: fmt(amount || 0) });
  const unit = el('span', { class: 'cook-unit' });
  const stockInfo = el('div', { class: 'cook-stock' });
  const row = el('div', { class: 'cook-row' },
    check,
    el('div', { class: 'cook-label' }, label, display ? el('small', {}, display) : null),
    el('div', { class: 'cook-controls' }, select, input, unit),
    stockInfo
  );

  const update = () => {
    const it = state.items.find((x) => x.id === select.value);
    unit.textContent = it ? it.unit : '';
    input.disabled = !it;
    if (!it) check.checked = false;
    check.disabled = !it;
    row.classList.toggle('off', !check.checked);
    if (it) {
      const left = it.amount - (Number(input.value) || 0);
      stockInfo.textContent = '在庫 ' + fmt(it.amount) + it.unit + ' → 残り ' + fmt(Math.max(0, left)) + it.unit;
      stockInfo.classList.toggle('short', left < 0);
    } else {
      stockInfo.textContent = '在庫には登録されていません';
      stockInfo.classList.remove('short');
    }
  };
  check.checked = !!stock && amount > 0;
  select.addEventListener('change', () => {
    if (select.value) check.checked = true;
    update();
  });
  input.addEventListener('input', () => {
    if (Number(input.value) > 0 && select.value) check.checked = true;
    update();
  });
  check.addEventListener('change', update);
  update();

  row.getUse = () => (check.checked && select.value ? { id: select.value, amount: Number(input.value) || 0 } : null);
  return row;
}

function openCookDialog(recipe) {
  cookRecipe = recipe;
  $('#cook-title').textContent = recipe.title;
  $('#cook-rows').replaceChildren(
    ...(recipe.ingredients || []).map((ing) => {
      const stock = findStockFor(ing);
      return makeCookRow(ing.name, ing.display, stock, stock ? Number(ing.consume) || 0 : 0);
    })
  );
  $('#cook-dialog').showModal();
}

async function submitCook(e) {
  e.preventDefault();
  const uses = [...$('#cook-rows').children]
    .map((row) => row.getUse())
    .filter((u) => u && u.amount > 0);
  $('#cook-dialog').close();
  setLoading(true);
  try {
    const data = await api('cook', { title: cookRecipe ? cookRecipe.title : '', uses });
    setItems(data.items);
    toast(uses.length ? '在庫を更新しました。いただきます！' : '履歴に記録しました');
    loadHistory(true);
  } catch (err) {
    handleError(err);
  } finally {
    setLoading(false);
  }
}

// ---------- 履歴 ----------

async function loadHistory(quiet) {
  if (!quiet) setLoading(true);
  try {
    const data = await api('history');
    state.history = data.history;
    renderHistory();
  } catch (err) {
    if (!quiet) handleError(err);
  } finally {
    if (!quiet) setLoading(false);
  }
}

function renderHistory() {
  const list = $('#history-list');
  if (!state.history.length) {
    list.replaceChildren(el('div', { class: 'empty' }, 'まだ記録がありません。AIシェフのレシピで「これを作る」を押すと記録されます'));
    return;
  }
  const df = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  list.replaceChildren(
    ...state.history.map((h) => {
      const d = new Date(h.date);
      return el('div', { class: 'history-item' },
        el('div', { class: 'date' }, isNaN(d) ? h.date : df.format(d)),
        el('div', { class: 'title' }, h.title),
        el('div', { class: 'used' }, h.used)
      );
    })
  );
}

// ---------- 設定 ----------

function fillSettings() {
  const s = getSettings();
  $('#set-passcode').value = s.passcode;
  $('#set-servings').value = s.servings;
  $('#set-api').value = s.apiUrl;
}

async function saveSettings() {
  const s = {
    passcode: $('#set-passcode').value.trim(),
    servings: Math.max(1, Number($('#set-servings').value) || 3),
    apiUrl: $('#set-api').value.trim(),
  };
  save(KEY_SETTINGS, s);
  const status = $('#settings-status');
  status.textContent = '接続を確認しています…';
  try {
    const data = await api('list');
    setItems(data.items);
    status.textContent = '接続できました（食材 ' + data.items.length + ' 件）';
    toast('接続できました');
  } catch (err) {
    status.textContent = '接続できませんでした: ' + err.message;
  }
}

// ---------- 画面切り替え ----------

function showView(name) {
  for (const v of ['stock', 'chef', 'history', 'settings']) {
    $('#view-' + v).hidden = v !== name;
  }
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#view-title').textContent = VIEW_TITLES[name];
  if (name === 'chef') renderChat(state.chatBusy);
  else window.scrollTo(0, 0);
  if (name === 'history') loadHistory(state.history.length > 0);
  if (name === 'settings') fillSettings();
}

// ---------- 初期化 ----------

function init() {
  // 在庫ダイアログの選択肢
  $('#item-category').replaceChildren(...CATEGORIES.map((c) => el('option', { value: c }, c)));
  $('#unit-chips').replaceChildren(
    ...UNITS.map((u) => el('button', { type: 'button', class: 'chip', onclick: () => ($('#item-unit').value = u) }, u))
  );

  // イベント
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#btn-add').addEventListener('click', () => openItemDialog(null));
  $('#item-form').addEventListener('submit', submitItem);
  $('#item-delete').addEventListener('click', deleteItem);
  $('#cook-form').addEventListener('submit', submitCook);
  $('#tpl-form').addEventListener('submit', submitTemplate);
  $('#tpl-reset').addEventListener('click', () => {
    template = defaultTemplate();
    renderTemplate();
    $('#tpl-note').value = '';
  });
  $('#cook-add-row').addEventListener('click', () => $('#cook-rows').append(makeCookRow('追加の食材', '', null, 0)));
  $('#stock-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderStock();
  });
  $('#btn-refresh').addEventListener('click', () => {
    refreshStock(false);
    if (!$('#view-history').hidden) loadHistory(true);
  });
  $('#btn-save-settings').addEventListener('click', saveSettings);
  $('#btn-clear-chat').addEventListener('click', () => {
    if (!confirm('この端末の会話をすべて消しますか？')) return;
    state.chat = [];
    saveChat();
    toast('会話を消しました');
  });

  const chatInput = $('#chat-input');
  chatInput.addEventListener('input', autoResize);
  chatInput.addEventListener('keydown', (e) => {
    // PC では Enter で送信（Shift+Enter で改行）。スマホは送信ボタンで送る
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      sendChat(chatInput.value);
    }
  });
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat(chatInput.value);
  });

  // 前回のデータを先に表示してから最新を取りに行く
  state.items = load(KEY_STOCK, []);
  state.chat = load(KEY_CHAT, []);
  renderCategoryFilter();
  renderQuickPrompts();
  renderStock();

  if (!getSettings().passcode) {
    showView('settings');
    $('#settings-status').textContent = 'はじめに家族の合言葉を入力してください';
  } else {
    refreshStock(state.items.length > 0);
  }

  // 他の端末の変更を反映するため、アプリに戻ってきたら再取得
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getSettings().passcode) refreshStock(true);
  });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker 登録失敗', err));
  }
}

init();
