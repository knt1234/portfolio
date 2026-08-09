/* ============================================================
   Firebase のかわりに動く、デモ専用の偽物
   ------------------------------------------------------------
   実運用版の app.js は、Firebase Authentication（Googleログイン）と
   Cloud Firestore（クラウド保存・リアルタイム同期）を使っています。

   デモ版では本番のFirebaseに一切つながないため、app.js が実際に
   呼んでいる11個の関数だけを、このファイルで肩代わりしています。

     認証      : getAuth / GoogleAuthProvider / signInWithPopup
                 signOut / onAuthStateChanged
     データベース: getFirestore / collection / doc / getDoc
                 setDoc / deleteDoc / onSnapshot

   おかげで app.js（約3,000行）は1行も書き換えずに動きます。
   差し替えたのは、app.js 冒頭の import 3行だけです。

   保存先はこの端末のブラウザ内（localStorage）です。
   サーバーには何も送信されません。
   ============================================================ */

const STORAGE_KEY = "eventBudgetDemo:db_v1";

/* ---------- 疑似データベース本体 ----------
   { コレクション名: { ドキュメントID: 中身 } } という形で持つ。 */
let store = null;

/* onSnapshot で登録された購読者。書き込みのたびに呼び戻す。 */
const watchers = [];

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* 壊れていたら作り直す */ }
  return seedStore();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (e) {
    console.warn("デモデータを保存できませんでした", e);
  }
}

/* 変更があったコレクション／ドキュメントを見ている購読者に知らせる */
function notify(col, id) {
  for (const w of watchers) {
    if (w.col !== col) continue;
    if (w.id != null && w.id !== id) continue;
    queueMicrotask(() => { if (!w.dead) emit(w); });
  }
}

function emit(w) {
  const bucket = store[w.col] || {};
  if (w.id == null) {
    w.cb({
      docs: Object.keys(bucket).map(id => ({ id, data: () => deep(bucket[id]) })),
    });
  } else {
    const has = Object.prototype.hasOwnProperty.call(bucket, w.id);
    w.cb({
      id: w.id,
      exists: () => has,
      data: () => (has ? deep(bucket[w.id]) : undefined),
    });
  }
}

const deep = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

/* ============================================================
   認証のふり
   ------------------------------------------------------------
   デモではログインの手間をなくすため、読み込んだ時点で
   「デモ利用者」としてログイン済みの状態から始める。
   ログアウトすればログイン画面に戻り、そこからまた入り直せる。
   ============================================================ */
const DEMO_USER = Object.freeze({
  uid: "demo-user-0001",
  email: "demo@example.com",
  displayName: "デモ利用者",
});

let currentUser = DEMO_USER;
const authWatchers = [];

function notifyAuth() {
  for (const cb of authWatchers) queueMicrotask(() => cb(currentUser));
}

export function initializeApp(_config) {
  if (!store) store = loadStore();
  return { name: "demo-app" };
}

export function getAuth(_app) {
  return { __demo: true };
}

export class GoogleAuthProvider {
  setCustomParameters(_p) { return this; }
}

export async function signInWithPopup(_auth, _provider) {
  currentUser = DEMO_USER;
  notifyAuth();
  return { user: DEMO_USER };
}

export async function signOut(_auth) {
  currentUser = null;
  notifyAuth();
}

export function onAuthStateChanged(_auth, cb) {
  authWatchers.push(cb);
  queueMicrotask(() => cb(currentUser));
  return () => {
    const i = authWatchers.indexOf(cb);
    if (i >= 0) authWatchers.splice(i, 1);
  };
}

/* ============================================================
   Firestore のふり
   ============================================================ */
export function getFirestore(_app) {
  if (!store) store = loadStore();
  return { __demo: true };
}

export function collection(_db, name) {
  return { __kind: "collection", col: name };
}

export function doc(_db, col, id) {
  return { __kind: "doc", col, id };
}

export async function getDoc(ref) {
  const bucket = store[ref.col] || {};
  const has = Object.prototype.hasOwnProperty.call(bucket, ref.id);
  return {
    id: ref.id,
    exists: () => has,
    data: () => (has ? deep(bucket[ref.id]) : undefined),
  };
}

export async function setDoc(ref, data, options) {
  if (!store[ref.col]) store[ref.col] = {};
  const prev = store[ref.col][ref.id];
  // 実運用版は setDoc(..., { merge: true }) も使うので、そこも合わせる
  store[ref.col][ref.id] =
    options && options.merge && prev ? { ...prev, ...deep(data) } : deep(data);
  persist();
  notify(ref.col, ref.id);
}

export async function deleteDoc(ref) {
  if (store[ref.col]) delete store[ref.col][ref.id];
  persist();
  notify(ref.col, ref.id);
}

export function onSnapshot(ref, cb, _errCb) {
  const w = {
    col: ref.col,
    id: ref.__kind === "doc" ? ref.id : null,
    cb,
    dead: false,
  };
  watchers.push(w);
  queueMicrotask(() => { if (!w.dead) emit(w); });
  return () => {
    w.dead = true;
    const i = watchers.indexOf(w);
    if (i >= 0) watchers.splice(i, 1);
  };
}

/* ============================================================
   デモを初期状態に戻す（画面上部の「初期状態に戻す」から呼ばれる）
   ============================================================ */
export function resetDemoData() {
  localStorage.removeItem(STORAGE_KEY);
}

/* ============================================================
   サンプルデータ
   ------------------------------------------------------------
   登場するイベント名・宿泊先・金額・利用者は、すべて架空です。
   ============================================================ */

let seq = 0;
const sid = (p) => `${p}-${++seq}`;

function lodging(hotel, roomType, cap, rooms, price, i) {
  return { id: sid("lg"), hotel_name: hotel, room_type: roomType,
    capacity_per_room: cap, room_count: rooms, unit_price: price, note: "", sort_order: i };
}
function meal(timing, count, price, i) {
  return { id: sid("ml"), timing, meal_count: count, unit_price: price, note: "", sort_order: i };
}
function venue(date, name, qty, price, i) {
  return { id: sid("vn"), date, name, quantity: qty, unit_price: price, note: "", sort_order: i };
}
function expense(category, name, price, qty, i) {
  return { id: sid("ex"), category, name, unit_price: price, quantity: qty, note: "", sort_order: i };
}
function ncaIncome(kind, count, price) {
  return { id: sid("ni"), kind, count, unit_price: price, note: "" };
}
function ncaExpense(category, name, count, price) {
  return { id: sid("ne"), category, name, count, unit_price: price, note: "" };
}

function plan(o) {
  return {
    id: o.id || sid("pl"),
    name: o.name,
    paid_participant_count: o.people || 0,
    participation_fee: o.fee || 0,
    other_income: o.otherIncome || 0,
    target_profit: o.target || 0,
    required_lodging_count: o.requiredLodging ?? null,
    is_selected_budget: !!o.selected,
    lodging_items: o.lodging || [],
    meal_items: o.meals || [],
    venue_items: o.venue || [],
    expense_items: o.expenses || [],
    lodging_cancels: o.lodgingCancels || [],
    meal_cancels: o.mealCancels || [],
    venue_cancels: o.venueCancels || [],
    nca_income_items: o.ncaIncome || [],
    nca_expense_items: o.ncaExpense || [],
  };
}

/* app.js の calcBlock と同じ計算。確定済み実績の数字を作るために使う。 */
function calcSeed(b) {
  const sum = (arr, f) => (arr || []).reduce((s, r) => s + f(r), 0);
  const lodgingTotal = sum(b.lodging_items, r => r.room_count * r.unit_price)
    + sum(b.lodging_cancels, r => r.amount || 0);
  const mealsTotal = sum(b.meal_items, r => r.meal_count * r.unit_price)
    + sum(b.meal_cancels, r => r.amount || 0);
  const venueTotal = sum(b.venue_items, r => r.quantity * r.unit_price)
    + sum(b.venue_cancels, r => r.amount || 0);
  const miscTotal = sum(b.expense_items, r => r.unit_price * r.quantity);
  const ncaInc = sum(b.nca_income_items, r => r.count * r.unit_price);
  const ncaExp = sum(b.nca_expense_items, r => r.count * r.unit_price);
  const income = b.paid_participant_count * b.participation_fee + b.other_income + ncaInc;
  const expense = lodgingTotal + mealsTotal + venueTotal + miscTotal + ncaExp;
  return { income, expense, net: income - expense,
    lodging: lodgingTotal, meals: mealsTotal, venue: venueTotal, misc: miscTotal };
}

function snapshotOf(p, name) {
  const s = deep(p);
  s.id = sid("bs");
  s.source_plan_id = p.id;
  s.source_plan_name = name || p.name;
  s.snapshot_at = Date.parse("2026-04-20T09:00:00+09:00");
  return s;
}

function seedStore() {
  const T = (iso) => Date.parse(iso);

  /* ---- イベント1：実績まで入力し、確定済み ---- */
  const p1 = plan({
    name: "標準プラン", selected: true, people: 28, fee: 42000, otherIncome: 0, target: 150000,
    lodging: [
      lodging("架空ホテル ナギサ", "ツイン", 2, 10, 18000, 0),
      lodging("架空ホテル ナギサ", "シングル", 1, 8, 12000, 1),
      lodging("架空ホテル ナギサ", "宿泊税", 0, 28, 200, 2),
    ],
    meals: [
      meal("1日目 昼", 28, 1200, 0),
      meal("1日目 夜", 28, 4500, 1),
      meal("2日目 朝", 28, 1500, 2),
      meal("2日目 昼", 28, 1200, 3),
    ],
    venue: [venue("2026-05-16", "研修室（1日目）", 1, 48000, 0),
            venue("2026-05-17", "研修室（2日目）", 1, 36000, 1)],
    expenses: [expense("備品費", "名札・資料印刷", 480, 28, 0),
               expense("交通費", "会場までの送迎バス", 62000, 1, 1)],
  });
  const budget1 = snapshotOf(p1);
  const actual1 = deep(budget1);
  actual1.id = sid("ac");
  delete actual1.source_plan_id; delete actual1.source_plan_name; delete actual1.snapshot_at;
  actual1.is_selected_budget = false;
  actual1.paid_participant_count = 26;                 // 直前に2名キャンセル
  actual1.lodging_items[0].room_count = 9;
  actual1.lodging_items[2].room_count = 26;
  actual1.meal_items.forEach(m => { m.meal_count = 26; });
  actual1.lodging_cancels = [
    { id: sid("lc"), name: "直前キャンセル（ツイン1室）", amount: 9000, note: "" },
  ];
  actual1.expense_items.push(expense("その他", "備品の追加購入", 8400, 1, 2));
  const a1 = calcSeed(actual1);

  const ev1 = {
    id: "demo-ev-1",
    name: "2026年 春合宿（架空）",
    category: "合宿",
    start_date: "2026-05-16",
    end_date: "2026-05-17",
    status: "完了",
    default_target_profit: 150000,
    plans: [p1],
    budget_snapshot: budget1,
    actual: actual1,
    actual_confirmed: {
      at: T("2026-05-20T18:30:00+09:00"),
      by: DEMO_USER.email,
      income: a1.income, expense: a1.expense, net: a1.net,
      lodging: a1.lodging, meals: a1.meals, venue: a1.venue, misc: a1.misc,
    },
    created_at: T("2026-03-02T10:00:00+09:00"),
    updated_at: T("2026-05-20T18:30:00+09:00"),
  };

  /* ---- イベント2：プランを2案つくって比較している途中 ---- */
  const p2a = plan({
    name: "A案：温泉宿", people: 20, fee: 38000, target: 100000,
    lodging: [
      lodging("架空温泉旅館 トキワ", "ツイン", 2, 8, 21000, 0),
      lodging("架空温泉旅館 トキワ", "トリプル", 3, 2, 27000, 1),
    ],
    meals: [meal("1日目 昼", 20, 1100, 0), meal("1日目 夜", 20, 5200, 1),
            meal("2日目 朝", 20, 1600, 2), meal("2日目 昼", 20, 1100, 3)],
    venue: [venue("2026-09-12", "宴会場（研修利用）", 1, 40000, 0)],
    expenses: [expense("備品費", "しおり印刷", 320, 20, 0)],
  });
  const p2b = plan({
    name: "B案：市内ホテル", people: 20, fee: 33000, target: 100000,
    lodging: [
      lodging("架空シティホテル ミドリ", "シングル", 1, 20, 11500, 0),
    ],
    meals: [meal("1日目 昼", 20, 900, 0), meal("1日目 夜", 20, 3800, 1),
            meal("2日目 朝", 20, 0, 2), meal("2日目 昼", 20, 900, 3)],
    venue: [venue("2026-09-12", "貸会議室", 1, 52000, 0),
            venue("2026-09-13", "貸会議室", 1, 52000, 1)],
    expenses: [expense("備品費", "しおり印刷", 320, 20, 0),
               expense("交通費", "会場間の移動", 900, 20, 1)],
  });
  const ev2 = {
    id: "demo-ev-2",
    name: "2026年 秋合宿（架空・プラン比較中）",
    category: "合宿",
    start_date: "2026-09-12",
    end_date: "2026-09-13",
    status: "試算中",
    default_target_profit: 100000,
    plans: [p2a, p2b],
    budget_snapshot: null,
    actual: null,
    actual_confirmed: null,
    created_at: T("2026-07-14T11:20:00+09:00"),
    updated_at: T("2026-08-01T09:05:00+09:00"),
  };

  /* ---- イベント3：セミナー＋懇親会型（NCA区分）、予算確定まで ---- */
  const p3 = plan({
    name: "標準プラン", selected: true, target: 60000,
    ncaIncome: [
      ncaIncome("懇親会＋セミナー参加", 24, 9000),
      ncaIncome("セミナーのみ参加", 11, 5000),
      ncaIncome("懇親会のみ参加", 5, 6000),
    ],
    ncaExpense: [
      ncaExpense("セミナー会場", "貸ホール（半日）", 1, 78000),
      ncaExpense("懇親会費用", "飲食（1名あたり）", 29, 5200),
      ncaExpense("その他", "登壇者への謝礼", 1, 50000),
      ncaExpense("キャンセル料（懇親会）", "前日キャンセル 2名分", 2, 2600),
    ],
  });
  const ev3 = {
    id: "demo-ev-3",
    name: "秋のセミナー交流会（架空）",
    category: "NCA",
    start_date: "2026-10-03",
    end_date: "2026-10-03",
    status: "予算確定",
    default_target_profit: 60000,
    plans: [p3],
    budget_snapshot: snapshotOf(p3),
    actual: null,
    actual_confirmed: null,
    created_at: T("2026-07-28T15:40:00+09:00"),
    updated_at: T("2026-08-04T16:12:00+09:00"),
  };

  return {
    events: { "demo-ev-1": ev1, "demo-ev-2": ev2, "demo-ev-3": ev3 },
    app_settings: {},          // 起動時に app.js が既定値で作る
    authorized_users: {
      "demo-user-0001": { email: "demo@example.com", active: true, created_at: T("2026-03-01T09:00:00+09:00") },
      "demo-user-0002": { email: "partner@example.com", active: true, created_at: T("2026-03-01T09:10:00+09:00") },
    },
    authorized_emails: {
      "partner@example.com": { active: true, invited_at: T("2026-03-01T09:05:00+09:00") },
      "newmember@example.com": { active: false, invited_at: T("2026-07-30T13:00:00+09:00") },
    },
  };
}
