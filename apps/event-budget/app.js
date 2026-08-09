/* ============================================================
   イベント収支管理  —  Firebase版
   ・認証   : Firebase Authentication（Googleログイン）
   ・保存先 : Cloud Firestore（登録アカウント間でリアルタイム共有）
   ・ビルド不要。Firebase SDK は CDN から直接読み込む。
   ============================================================ */

/* --- デモ版のための差し替え（ここだけが実運用版との違い） ---------------
   実運用版:
     import { initializeApp } from ".../firebase-app.js";
     import { getAuth, ... }   from ".../firebase-auth.js";
     import { getFirestore, ...} from ".../firebase-firestore.js";
     import { firebaseConfig } from "./firebase-config.js";
   デモ版では、この3つの読み込み先を firebase-mock.js に向けている。
   以降のコードは実運用版と1行も変わらない。
   -------------------------------------------------------------------- */
import {
  initializeApp,
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  getFirestore, collection, doc, getDoc, setDoc, deleteDoc, onSnapshot
} from "./firebase-mock.js";
const firebaseConfig = { apiKey: "demo-no-network" };

/* ---------- Firestore 上の置き場所 ----------
   events/{eventId}        … イベント1件＝ドキュメント1件（プラン・予算・実績を含む）
   app_settings/global     … 料金・費目の既定値（全員で共有）
   authorized_users/{uid}  … 利用を許可された人。登録はFirebaseコンソールから行う
   ------------------------------------------------------------
   仕様書ではプラン等をサブコレクションに分ける構成だったが、利用者が少数で
   データ量が小さい今回は「イベント1件＝1ドキュメント」にまとめている。
   読み取り回数が数十分の一になり無料枠に収まりやすく、リアルタイム同期も
   単純になるため。1ドキュメントの上限1MBに対し、実データは数十KB程度。
   ------------------------------------------------------------ */
const COL_EVENTS = "events";
const COL_SETTINGS = "app_settings";
const DOC_SETTINGS = "global";
const COL_USERS = "authorized_users";
const COL_INVITES = "authorized_emails";

const SAVE_DEBOUNCE_MS = 700;   // 入力が止まってから書き込むまでの待ち時間

let fbApp = null, auth = null, db = null;
let currentUser = null;
let unsubEvents = null, unsubSettings = null, unsubUsers = null, unsubInvites = null;

/* 編集中のイベントIDを覚えておき、相手の更新で自分の入力を消さないようにする */
const dirtyEvents = new Set();
const saveTimers = new Map();
let settingsTimer = null;
let settingsDirty = false;
let pendingRerender = false;
let inFlight = 0;

/* Firestore は undefined を受け付けないため、JSONを通して取り除く */
const clean = (o) => JSON.parse(JSON.stringify(o));

/* ---------- 保存状態の表示 ---------- */
function setSaveState(s, detail) {
  const el = document.getElementById("saveInd");
  if (!el) return;
  el.dataset.s = s;
  const label = { saving: "保存中…", saved: "保存済み", error: "保存できません", offline: "オフライン" }[s] || "保存済み";
  el.lastElementChild.textContent = label;
  el.title = detail || (s === "saved" ? "変更は自動で保存されます" : "");
}

/* ---------- イベントの保存 ---------- */
function scheduleSaveEvent(ev) {
  if (!ev || !db) return;
  dirtyEvents.add(ev.id);
  clearTimeout(saveTimers.get(ev.id));
  saveTimers.set(ev.id, setTimeout(() => flushEvent(ev.id), SAVE_DEBOUNCE_MS));
  setSaveState("saving");
}

async function flushEvent(id) {
  const ev = state.events.find(e => e.id === id);
  if (!ev) { dirtyEvents.delete(id); return; }
  inFlight++;
  try {
    ev.updated_at = Date.now();
    await setDoc(doc(db, COL_EVENTS, id), clean(ev));
    dirtyEvents.delete(id);
    if (--inFlight === 0) setSaveState("saved");
  } catch (e) {
    inFlight--;
    console.error("保存失敗", e);
    setSaveState("error", e.message);
    toast("保存できませんでした：" + friendlyError(e));
  }
}

/* 既存コードから呼ばれる保存フック（編集中のイベントを保存する） */
function commit() { scheduleSaveEvent(getEvent()); }

/* ---------- 設定の保存 ---------- */
function commitSettings() {
  if (!db) return;
  settingsDirty = true;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(flushSettings, SAVE_DEBOUNCE_MS);
  setSaveState("saving");
}
async function flushSettings() {
  inFlight++;
  try {
    await setDoc(doc(db, COL_SETTINGS, DOC_SETTINGS), clean(state.settings));
    settingsDirty = false;
    if (--inFlight === 0) setSaveState("saved");
  } catch (e) {
    inFlight--;
    console.error("設定の保存失敗", e);
    setSaveState("error", e.message);
    toast("設定を保存できませんでした：" + friendlyError(e));
  }
}

/* ---------- イベントの削除・一括保存 ---------- */
async function deleteEventRemote(id) {
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  dirtyEvents.delete(id);
  try {
    await deleteDoc(doc(db, COL_EVENTS, id));
  } catch (e) {
    console.error("削除失敗", e);
    toast("削除できませんでした：" + friendlyError(e));
  }
}
async function saveAllRemote() {
  setSaveState("saving");
  try {
    await setDoc(doc(db, COL_SETTINGS, DOC_SETTINGS), clean(state.settings));
    for (const ev of state.events) await setDoc(doc(db, COL_EVENTS, ev.id), clean(ev));
    setSaveState("saved");
  } catch (e) {
    setSaveState("error", e.message);
    toast("書き込めませんでした：" + friendlyError(e));
  }
}

function friendlyError(e) {
  const c = (e && e.code) || "";
  if (c.includes("permission-denied")) return "アクセス権がありません（利用者登録を確認してください）";
  if (c.includes("unavailable")) return "ネットワークに接続できません";
  return (e && e.message) || "不明なエラー";
}

/* ---------- 相手の変更を受け取る（リアルタイム同期） ---------- */
function startSync() {
  unsubEvents = onSnapshot(collection(db, COL_EVENTS), (snap) => {
    const remote = snap.docs.map(d => migrateEvent({ ...d.data(), id: d.id }));
    // 自分が編集中のイベントは、ローカルの内容を優先して残す
    const keepLocal = state.events.filter(e => dirtyEvents.has(e.id));
    const merged = remote.map(r => keepLocal.find(k => k.id === r.id) || r);
    for (const k of keepLocal) if (!merged.some(m => m.id === k.id)) merged.push(k);
    state.events = merged;
    if (ui.currentEventId && !state.events.some(e => e.id === ui.currentEventId)) {
      ui.currentEventId = state.events[0]?.id || null;
      ui.currentPlanId = null;
    }
    rerenderIfSafe();
  }, (err) => {
    console.error("同期エラー", err);
    setSaveState("error", err.message);
    toast("データを読み込めません：" + friendlyError(err));
  });

  unsubSettings = onSnapshot(doc(db, COL_SETTINGS, DOC_SETTINGS), (snap) => {
    if (!snap.exists() || settingsDirty) return;
    state.settings = migrateSettings({ ...defaultSettings(), ...snap.data() });
    if (ui.view === "settings") rerenderIfSafe();
  }, (err) => console.error("設定の同期エラー", err));

  // 利用者・招待メールの一覧（「料金・費目設定」の「利用者」パネルで使う）
  unsubUsers = onSnapshot(collection(db, COL_USERS), (snap) => {
    state.users = snap.docs.map(d => ({ ...d.data(), uid: d.id }));
    if (ui.view === "settings") rerenderIfSafe();
  }, (err) => console.error("利用者一覧の同期エラー", err));

  unsubInvites = onSnapshot(collection(db, COL_INVITES), (snap) => {
    state.invites = snap.docs.map(d => ({ ...d.data(), email: d.id }));
    if (ui.view === "settings") rerenderIfSafe();
  }, (err) => console.error("招待一覧の同期エラー", err));
}

/* 「更新」ボタン。
   通常は自動で同期されるが、通信が一時的に切れた場合などに
   接続を張り直して最新のデータを取り直す。 */
async function refreshNow() {
  const btn = document.getElementById("refreshBtn");
  if (btn) { btn.disabled = true; btn.textContent = "↻ 更新中…"; }
  try {
    // 保存待ちの入力があれば先に書き込む（更新で消えないように）
    for (const id of [...dirtyEvents]) {
      clearTimeout(saveTimers.get(id));
      await flushEvent(id);
    }
    if (settingsDirty) { clearTimeout(settingsTimer); await flushSettings(); }

    // 接続を張り直す
    if (unsubEvents) { unsubEvents(); unsubEvents = null; }
    if (unsubSettings) { unsubSettings(); unsubSettings = null; }
    if (unsubUsers) { unsubUsers(); unsubUsers = null; }
    if (unsubInvites) { unsubInvites(); unsubInvites = null; }
    dirtyEvents.clear();
    startSync();

    pendingRerender = false;
    toast("最新のデータに更新しました");
  } catch (e) {
    console.error("更新に失敗", e);
    toast("更新できませんでした：" + friendlyError(e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "↻ 更新"; }
  }
}

/* 入力中に再描画するとカーソルが飛ぶので、入力が終わるまで待つ */
const isTyping = () => {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA");
};
function rerenderIfSafe() {
  if (isTyping() || document.querySelector(".modal-scrim")) { pendingRerender = true; return; }
  pendingRerender = false;
  render();
}
document.addEventListener("focusout", () => {
  if (!pendingRerender) return;
  setTimeout(() => { if (!isTyping()) rerenderIfSafe(); }, 80);
});

/* ---------- 認証 ---------- */
function showGate(which) {
  document.getElementById("gate").hidden = false;
  document.getElementById("appShell").hidden = true;
  document.querySelectorAll("#gate [data-gate]").forEach(el => {
    el.hidden = el.dataset.gate !== which;
  });
}
function showApp(user) {
  document.getElementById("gate").hidden = true;
  document.getElementById("appShell").hidden = false;
  const chip = document.getElementById("userChip");
  if (chip) chip.textContent = user.email || "";
  setSaveState("saved");
}

/* 利用者確認。
   結果は3種類：allowed（許可） / denied（未登録・停止中） / error（そもそも届かない）
   無言で固まらないよう、10秒で打ち切って原因を画面に出す。
   authorized_users に無くても、自分宛てのメール招待(authorized_emails)が有効なら
   その場で自分のUIDを自己登録してallowedにする（招待メールでの事前登録に対応）。 */
async function isAuthorized(uid, email) {
  const timeout = new Promise((_, rej) =>
    setTimeout(() => {
      const e = new Error("応答がありません（10秒待っても返事が返ってきませんでした）");
      e.code = "timeout";
      rej(e);
    }, 10000));
  try {
    const s = await Promise.race([getDoc(doc(db, COL_USERS, uid)), timeout]);
    if (s.exists() && s.data().active !== false) return { result: "allowed" };

    if (email) {
      const inv = await Promise.race([getDoc(doc(db, COL_INVITES, email)), timeout]);
      if (inv.exists() && inv.data().active !== false) {
        await setDoc(doc(db, COL_USERS, uid), { email, active: true, created_at: Date.now() });
        return { result: "allowed" };
      }
    }
    return { result: "denied" };
  } catch (e) {
    console.error("利用者確認に失敗", e);
    if (e.code === "permission-denied") return { result: "denied" };
    return { result: "error", error: e };
  }
}

function showTrouble(e) {
  const hint = {
    "timeout":
      "データベースに接続できていません。次を確認してください。<br>" +
      "① Firebaseコンソールで <b>Firestore Database</b> が作成済みか<br>" +
      "② ターミナルで <b>npx firebase deploy</b> がエラーなく終わったか<br>" +
      "③ 通信環境（社内ネットワーク等で制限されていないか）",
    "unavailable": "ネットワークに接続できません。通信環境を確認してください。",
    "failed-precondition":
      "Firestoreデータベースがまだ作成されていない可能性があります。" +
      "Firebaseコンソールの「Firestore Database」→「データベースの作成」を確認してください。",
    "auth-timeout":
      "ログイン状態を確認できませんでした。次を確認してください。<br>" +
      "① ブラウザの拡張機能（広告ブロック等）が通信を止めていないか<br>" +
      "② シークレットウィンドウで開くと直るか<br>" +
      "③ Firebaseコンソールの「Authentication」で <b>Google</b> が有効か",
  }[e && e.code] || "アクセス制限のルールが反映されていない可能性があります。" +
      "ターミナルで <b>npx firebase deploy --only firestore:rules</b> を実行してみてください。";

  document.getElementById("troubleMsg").innerHTML = hint;
  document.getElementById("troubleDetail").textContent =
    (e && e.code ? "[" + e.code + "] " : "") + ((e && e.message) || String(e));
  showGate("trouble");
}

async function ensureSettingsDoc() {
  try {
    const ref = doc(db, COL_SETTINGS, DOC_SETTINGS);
    const s = await getDoc(ref);
    if (!s.exists()) await setDoc(ref, clean(defaultSettings()));
    else state.settings = migrateSettings({ ...defaultSettings(), ...s.data() });
  } catch (e) {
    console.warn("設定の初期化に失敗", e);
  }
}

function wireAuthButtons() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  document.getElementById("signInBtn")?.addEventListener("click", async () => {
    const err = document.getElementById("signinErr");
    err.hidden = true;
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      console.error(e);
      let m = "ログインできませんでした。";
      if (e.code === "auth/popup-blocked") m = "ポップアップがブロックされました。ブラウザの設定で許可してください。";
      else if (e.code === "auth/popup-closed-by-user") m = "ログイン画面が閉じられました。もう一度お試しください。";
      else if (e.code === "auth/unauthorized-domain") m = "このドメインは許可されていません。Firebaseの「Authentication → 設定 → 承認済みドメイン」を確認してください。";
      err.textContent = m; err.hidden = false;
    }
  });

  const doSignOut = async () => {
    if (unsubEvents) { unsubEvents(); unsubEvents = null; }
    if (unsubSettings) { unsubSettings(); unsubSettings = null; }
    if (unsubUsers) { unsubUsers(); unsubUsers = null; }
    if (unsubInvites) { unsubInvites(); unsubInvites = null; }
    state.events = []; state.users = []; state.invites = []; dirtyEvents.clear();
    await signOut(auth);
  };
  document.getElementById("signOutBtn")?.addEventListener("click", doSignOut);
  document.getElementById("signOutBtn2")?.addEventListener("click", doSignOut);
  document.getElementById("signOutBtn3")?.addEventListener("click", doSignOut);
  document.getElementById("retryBtn")?.addEventListener("click", () => location.reload());
  document.getElementById("refreshBtn")?.addEventListener("click", refreshNow);

  document.getElementById("copyUidBtn")?.addEventListener("click", async () => {
    const uid = document.getElementById("deniedUid").textContent.trim();
    try { await navigator.clipboard.writeText(uid); toast("UIDをコピーしました"); }
    catch (_) { toast("コピーできません。手で選択してコピーしてください"); }
  });
}

/* ---------- 起動 ---------- */
function boot() {
  wireAuthButtons();

  if (!firebaseConfig || !firebaseConfig.apiKey || String(firebaseConfig.apiKey).startsWith("ここに")) {
    showGate("config");
    document.getElementById("configMsg").innerHTML =
      "public/firebase-config.js に、Firebaseコンソールで取得した設定を貼り付けてください。<br>" +
      "手順は README.md の「STEP 4」に書いてあります。";
    return;
  }

  try {
    fbApp = initializeApp(firebaseConfig);
    auth = getAuth(fbApp);
    db = getFirestore(fbApp);
  } catch (e) {
    showGate("config");
    document.getElementById("configMsg").textContent = "Firebaseの初期化に失敗しました：" + e.message;
    return;
  }

  showGate("loading");

  /* ログイン状態の確認そのものが返らないケースを検出する
     （認証サーバーに到達できない・ブラウザが通信を遮断している 等） */
  let authAnswered = false;
  setTimeout(() => {
    if (!authAnswered) {
      const e = new Error("ログイン状態を確認できませんでした（認証サーバーから応答なし）");
      e.code = "auth-timeout";
      showTrouble(e);
    }
  }, 10000);

  onAuthStateChanged(auth, async (user) => {
    authAnswered = true;
    if (!user) { currentUser = null; showGate("signin"); return; }
    currentUser = user;
    showGate("loading");

    const check = await isAuthorized(user.uid, user.email);

    if (check.result === "error") { showTrouble(check.error); return; }

    if (check.result === "denied") {
      document.getElementById("deniedEmail").textContent = user.email || "(不明)";
      document.getElementById("deniedUid").textContent = user.uid;
      showGate("denied");
      return;
    }

    showApp(user);
    await ensureSettingsDoc();
    startSync();
    render();
  });
}

/* ============================================================
   イベント収支管理アプリ  (画面描画・計算ロジック)
   ============================================================ */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const ceil = Math.ceil;

/* ---------- 既定データ ---------- */
/* イベントの区分。未設定の既存イベントは「未分類」として扱う */
const UNCATEGORIZED = "未分類";
/* この区分のイベントはNCA用レイアウト（収入内訳・支出内訳）で入力する */
const NCA_CATEGORY = "NCA";
const isNCA = (ev) => ev && ev.category === NCA_CATEGORY;

function defaultSettings() {
  return {
    default_target_profit: 0,
    event_categories: ["合宿", "NCA"],
    room_defaults: [
      { room_type: "シングル", capacity: 1 },
      { room_type: "ツイン", capacity: 2 },
      { room_type: "トリプル", capacity: 3 },
      // 宿泊税は部屋ではないので定員0（宿泊定員に加算されない）
      { room_type: "宿泊税", capacity: 0 },
    ],
    meal_defaults: ["1日目 昼", "1日目 夜", "2日目 朝", "2日目 昼"],
    venue_defaults: ["会場費"],
    expense_templates: [
      { category: "交通費", name: "タクシー代" },
      { category: "備品費", name: "名札" },
      { category: "その他", name: "雑費" },
    ],
    // NCA用：収入の参加種別（プルダウン）
    nca_income_types: ["懇親会のみ参加", "セミナーのみ参加", "懇親会＋セミナー参加", "その他"],
    // NCA用：支出の区分（プルダウン）
    nca_expense_types: ["懇親会費用", "セミナー会場", "キャンセル料（懇親会）", "キャンセル料（セミナー）", "その他"],
  };
}

/* 保存済みの設定に、あとから追加した項目を補う。
   すでにFirestoreにある設定は defaultSettings で上書きされないため、
   不足分だけをここで足す。 */
function migrateSettings(s) {
  const d = defaultSettings();
  if (!Array.isArray(s.event_categories) || !s.event_categories.length) {
    s.event_categories = d.event_categories.slice();
  }
  if (!Array.isArray(s.venue_defaults)) s.venue_defaults = d.venue_defaults.slice();
  if (!Array.isArray(s.room_defaults)) s.room_defaults = d.room_defaults.slice();
  // 宿泊税が未登録なら追加する
  if (!s.room_defaults.some(r => r.room_type === "宿泊税")) {
    s.room_defaults.push({ room_type: "宿泊税", capacity: 0 });
  }
  if (!Array.isArray(s.nca_income_types) || !s.nca_income_types.length) s.nca_income_types = d.nca_income_types.slice();
  if (!Array.isArray(s.nca_expense_types) || !s.nca_expense_types.length) s.nca_expense_types = d.nca_expense_types.slice();
  return s;
}

/* 保存済みのイベントに、あとから追加した項目を補う */
function migrateEvent(ev) {
  if (typeof ev.category !== "string") ev.category = "";
  const fixBlock = (b) => {
    if (!b) return;
    if (!Array.isArray(b.venue_items)) b.venue_items = [];
    if (!Array.isArray(b.lodging_items)) b.lodging_items = [];
    if (!Array.isArray(b.meal_items)) b.meal_items = [];
    if (!Array.isArray(b.expense_items)) b.expense_items = [];
    if (!Array.isArray(b.lodging_cancels)) b.lodging_cancels = [];
    if (!Array.isArray(b.meal_cancels)) b.meal_cancels = [];
    if (!Array.isArray(b.venue_cancels)) b.venue_cancels = [];
    if (!Array.isArray(b.nca_income_items)) b.nca_income_items = [];
    if (!Array.isArray(b.nca_expense_items)) b.nca_expense_items = [];
  };
  (ev.plans || []).forEach(fixBlock);
  fixBlock(ev.budget_snapshot);
  fixBlock(ev.actual);
  return ev;
}

function newMealItems(settings) {
  return settings.meal_defaults.map((t, i) => ({
    id: uid(), timing: t, meal_count: 0, unit_price: 0, note: "", sort_order: i,
  }));
}

function newPlan(settings, name) {
  return {
    id: uid(),
    name: name || "新規プラン",
    paid_participant_count: 0,
    participation_fee: 0,
    other_income: 0,
    target_profit: settings.default_target_profit || 0,
    required_lodging_count: null,
    is_selected_budget: false,
    lodging_items: [],
    meal_items: newMealItems(settings),
    venue_items: [],
    expense_items: [],
    lodging_cancels: [],
    meal_cancels: [],
    venue_cancels: [],
    nca_income_items: [],
    nca_expense_items: [],
  };
}

/* キャンセル料のセクション対応表。
   キー(rt)→ 金額を足す小計 / 保存先の配列名 */
const CANCEL_MAP = {
  lc: { arr: "lodging_cancels", into: "lodging" },
  mc: { arr: "meal_cancels", into: "meals" },
  vc: { arr: "venue_cancels", into: "venue" },
};

function newEvent(settings, name, category) {
  const p = newPlan(settings, "標準プラン");
  return {
    id: uid(),
    name: name || "新規イベント",
    category: category || "",
    start_date: "",
    end_date: "",
    status: "試算中",
    default_target_profit: settings.default_target_profit || 0,
    plans: [p],
    budget_snapshot: null,
    actual: null,
    actual_confirmed: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

/* ---------- 状態 ----------
   実データは Firestore から流し込まれる（上の startSync を参照）。 */
let state = { settings: defaultSettings(), events: [], users: [], invites: [] };
let ui = { view: "events", currentEventId: null, currentPlanId: null, collapsed: {} };

/* ---------- 計算（仕様 §6） ---------- */
function calcBlock(block) {
  // block: { paid_participant_count, participation_fee, other_income, target_profit,
  //          required_lodging_count, lodging_items[], meal_items[], expense_items[] }
  const cancelSum = (arr) => (arr || []).reduce((s, r) => s + n(r.amount), 0);
  const lodgingCancel = cancelSum(block.lodging_cancels);
  const mealCancel = cancelSum(block.meal_cancels);
  const venueCancel = cancelSum(block.venue_cancels);

  const lodging = (block.lodging_items || []).reduce((s, r) => s + n(r.room_count) * n(r.unit_price), 0) + lodgingCancel;
  const lodgingCap = (block.lodging_items || []).reduce((s, r) => s + n(r.room_count) * n(r.capacity_per_room), 0);
  const meals = (block.meal_items || []).reduce((s, r) => s + n(r.meal_count) * n(r.unit_price), 0) + mealCancel;
  const venue = (block.venue_items || []).reduce((s, r) => s + n(r.quantity) * n(r.unit_price), 0) + venueCancel;
  const misc = (block.expense_items || []).reduce((s, r) => s + n(r.unit_price) * n(r.quantity), 0);

  // NCA用の収入・支出（合宿プランでは配列が空なので0になる）
  const ncaIncome = (block.nca_income_items || []).reduce((s, r) => s + n(r.count) * n(r.unit_price), 0);
  const ncaExpense = (block.nca_expense_items || []).reduce((s, r) => s + n(r.count) * n(r.unit_price), 0);

  const feeIncome = n(block.paid_participant_count) * n(block.participation_fee);
  const income = feeIncome + n(block.other_income) + ncaIncome;
  const expense = lodging + meals + venue + misc + ncaExpense;
  const net = income - expense;

  const fee = n(block.participation_fee);
  const breakeven = fee > 0 ? ceil(expense / fee) : null;

  const paid = n(block.paid_participant_count);
  const target = n(block.target_profit);
  const requiredFee = paid > 0 ? ceil((expense + target - n(block.other_income)) / paid) : null;

  const reqLodging = block.required_lodging_count;
  const lodgingShort = (reqLodging != null && reqLodging !== "" && n(reqLodging) > lodgingCap);

  return {
    feeIncome, income, lodging, lodgingCap, meals, venue, misc, expense, net,
    ncaIncome, ncaExpense,
    breakeven, requiredFee, lodgingShort,
    reqLodging: reqLodging == null || reqLodging === "" ? null : n(reqLodging),
    net_pos: net >= 0,
    targetMet: net >= target,
  };
}
const n = (v) => { const x = typeof v === "number" ? v : parseFloat(v); return isFinite(x) ? x : 0; };

/* ---------- フォーマット ---------- */
const fmt = (v) => (v == null || v === "" || !isFinite(v)) ? "—" : Math.round(v).toLocaleString("ja-JP");
function yen(v, opts = {}) {
  if (v == null || !isFinite(v)) return `<span class="num">—</span>`;
  const cls = opts.signed ? (v > 0 ? "pos" : v < 0 ? "neg" : "") : "";
  const sign = opts.signed && v > 0 ? "+" : "";
  return `<span class="num money ${cls}"><span class="yen">¥</span>${sign}${fmt(v)}</span>`;
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- ヘルパ：現在のイベント/プラン ---------- */
const getEvent = () => state.events.find(e => e.id === ui.currentEventId) || null;
function getPlan(ev) {
  if (!ev) return null;
  let p = ev.plans.find(p => p.id === ui.currentPlanId);
  if (!p) p = ev.plans[0];
  return p || null;
}

/* ============================================================
   レンダリング
   ============================================================ */
const app = document.getElementById("app");

function render() {
  // タブ活性
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === ui.view));
  if (ui.view === "events") renderEvents();
  else if (ui.view === "sim") renderSim();
  else if (ui.view === "actual") renderActual();
  else if (ui.view === "report") renderReport();
  else if (ui.view === "settings") renderSettings();
  else if (ui.view === "help") renderHelp();
}

/* ---------- 5.1 イベント一覧 ---------- */
function statusPill(s) {
  const map = { "試算中": "s-est", "予算確定": "s-budget", "実績入力中": "s-actual", "完了": "s-done" };
  return `<span class="pill ${map[s] || "s-est"}">${esc(s)}</span>`;
}
function eventNet(ev) {
  if (ev.budget_snapshot) return calcBlock(ev.budget_snapshot).net;
  const sel = ev.plans.find(p => p.is_selected_budget) || ev.plans[0];
  return sel ? calcBlock(sel).net : 0;
}
function renderEvents() {
  const sort = ui.eventSort || (ui.eventSort = "date-desc");
  const dateOf = (e) => e.start_date || "";
  const sorters = {
    "date-desc": (a, b) => dateOf(b).localeCompare(dateOf(a)) || (b.updated_at || 0) - (a.updated_at || 0),
    "date-asc": (a, b) => dateOf(a).localeCompare(dateOf(b)) || (a.updated_at || 0) - (b.updated_at || 0),
    "updated": (a, b) => (b.updated_at || 0) - (a.updated_at || 0),
  };
  const evs = [...state.events].sort(sorters[sort] || sorters["date-desc"]);

  let h = `<div class="section-head">
      <h2>イベント一覧</h2><span class="count">${evs.length}件</span>
      <span class="spacer"></span>
      <label class="sort-label" for="evSort">並び替え</label>
      <select class="in" id="evSort" data-act="sort-events">
        <option value="date-desc" ${sort === "date-desc" ? "selected" : ""}>開催日が新しい順</option>
        <option value="date-asc" ${sort === "date-asc" ? "selected" : ""}>開催日が古い順</option>
        <option value="updated" ${sort === "updated" ? "selected" : ""}>更新した順</option>
      </select>
      <button class="btn sm" data-act="import-sheet">スプレッドシートから取り込む</button>
      <button class="btn primary" data-act="new-event">＋ 新規イベント</button>
    </div>`;

  if (!evs.length) {
    h += `<div class="empty"><h3>まだイベントがありません</h3>
      <div>「新規イベント」からプランの試算を始めましょう。</div></div>`;
    app.innerHTML = h + footnote();
    return;
  }

  /* 区分ごとに分けて表示する。設定にある区分を先に並べ、
     区分が未設定のイベントは「未分類」としてまとめる。 */
  const order = [...(state.settings.event_categories || []), UNCATEGORIZED];
  const groups = new Map(order.map(c => [c, []]));
  for (const ev of evs) {
    const cat = ev.category || UNCATEGORIZED;
    if (!groups.has(cat)) groups.set(cat, []);   // 設定から消された区分も表示は残す
    groups.get(cat).push(ev);
  }

  for (const [cat, list] of groups) {
    if (!list.length) continue;
    h += `<div class="cat-head">
        <span class="cat-name">${esc(cat)}</span>
        <span class="cat-count">${list.length}件</span>
        <span class="cat-rule"></span>
      </div>`;
    h += `<div class="ev-grid">`;
    for (const ev of list) {
      const budgetNet = eventNet(ev);
      const actualNet = ev.actual ? calcBlock(ev.actual).net : null;
      const dates = ev.start_date ? esc(ev.start_date) + (ev.end_date && ev.end_date !== ev.start_date ? " → " + esc(ev.end_date) : "") : "日程未設定";
      h += `<div class="ev-card" data-act="open-event" data-id="${ev.id}">
        <div class="ev-actions">
          <button class="icon-btn" data-act="dup-event" data-id="${ev.id}" title="複製">⧉</button>
          <button class="icon-btn del" data-act="del-event" data-id="${ev.id}" title="削除">🗑</button>
        </div>
        <div class="ev-top">
          <h3>${esc(ev.name)}</h3>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
          ${statusPill(ev.status)}
          <span class="date">${dates}</span>
        </div>
        <div class="ev-metrics">
          <div class="ev-metric">
            <div class="lbl">採用予算 収支</div>
            <div class="val money ${budgetNet >= 0 ? "pos" : "neg"} num">${budgetNet >= 0 ? "" : "−"}¥${fmt(Math.abs(budgetNet))}</div>
          </div>
          <div class="ev-metric">
            <div class="lbl">実績 収支</div>
            <div class="val num ${actualNet == null ? "" : "money " + (actualNet >= 0 ? "pos" : "neg")}" style="${actualNet == null ? "color:var(--ink-3);font-weight:500;font-size:14px" : ""}">
              ${actualNet == null ? "未入力" : (actualNet >= 0 ? "" : "−") + "¥" + fmt(Math.abs(actualNet))}</div>
          </div>
        </div>
      </div>`;
    }
    h += `</div>`;
  }
  h += footnote();
  app.innerHTML = h;
}

/* ---------- 5.2 / 5.3 収支シミュレーション ---------- */
function eventSelector() {
  if (!state.events.length) return "";
  const ev = getEvent();
  let opts = state.events.map(e => `<option value="${e.id}" ${e.id === ui.currentEventId ? "selected" : ""}>${esc(e.name)}</option>`).join("");
  return `<div class="ctx-bar">
      <select data-act="switch-event">${opts}</select>
      ${ev ? statusPill(ev.status) : ""}
      <span class="spacer" style="flex:1"></span>
      <button class="btn sm" data-act="import-sheet">スプレッドシートから取り込む</button>
      ${ev ? `<button class="btn sm" data-act="rename-event" data-id="${ev.id}">イベント名 · 日程</button>` : ""}
    </div>`;
}

function renderSim() {
  if (!state.events.length) {
    app.innerHTML = noEventEmpty(); return;
  }
  if (!ui.currentEventId) ui.currentEventId = state.events[0].id;
  const ev = getEvent();
  const plan = getPlan(ev);
  if (plan) ui.currentPlanId = plan.id;
  const c = plan ? calcBlock(plan) : null;

  let h = eventSelector();

  const nca = isNCA(ev);

  // サマリー（選択中プラン）
  if (plan) {
    if (nca) {
      // NCAは収入・支出・収支の3つだけ（参加費が複数種類あり損益分岐は一意に決まらない）
      h += `<div class="summary summary-3">
        <div class="cell"><div class="lbl">収入</div><div class="val">${yen(c.income)}</div>
          <div class="sub">収入内訳の合計</div></div>
        <div class="cell"><div class="lbl">支出</div><div class="val">${yen(c.expense)}</div>
          <div class="sub">支出内訳の合計</div></div>
        <div class="cell hl"><div class="lbl">収支</div><div class="val money ${c.net >= 0 ? "pos" : "neg"} num">${c.net < 0 ? "−" : ""}<span class="yen">¥</span>${fmt(Math.abs(c.net))}</div>
          <div class="sub">目標利益 ${fmt(n(plan.target_profit))}</div></div>
      </div>`;
    } else {
      h += `<div class="summary">
        <div class="cell"><div class="lbl">収入</div><div class="val">${yen(c.income)}</div>
          <div class="sub">参加費 ${fmt(c.feeIncome)} ／ その他 ${fmt(n(plan.other_income))}</div></div>
        <div class="cell"><div class="lbl">支出</div><div class="val">${yen(c.expense)}</div>
          <div class="sub">宿泊 ${fmt(c.lodging)}・食事 ${fmt(c.meals)}・費目 ${fmt(c.misc)}</div></div>
        <div class="cell hl"><div class="lbl">収支</div><div class="val money ${c.net >= 0 ? "pos" : "neg"} num">${c.net < 0 ? "−" : ""}<span class="yen">¥</span>${fmt(Math.abs(c.net))}</div>
          <div class="sub">目標利益 ${fmt(n(plan.target_profit))}</div></div>
        <div class="cell"><div class="lbl">損益分岐人数</div><div class="val num">${c.breakeven == null ? "—" : c.breakeven + "<span class='yen'> 名</span>"}</div>
          <div class="sub">${c.breakeven == null ? "参加費が0のため計算不可" : "参加費 " + fmt(n(plan.participation_fee)) + " で"}</div></div>
        <div class="cell"><div class="lbl">目標達成の必要参加費</div><div class="val num">${c.requiredFee == null ? "—" : "<span class='yen'>¥</span>" + fmt(c.requiredFee)}</div>
          <div class="sub">${c.requiredFee == null ? "有料参加者が0のため計算不可" : "現在 " + fmt(n(plan.participation_fee))}</div></div>
      </div>`;
    }

    // 警告
    let alerts = "";
    if (c.net < 0) alerts += alertBox("neg", "⚠", `赤字警告：収支が ${yen(c.net, { signed: true })} です。`);
    if (c.net >= 0 && !c.targetMet) alerts += alertBox("warn", "△", `目標利益 未達：目標 ¥${fmt(n(plan.target_profit))} に対し収支は ¥${fmt(c.net)}（あと ¥${fmt(n(plan.target_profit) - c.net)}）。`);
    if (c.lodgingShort) alerts += alertBox("warn", "🛏", `宿泊定員 不足：必要 ${c.reqLodging}名 に対し定員 ${c.lodgingCap}名（${c.reqLodging - c.lodgingCap}名不足）。`);
    if (alerts) h += `<div class="alerts">${alerts}</div>`; else h += `<div style="height:12px"></div>`;
  }

  // プラン比較表（全プランを一覧で比較）
  h += `<div class="section-head" style="margin-bottom:10px"><h2 style="font-size:16px">プラン比較</h2>
    <span class="count">${ev.plans.length}プラン</span>
    <span class="spacer" style="flex:1"></span>
    <span style="font-size:12px;color:var(--ink-3)">行をクリックすると、そのプランがサマリーに反映されます</span></div>`;
  h += `<div class="ov-wrap"><table class="ov">
      <thead><tr><th class="l">プラン</th><th>有料参加者数</th><th>参加費</th><th>収入</th><th>支出</th><th>収支</th>${nca ? "" : "<th>損益分岐</th><th>必要参加費</th>"}</tr></thead>
      <tbody id="ovBody">${overviewRows(ev)}</tbody></table></div>`;

  // プラン詳細（縦リスト）
  h += `<div class="section-head" style="margin-bottom:10px"><h2 style="font-size:16px">プラン詳細</h2>
    <span class="spacer" style="flex:1"></span>
    <button class="btn sm" data-act="toggle-all-plans">すべて開く／閉じる</button></div>`;
  h += `<div class="plan-list">`;
  for (const p of ev.plans) h += planCard(ev, p);
  h += `</div>`;
  h += `<button class="plan-add" data-act="add-plan"><span class="plus">＋</span>プランを追加
    <span class="plan-add-note">直前のプランをコピーします</span></button>`;
  h += footnote();
  app.innerHTML = h;
}

function alertBox(kind, ico, msg) {
  return `<div class="alert ${kind}"><span class="ico">${ico}</span><span>${msg}</span></div>`;
}

function overviewRows(ev) {
  const nca = isNCA(ev);
  return ev.plans.map(p => {
    const c = calcBlock(p);
    return `<tr class="${p.id === ui.currentPlanId ? "is-sel" : ""}" data-act="select-plan" data-id="${p.id}">
      <td class="l"><span class="pname">${esc(p.name)}
        ${p.is_selected_budget ? `<span class="pill s-budget">採用予算</span>` : ""}</span></td>
      <td>${nca ? "—" : fmt(n(p.paid_participant_count)) + " 名"}</td>
      <td>${nca ? "—" : yen(n(p.participation_fee))}</td>
      <td>${yen(c.income)}</td>
      <td>${yen(c.expense)}</td>
      <td class="net"><span class="money ${c.net >= 0 ? "pos" : "neg"} num">${c.net < 0 ? "−" : ""}¥${fmt(Math.abs(c.net))}</span></td>
      ${nca ? "" : `<td>${c.breakeven == null ? "—" : c.breakeven + " 名"}</td>
      <td>${c.requiredFee == null ? "—" : "¥" + fmt(c.requiredFee)}</td>`}
    </tr>`;
  }).join("");
}

function planCard(ev, p) {
  const c = calcBlock(p);
  const sel = p.id === ui.currentPlanId;
  const isCollapsed = ui.collapsed[p.id] === true;

  // 宿泊行
  const lodgingRows = p.lodging_items.map(r => `<tr data-rid="${r.id}">
      <td><input class="in text" data-f="hotel_name" data-rt="lodging" data-rid="${r.id}" value="${esc(r.hotel_name)}" placeholder="Aホテル"></td>
      <td>${roomTypeSelect(r.room_type, "lodging", r.id)}</td>
      <td><input class="in num" data-f="capacity_per_room" data-rt="lodging" data-rid="${r.id}" value="${esc(r.capacity_per_room)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="room_count" data-rt="lodging" data-rid="${r.id}" value="${esc(r.room_count)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="unit_price" data-rt="lodging" data-rid="${r.id}" value="${esc(r.unit_price)}" inputmode="numeric"></td>
      <td class="amt" data-rowamt="${r.id}">${fmt(n(r.room_count) * n(r.unit_price))}</td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-row" data-rt="lodging" data-rid="${r.id}" title="この行を削除">×</button></td>
    </tr>`).join("");

  // 食事行
  const mealRows = p.meal_items.map(r => `<tr data-rid="${r.id}">
      <td><input class="in text" data-f="timing" data-rt="meal" data-rid="${r.id}" value="${esc(r.timing)}" placeholder="1日目 昼"></td>
      <td><input class="in num" data-f="meal_count" data-rt="meal" data-rid="${r.id}" value="${esc(r.meal_count)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="unit_price" data-rt="meal" data-rid="${r.id}" value="${esc(r.unit_price)}" inputmode="numeric"></td>
      <td><input class="in text" data-f="note" data-rt="meal" data-rid="${r.id}" value="${esc(r.note)}" placeholder="メモ"></td>
      <td class="amt" data-rowamt="${r.id}">${fmt(n(r.meal_count) * n(r.unit_price))}</td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-row" data-rt="meal" data-rid="${r.id}" title="この行を削除">×</button></td>
    </tr>`).join("");

  // 会場行
  const venueRows = (p.venue_items || []).map(r => `<tr data-rid="${r.id}">
      <td><input class="in" type="date" data-f="date" data-rt="venue" data-rid="${r.id}" value="${esc(r.date)}"></td>
      <td><input class="in text" data-f="name" data-rt="venue" data-rid="${r.id}" value="${esc(r.name)}" placeholder="別館 / BERTH 1+2"></td>
      <td><input class="in text" data-f="note" data-rt="venue" data-rid="${r.id}" value="${esc(r.note)}" placeholder="9:00〜22:00／終日"></td>
      <td><input class="in num" data-f="quantity" data-rt="venue" data-rid="${r.id}" value="${esc(r.quantity)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="unit_price" data-rt="venue" data-rid="${r.id}" value="${esc(r.unit_price)}" inputmode="numeric"></td>
      <td class="amt" data-rowamt="${r.id}">${fmt(n(r.quantity) * n(r.unit_price))}</td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-row" data-rt="venue" data-rid="${r.id}" title="この行を削除">×</button></td>
    </tr>`).join("");

  // 任意費目行
  const expRows = p.expense_items.map(r => `<tr data-rid="${r.id}">
      <td><input class="in text" data-f="category" data-rt="expense" data-rid="${r.id}" value="${esc(r.category)}" placeholder="交通費"></td>
      <td><input class="in text" data-f="name" data-rt="expense" data-rid="${r.id}" value="${esc(r.name)}" placeholder="タクシー代"></td>
      <td><input class="in num" data-f="unit_price" data-rt="expense" data-rid="${r.id}" value="${esc(r.unit_price)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="quantity" data-rt="expense" data-rid="${r.id}" value="${esc(r.quantity)}" inputmode="numeric"></td>
      <td><input class="in text" data-f="note" data-rt="expense" data-rid="${r.id}" value="${esc(r.note)}" placeholder="メモ"></td>
      <td class="amt" data-rowamt="${r.id}">${fmt(n(r.unit_price) * n(r.quantity))}</td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-row" data-rt="expense" data-rid="${r.id}" title="この行を削除">×</button></td>
    </tr>`).join("");

  const lodgingCancel = cancelBlock(p.lodging_cancels, "lc", "add-cancel", p.id);
  const mealCancel = cancelBlock(p.meal_cancels, "mc", "add-cancel", p.id);
  const venueCancel = cancelBlock(p.venue_cancels, "vc", "add-cancel", p.id);

  // NCA用の収入内訳・支出内訳
  const ncaIncomeRows = (p.nca_income_items || []).map(r => `<tr data-rid="${r.id}">
      <td>${ncaTypeSelect(r.kind, state.settings.nca_income_types, "nca-income", r.id)}</td>
      <td><input class="in num" data-f="count" data-rt="nca-income" data-rid="${r.id}" value="${esc(r.count)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="unit_price" data-rt="nca-income" data-rid="${r.id}" value="${esc(r.unit_price)}" inputmode="numeric"></td>
      <td><input class="in text" data-f="note" data-rt="nca-income" data-rid="${r.id}" value="${esc(r.note)}" placeholder="メモ"></td>
      <td class="amt" data-rowamt="${r.id}">${fmt(n(r.count) * n(r.unit_price))}</td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-row" data-rt="nca-income" data-rid="${r.id}" title="この行を削除">×</button></td>
    </tr>`).join("");
  const ncaExpenseRows = (p.nca_expense_items || []).map(r => `<tr data-rid="${r.id}">
      <td>${ncaTypeSelect(r.category, state.settings.nca_expense_types, "nca-expense", r.id)}</td>
      <td><input class="in text" data-f="name" data-rt="nca-expense" data-rid="${r.id}" value="${esc(r.name)}" placeholder="名目・内容"></td>
      <td><input class="in num" data-f="count" data-rt="nca-expense" data-rid="${r.id}" value="${esc(r.count)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="unit_price" data-rt="nca-expense" data-rid="${r.id}" value="${esc(r.unit_price)}" inputmode="numeric"></td>
      <td><input class="in text" data-f="note" data-rt="nca-expense" data-rid="${r.id}" value="${esc(r.note)}" placeholder="メモ"></td>
      <td class="amt" data-rowamt="${r.id}">${fmt(n(r.count) * n(r.unit_price))}</td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-row" data-rt="nca-expense" data-rid="${r.id}" title="この行を削除">×</button></td>
    </tr>`).join("");

  // 区分に応じて、プラン本体の入力欄を切り替える
  const body = isNCA(ev)
    ? `<!-- 基本（NCA） -->
      <div class="basic-row" style="grid-template-columns:none;display:flex;gap:14px;flex-wrap:wrap">
        <div class="fld" style="max-width:200px"><label>目標利益</label>
          <input class="in num" data-f="target_profit" data-rt="plan" data-rid="${p.id}" value="${esc(p.target_profit)}" inputmode="numeric"></div>
      </div>

      <!-- 収入内訳 -->
      <div class="sec">
        <div class="sec-head"><span class="st">収入内訳</span><span class="stot num" data-grptot="ncaincome-${p.id}">¥${fmt(c.ncaIncome)}</span></div>
        ${(p.nca_income_items || []).length ? `<div class="lines-wrap"><table class="lines">
          <colgroup><col style="width:28%"><col style="width:12%"><col style="width:16%"><col style="width:24%"><col style="width:16%"><col style="width:34px"></colgroup>
          <thead><tr><th class="l">参加種別</th><th>人数</th><th>単価</th><th class="l">メモ</th><th>金額</th><th></th></tr></thead>
          <tbody>${ncaIncomeRows}</tbody></table></div>` : `<div class="cap-note">収入の行がありません。</div>`}
        <div class="add-line"><button class="btn sm" data-act="add-nca-income" data-id="${p.id}">＋ 収入を追加</button></div>
      </div>

      <!-- 支出内訳 -->
      <div class="sec">
        <div class="sec-head"><span class="st">支出内訳</span><span class="stot num" data-grptot="ncaexpense-${p.id}">¥${fmt(c.ncaExpense)}</span></div>
        ${(p.nca_expense_items || []).length ? `<div class="lines-wrap"><table class="lines">
          <colgroup><col style="width:24%"><col style="width:22%"><col style="width:9%"><col style="width:15%"><col style="width:16%"><col style="width:14%"><col style="width:34px"></colgroup>
          <thead><tr><th class="l">区分</th><th class="l">名目・内容</th><th>数量</th><th>単価</th><th class="l">メモ</th><th>金額</th><th></th></tr></thead>
          <tbody>${ncaExpenseRows}</tbody></table></div>` : `<div class="cap-note">支出の行がありません。</div>`}
        <div class="add-line"><button class="btn sm" data-act="add-nca-expense" data-id="${p.id}">＋ 支出を追加</button></div>
      </div>`
    : `<!-- 基本（合宿） -->
      <div class="basic-row">
        <div class="fld"><label>有料参加者数</label>
          <input class="in num" data-f="paid_participant_count" data-rt="plan" data-rid="${p.id}" value="${esc(p.paid_participant_count)}" inputmode="numeric"></div>
        <div class="fld"><label>参加費</label>
          <input class="in num" data-f="participation_fee" data-rt="plan" data-rid="${p.id}" value="${esc(p.participation_fee)}" inputmode="numeric"></div>
        <div class="fld"><label>その他収入</label>
          <input class="in num" data-f="other_income" data-rt="plan" data-rid="${p.id}" value="${esc(p.other_income)}" inputmode="numeric"></div>
        <div class="fld"><label>目標利益</label>
          <input class="in num" data-f="target_profit" data-rt="plan" data-rid="${p.id}" value="${esc(p.target_profit)}" inputmode="numeric"></div>
      </div>
      ${gassukuSections(p, c, lodgingRows, mealRows, venueRows, expRows, lodgingCancel, mealCancel, venueCancel)}`;

  return `<div class="plan-card ${sel ? "selected" : ""} ${isCollapsed ? "collapsed" : ""}" data-plan="${p.id}">
    <div class="plan-head" data-act="toggle-plan" data-id="${p.id}">
      <span class="chev-main">▾</span>
      <input class="name" data-f="name" data-rt="plan" data-rid="${p.id}" value="${esc(p.name)}" placeholder="プラン名">
      ${p.is_selected_budget ? `<span class="pill s-budget">採用予算</span>` : (sel ? `<span class="pill s-est">選択中</span>` : "")}
      <div class="plan-stats">
        <div class="plan-stat"><span class="l">収入</span><span class="v num" data-planinc="${p.id}">¥${fmt(c.income)}</span></div>
        <div class="plan-stat"><span class="l">支出</span><span class="v num" data-planexp="${p.id}">¥${fmt(c.expense)}</span></div>
        <div class="plan-stat net"><span class="l">収支</span>
          <span class="v money ${c.net >= 0 ? "pos" : "neg"} num" data-plannet="${p.id}">${c.net < 0 ? "−" : ""}¥${fmt(Math.abs(c.net))}</span></div>
      </div>
      <div class="plan-head-acts">
        <button class="icon-btn" data-act="dup-plan" data-id="${p.id}" title="複製">⧉</button>
        <button class="icon-btn del" data-act="del-plan" data-id="${p.id}" title="削除">🗑</button>
      </div>
    </div>

    <div class="plan-body">
      ${body}
    </div>

    <div class="plan-foot">
      <button class="btn sm primary" data-act="adopt-plan" data-id="${p.id}">採用して予算へ反映</button>
      <button class="btn sm" data-act="select-plan" data-id="${p.id}">上部サマリーに表示</button>
    </div>
  </div>`;
}

/* 合宿プランの4セクション（宿泊・食事・会場・任意費目） */
function gassukuSections(p, c, lodgingRows, mealRows, venueRows, expRows, lodgingCancel, mealCancel, venueCancel) {
  return `
      <!-- 宿泊 -->
      <div class="sec">
        <div class="sec-head"><span class="st">宿泊</span><span class="stot num" data-grptot="lodging-${p.id}">¥${fmt(c.lodging)}</span></div>
        ${p.lodging_items.length ? `<div class="lines-wrap"><table class="lines">
          <colgroup><col style="width:22%"><col style="width:20%"><col style="width:9%"><col style="width:9%"><col style="width:15%"><col style="width:15%"><col style="width:34px"></colgroup>
          <thead><tr><th class="l">ホテル名</th><th class="l">部屋タイプ</th><th>1室定員</th><th>室数</th><th>1室単価</th><th>金額</th><th></th></tr></thead>
          <tbody>${lodgingRows}</tbody></table></div>` : `<div class="cap-note">宿泊行がありません。</div>`}
        <div class="add-line"><button class="btn sm" data-act="add-lodging" data-id="${p.id}">＋ 宿泊行を追加</button>${lodgingCancel.btn}</div>
        ${lodgingCancel.table}
        <div class="field-row" style="margin-top:10px"><label>必要宿泊人数</label>
          <input class="in num" data-f="required_lodging_count" data-rt="plan" data-rid="${p.id}" value="${p.required_lodging_count == null ? "" : esc(p.required_lodging_count)}" inputmode="numeric" placeholder="未設定"></div>
        <div data-capnote="${p.id}">${capNoteHtml(c)}</div>
      </div>

      <!-- 食事 -->
      <div class="sec">
        <div class="sec-head"><span class="st">食事</span><span class="stot num" data-grptot="meal-${p.id}">¥${fmt(c.meals)}</span></div>
        ${p.meal_items.length ? `<div class="lines-wrap"><table class="lines">
          <colgroup><col style="width:24%"><col style="width:10%"><col style="width:15%"><col style="width:26%"><col style="width:15%"><col style="width:34px"></colgroup>
          <thead><tr><th class="l">タイミング</th><th>食数</th><th>単価</th><th class="l">メモ</th><th>金額</th><th></th></tr></thead>
          <tbody>${mealRows}</tbody></table></div>` : `<div class="cap-note">食事行がありません。</div>`}
        <div class="add-line"><button class="btn sm" data-act="add-meal" data-id="${p.id}">＋ 食事を追加</button>${mealCancel.btn}</div>
        ${mealCancel.table}
      </div>

      <!-- 会場 -->
      <div class="sec">
        <div class="sec-head"><span class="st">会場</span><span class="stot num" data-grptot="venue-${p.id}">¥${fmt(c.venue)}</span></div>
        ${(p.venue_items || []).length ? `<div class="lines-wrap"><table class="lines">
          <colgroup><col style="width:15%"><col style="width:28%"><col style="width:19%"><col style="width:7%"><col style="width:14%"><col style="width:14%"><col style="width:34px"></colgroup>
          <thead><tr><th class="l">日付</th><th class="l">利用会場・項目</th><th class="l">利用時間・内容</th><th>数量</th><th>単価</th><th>金額</th><th></th></tr></thead>
          <tbody>${venueRows}</tbody></table></div>` : `<div class="cap-note">会場行がありません。</div>`}
        <div class="add-line"><button class="btn sm" data-act="add-venue" data-id="${p.id}">＋ 会場を追加</button>${venueCancel.btn}</div>
        ${venueCancel.table}
      </div>

      <!-- 任意費目 -->
      <div class="sec">
        <div class="sec-head"><span class="st">任意費目</span><span class="stot num" data-grptot="expense-${p.id}">¥${fmt(c.misc)}</span></div>
        ${p.expense_items.length ? `<div class="lines-wrap"><table class="lines">
          <colgroup><col style="width:15%"><col style="width:24%"><col style="width:14%"><col style="width:9%"><col style="width:22%"><col style="width:14%"><col style="width:34px"></colgroup>
          <thead><tr><th class="l">区分</th><th class="l">項目名</th><th>単価</th><th>数量</th><th class="l">メモ</th><th>金額</th><th></th></tr></thead>
          <tbody>${expRows}</tbody></table></div>` : `<div class="cap-note">費目行がありません。</div>`}
        <div class="add-line"><button class="btn sm" data-act="add-expense" data-id="${p.id}">＋ 費目を追加</button></div>
      </div>`;
}

/* NCA用のプルダウン（参加種別・支出区分）。設定の一覧から作り、既存の独自値も残す。 */
function ncaTypeSelect(current, types, rt, rid) {
  const cur = current == null ? "" : String(current);
  const list = (types || []).slice();
  if (cur && !list.includes(cur)) list.unshift(cur);
  const opts = list.map(nm => `<option value="${esc(nm)}" ${nm === cur ? "selected" : ""}>${esc(nm)}</option>`).join("");
  return `<select class="in text" data-f="${rt === "nca-income" || rt === "a-nca-income" ? "kind" : "category"}" data-rt="${rt}" data-rid="${rid}">
    <option value="" ${cur === "" ? "selected" : ""}>未選択</option>${opts}
  </select>`;
}

/* 部屋タイプのプルダウン。
   選択肢は「料金・費目設定」の部屋タイプ一覧から作る。
   過去に入力した独自の名称も選択肢として残し、データが消えないようにする。 */
function roomTypeSelect(current, rt, rid) {
  const cur = current == null ? "" : String(current);
  const names = state.settings.room_defaults.map(d => d.room_type).filter(Boolean);
  if (cur && !names.includes(cur)) names.unshift(cur);      // 一覧に無い既存値を保持
  const opts = names.map(nm =>
    `<option value="${esc(nm)}" ${nm === cur ? "selected" : ""}>${esc(nm)}</option>`).join("");
  return `<select class="in text" data-f="room_type" data-rt="${rt}" data-rid="${rid}">
    <option value="" ${cur === "" ? "selected" : ""}>未選択</option>${opts}
  </select>`;
}

/* キャンセル料の明細ブロックを作る。
   rt: 入力欄の種別（プラン=lc/mc/vc、実績=a-lc/a-mc/a-vc）
   addAct: 追加ボタンのアクション名 */
function cancelBlock(items, rt, addAct, id) {
  const rows = (items || []).map(r => `<tr data-rid="${r.id}">
      <td><input class="in text" data-f="name" data-rt="${rt}" data-rid="${r.id}" value="${esc(r.name)}" placeholder="例：直前キャンセル分"></td>
      <td><input class="in num" data-f="amount" data-rt="${rt}" data-rid="${r.id}" value="${esc(r.amount)}" inputmode="numeric"></td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-cancel" data-rt="${rt}" data-rid="${r.id}" title="この行を削除">×</button></td>
    </tr>`).join("");
  const table = (items || []).length ? `<div class="lines-wrap"><table class="lines cancel">
      <colgroup><col><col style="width:24%"><col style="width:34px"></colgroup>
      <thead><tr><th class="l">キャンセル料の名目</th><th>金額</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : "";
  const btn = `<button class="btn sm cancel-add" data-act="${addAct}" ${id ? `data-id="${id}"` : ""} data-sec="${rt}">＋ キャンセル料</button>`;
  return { table, btn };
}

function capNoteHtml(c) {
  return c.reqLodging == null
    ? `<div class="cap-note">宿泊定員 <b>${c.lodgingCap}</b>名（必要宿泊人数 未設定）</div>`
    : `<div class="cap-note ${c.lodgingShort ? "cap-warn" : ""}">宿泊定員 <b>${c.lodgingCap}</b>名 ／ 必要 <b>${c.reqLodging}</b>名 ${c.lodgingShort ? "— 定員不足" : "✓"}</div>`;
}

/* ---------- 5.4 実績管理 ---------- */
function renderActual() {
  if (!state.events.length) { app.innerHTML = noEventEmpty(); return; }
  if (!ui.currentEventId) ui.currentEventId = state.events[0].id;
  const ev = getEvent();

  let h = eventSelector();

  if (!ev.budget_snapshot) {
    h += `<div class="empty"><h3>予算が未確定です</h3>
      <div>「収支シミュレーション」でプランを<b>採用して予算へ反映</b>すると、<br>ここで実績と比較できるようになります。</div>
      <div style="margin-top:16px"><button class="btn primary" data-act="goto-sim">シミュレーションへ</button></div></div>`;
    app.innerHTML = h + footnote();
    return;
  }

  const b = calcBlock(ev.budget_snapshot);
  const a = calcBlock(ev.actual || emptyActual());

  // 比較表
  const row = (label, bv, av, isTotal, invert) => {
    const diff = av - bv;
    // 収入系は増=良(pos)、費用系は減=良。net は増=良。invert=true で費用系
    let cls = "";
    if (diff !== 0) {
      const good = invert ? diff < 0 : diff > 0;
      cls = good ? "pos" : "neg";
    }
    return `<tr class="${isTotal ? "total" : ""}">
      <td class="l rowlabel">${label}</td>
      <td class="col-budget">${yen(bv)}</td>
      <td>${yen(av)}</td>
      <td class="diff ${cls}">${diff === 0 ? yen(0) : yen(diff, { signed: true })}</td>
    </tr>`;
  };

  h += `<div style="display:flex;flex-direction:column;gap:20px">
    <div>
      <div class="cmp-wrap">
        <table class="cmp">
          <thead><tr><th class="l">指標</th><th>予算</th><th>実績</th><th>差額</th></tr></thead>
          <tbody>
            ${row("収入", b.income, a.income, false, false)}
            ${isNCA(ev) ? "" : `
            ${row("宿泊費", b.lodging, a.lodging, false, true)}
            ${row("食事費", b.meals, a.meals, false, true)}
            ${row("会場費", b.venue, a.venue, false, true)}
            ${row("任意費目", b.misc, a.misc, false, true)}`}
            ${row("支出", b.expense, a.expense, true, true)}
            ${row("収支", b.net, a.net, true, false)}
          </tbody>
        </table>
      </div>
      <div style="font-size:12px;color:var(--ink-3);margin-top:10px">
        予算スナップショット：採用元プラン「${esc(ev.budget_snapshot.source_plan_name || "—")}」（${new Date(ev.budget_snapshot.snapshot_at || Date.now()).toLocaleDateString("ja-JP")} 確定）<br>
        差額の色：収入・収支は増加が黒字寄り、各費用は減少が黒字寄りで表示。
      </div>
      ${ev.actual ? confirmPanel(ev, a) : ""}

      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn sm danger" data-act="reset-budget">予算を解除</button>
        ${ev.actual ? `<button class="btn sm" data-act="clear-actual">実績をクリア</button>` : ""}
      </div>
    </div>
    <div>
      ${actualEditor(ev)}
    </div>
  </div>`;
  app.innerHTML = h + footnote();
}

/* 実績の確定パネル。
   確定してもロックはしない（数字を直したら押し直す運用）。
   確定した時点の収支を控えておき、その後の変更を検知して知らせる。 */
function confirmPanel(ev, a) {
  const cf = ev.actual_confirmed;
  const changed = cf && cf.net !== a.net;
  const when = cf ? new Date(cf.at).toLocaleString("ja-JP", {
    year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

  if (!cf) {
    return `<div class="confirm-box">
      <div>
        <div class="cf-title">実績を確定する</div>
        <div class="cf-msg">実際にかかった費用を入力し終えたら確定してください。
          確定したイベントが「収支一覧」に集計されます。</div>
      </div>
      <button class="btn primary" data-act="confirm-actual">この内容で確定</button>
    </div>`;
  }
  return `<div class="confirm-box ${changed ? "changed" : "done"}">
    <div>
      <div class="cf-title">${changed ? "確定後に内容が変わっています" : "確定済み"}</div>
      <div class="cf-msg">
        ${changed
          ? `確定時の収支は ¥${fmt(cf.net)} でしたが、現在は ¥${fmt(a.net)} です。
             「収支一覧」には確定した内容が表示されます。変更を反映するには確定し直してください。`
          : `${esc(when)} に確定（収支 ¥${fmt(cf.net)}）。数字を直したら確定し直してください。`}
      </div>
    </div>
    <div style="display:flex;gap:8px;flex:none">
      <button class="btn ${changed ? "primary" : ""}" data-act="confirm-actual">確定し直す</button>
      <button class="btn" data-act="unconfirm-actual">確定を取り消す</button>
    </div>
  </div>`;
}

function emptyActual() {
  return { paid_participant_count: 0, participation_fee: 0, other_income: 0, target_profit: 0,
    required_lodging_count: null, lodging_items: [], meal_items: [], venue_items: [], expense_items: [],
    lodging_cancels: [], meal_cancels: [], venue_cancels: [], nca_income_items: [], nca_expense_items: [] };
}

function actualEditor(ev) {
  if (!ev.actual) {
    return `<div class="panel"><div class="panel-head"><h3>実績入力</h3></div>
      <div class="panel-body">
        <p style="color:var(--ink-2);font-size:13.5px;margin:2px 0 14px">
          実績はまだ入力されていません。予算スナップショットをひな型としてコピーし、実際の値に修正できます。</p>
        <div style="display:flex;gap:8px">
          <button class="btn primary sm" data-act="init-actual-copy">予算をコピーして開始</button>
          <button class="btn sm" data-act="init-actual-blank">空から入力</button>
        </div>
      </div></div>`;
  }
  const p = ev.actual;
  const c = calcBlock(p);

  const lodgingRows = p.lodging_items.map(r => `<tr data-rid="${r.id}">
      <td><input class="in text" data-f="hotel_name" data-rt="a-lodging" data-rid="${r.id}" value="${esc(r.hotel_name)}" placeholder="Aホテル"></td>
      <td>${roomTypeSelect(r.room_type, "a-lodging", r.id)}</td>
      <td><input class="in num" data-f="room_count" data-rt="a-lodging" data-rid="${r.id}" value="${esc(r.room_count)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="unit_price" data-rt="a-lodging" data-rid="${r.id}" value="${esc(r.unit_price)}" inputmode="numeric"></td>
      <td class="amt" data-rowamt="${r.id}">${fmt(n(r.room_count) * n(r.unit_price))}</td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-row" data-rt="a-lodging" data-rid="${r.id}" title="この行を削除">×</button></td></tr>`).join("");
  const mealRows = p.meal_items.map(r => `<tr data-rid="${r.id}">
      <td><input class="in text" data-f="timing" data-rt="a-meal" data-rid="${r.id}" value="${esc(r.timing)}" placeholder="1日目 昼"></td>
      <td><input class="in num" data-f="meal_count" data-rt="a-meal" data-rid="${r.id}" value="${esc(r.meal_count)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="unit_price" data-rt="a-meal" data-rid="${r.id}" value="${esc(r.unit_price)}" inputmode="numeric"></td>
      <td><input class="in text" data-f="note" data-rt="a-meal" data-rid="${r.id}" value="${esc(r.note)}" placeholder="メモ"></td>
      <td class="amt" data-rowamt="${r.id}">${fmt(n(r.meal_count) * n(r.unit_price))}</td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-row" data-rt="a-meal" data-rid="${r.id}" title="この行を削除">×</button></td></tr>`).join("");
  const venueRows = (p.venue_items || []).map(r => `<tr data-rid="${r.id}">
      <td><input class="in" type="date" data-f="date" data-rt="a-venue" data-rid="${r.id}" value="${esc(r.date)}"></td>
      <td><input class="in text" data-f="name" data-rt="a-venue" data-rid="${r.id}" value="${esc(r.name)}" placeholder="別館 / BERTH 1+2"></td>
      <td><input class="in text" data-f="note" data-rt="a-venue" data-rid="${r.id}" value="${esc(r.note)}" placeholder="9:00〜22:00／終日"></td>
      <td><input class="in num" data-f="quantity" data-rt="a-venue" data-rid="${r.id}" value="${esc(r.quantity)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="unit_price" data-rt="a-venue" data-rid="${r.id}" value="${esc(r.unit_price)}" inputmode="numeric"></td>
      <td class="amt" data-rowamt="${r.id}">${fmt(n(r.quantity) * n(r.unit_price))}</td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-row" data-rt="a-venue" data-rid="${r.id}" title="この行を削除">×</button></td></tr>`).join("");
  const expRows = p.expense_items.map(r => `<tr data-rid="${r.id}">
      <td><input class="in text" data-f="category" data-rt="a-expense" data-rid="${r.id}" value="${esc(r.category)}" placeholder="交通費"></td>
      <td><input class="in text" data-f="name" data-rt="a-expense" data-rid="${r.id}" value="${esc(r.name)}" placeholder="タクシー代"></td>
      <td><input class="in num" data-f="unit_price" data-rt="a-expense" data-rid="${r.id}" value="${esc(r.unit_price)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="quantity" data-rt="a-expense" data-rid="${r.id}" value="${esc(r.quantity)}" inputmode="numeric"></td>
      <td><input class="in text" data-f="note" data-rt="a-expense" data-rid="${r.id}" value="${esc(r.note)}" placeholder="メモ"></td>
      <td class="amt" data-rowamt="${r.id}">${fmt(n(r.unit_price) * n(r.quantity))}</td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-row" data-rt="a-expense" data-rid="${r.id}" title="この行を削除">×</button></td></tr>`).join("");

  const aLodgingCancel = cancelBlock(p.lodging_cancels, "a-lc", "add-a-cancel");
  const aMealCancel = cancelBlock(p.meal_cancels, "a-mc", "add-a-cancel");
  const aVenueCancel = cancelBlock(p.venue_cancels, "a-vc", "add-a-cancel");

  // NCA実績の行
  const aNcaIncomeRows = (p.nca_income_items || []).map(r => `<tr data-rid="${r.id}">
      <td>${ncaTypeSelect(r.kind, state.settings.nca_income_types, "a-nca-income", r.id)}</td>
      <td><input class="in num" data-f="count" data-rt="a-nca-income" data-rid="${r.id}" value="${esc(r.count)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="unit_price" data-rt="a-nca-income" data-rid="${r.id}" value="${esc(r.unit_price)}" inputmode="numeric"></td>
      <td><input class="in text" data-f="note" data-rt="a-nca-income" data-rid="${r.id}" value="${esc(r.note)}" placeholder="メモ"></td>
      <td class="amt" data-rowamt="${r.id}">${fmt(n(r.count) * n(r.unit_price))}</td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-row" data-rt="a-nca-income" data-rid="${r.id}" title="この行を削除">×</button></td></tr>`).join("");
  const aNcaExpenseRows = (p.nca_expense_items || []).map(r => `<tr data-rid="${r.id}">
      <td>${ncaTypeSelect(r.category, state.settings.nca_expense_types, "a-nca-expense", r.id)}</td>
      <td><input class="in text" data-f="name" data-rt="a-nca-expense" data-rid="${r.id}" value="${esc(r.name)}" placeholder="名目・内容"></td>
      <td><input class="in num" data-f="count" data-rt="a-nca-expense" data-rid="${r.id}" value="${esc(r.count)}" inputmode="numeric"></td>
      <td><input class="in num" data-f="unit_price" data-rt="a-nca-expense" data-rid="${r.id}" value="${esc(r.unit_price)}" inputmode="numeric"></td>
      <td><input class="in text" data-f="note" data-rt="a-nca-expense" data-rid="${r.id}" value="${esc(r.note)}" placeholder="メモ"></td>
      <td class="amt" data-rowamt="${r.id}">${fmt(n(r.count) * n(r.unit_price))}</td>
      <td class="rowdel"><button class="icon-btn del" data-act="del-row" data-rt="a-nca-expense" data-rid="${r.id}" title="この行を削除">×</button></td></tr>`).join("");

  const body = isNCA(ev)
    ? `<div class="sub-h">収入内訳 <span style="flex:1"></span><span class="num" style="color:var(--ink-2);font-weight:680">¥${fmt(c.ncaIncome)}</span></div>
      ${(p.nca_income_items || []).length ? `<div class="lines-wrap"><table class="lines">
        <colgroup><col style="width:28%"><col style="width:12%"><col style="width:16%"><col style="width:24%"><col style="width:16%"><col style="width:34px"></colgroup>
        <thead><tr><th class="l">参加種別</th><th>人数</th><th>単価</th><th class="l">メモ</th><th>金額</th><th></th></tr></thead><tbody>${aNcaIncomeRows}</tbody></table></div>` : ""}
      <div class="add-line"><button class="btn sm" data-act="add-a-nca-income">＋ 収入を追加</button></div>

      <div class="sub-h">支出内訳 <span style="flex:1"></span><span class="num" style="color:var(--ink-2);font-weight:680">¥${fmt(c.ncaExpense)}</span></div>
      ${(p.nca_expense_items || []).length ? `<div class="lines-wrap"><table class="lines">
        <colgroup><col style="width:24%"><col style="width:22%"><col style="width:9%"><col style="width:15%"><col style="width:16%"><col style="width:14%"><col style="width:34px"></colgroup>
        <thead><tr><th class="l">区分</th><th class="l">名目・内容</th><th>数量</th><th>単価</th><th class="l">メモ</th><th>金額</th><th></th></tr></thead><tbody>${aNcaExpenseRows}</tbody></table></div>` : ""}
      <div class="add-line"><button class="btn sm" data-act="add-a-nca-expense">＋ 支出を追加</button></div>`
    : `<div class="basic-row" style="border-bottom:none;padding-top:2px">
        <div class="fld"><label>有料参加者数</label><input class="in num" data-f="paid_participant_count" data-rt="a-plan" value="${esc(p.paid_participant_count)}" inputmode="numeric"></div>
        <div class="fld"><label>参加費</label><input class="in num" data-f="participation_fee" data-rt="a-plan" value="${esc(p.participation_fee)}" inputmode="numeric"></div>
        <div class="fld"><label>その他収入</label><input class="in num" data-f="other_income" data-rt="a-plan" value="${esc(p.other_income)}" inputmode="numeric"></div>
      </div>

      <div class="sub-h">宿泊 <span style="flex:1"></span><span class="num" style="color:var(--ink-2);font-weight:680">¥${fmt(c.lodging)}</span></div>
      ${p.lodging_items.length ? `<div class="lines-wrap"><table class="lines">
        <colgroup><col style="width:26%"><col style="width:22%"><col style="width:11%"><col style="width:18%"><col style="width:18%"><col style="width:34px"></colgroup>
        <thead><tr><th class="l">ホテル名</th><th class="l">部屋タイプ</th><th>室数</th><th>1室単価</th><th>金額</th><th></th></tr></thead><tbody>${lodgingRows}</tbody></table></div>` : ""}
      <div class="add-line"><button class="btn sm" data-act="add-a-lodging">＋ 宿泊行を追加</button>${aLodgingCancel.btn}</div>
      ${aLodgingCancel.table}

      <div class="sub-h">食事 <span style="flex:1"></span><span class="num" style="color:var(--ink-2);font-weight:680">¥${fmt(c.meals)}</span></div>
      ${p.meal_items.length ? `<div class="lines-wrap"><table class="lines">
        <colgroup><col style="width:24%"><col style="width:10%"><col style="width:15%"><col style="width:26%"><col style="width:15%"><col style="width:34px"></colgroup>
        <thead><tr><th class="l">タイミング</th><th>食数</th><th>単価</th><th class="l">メモ</th><th>金額</th><th></th></tr></thead><tbody>${mealRows}</tbody></table></div>` : ""}
      <div class="add-line"><button class="btn sm" data-act="add-a-meal">＋ 食事を追加</button>${aMealCancel.btn}</div>
      ${aMealCancel.table}

      <div class="sub-h">会場 <span style="flex:1"></span><span class="num" style="color:var(--ink-2);font-weight:680">¥${fmt(c.venue)}</span></div>
      ${(p.venue_items || []).length ? `<div class="lines-wrap"><table class="lines">
        <colgroup><col style="width:15%"><col style="width:28%"><col style="width:19%"><col style="width:7%"><col style="width:14%"><col style="width:14%"><col style="width:34px"></colgroup>
        <thead><tr><th class="l">日付</th><th class="l">利用会場・項目</th><th class="l">利用時間・内容</th><th>数量</th><th>単価</th><th>金額</th><th></th></tr></thead><tbody>${venueRows}</tbody></table></div>` : ""}
      <div class="add-line"><button class="btn sm" data-act="add-a-venue">＋ 会場を追加</button>${aVenueCancel.btn}</div>
      ${aVenueCancel.table}

      <div class="sub-h">任意費目 <span style="flex:1"></span><span class="num" style="color:var(--ink-2);font-weight:680">¥${fmt(c.misc)}</span></div>
      ${p.expense_items.length ? `<div class="lines-wrap"><table class="lines">
        <colgroup><col style="width:15%"><col style="width:24%"><col style="width:14%"><col style="width:9%"><col style="width:22%"><col style="width:14%"><col style="width:34px"></colgroup>
        <thead><tr><th class="l">区分</th><th class="l">項目名</th><th>単価</th><th>数量</th><th class="l">メモ</th><th>金額</th><th></th></tr></thead><tbody>${expRows}</tbody></table></div>` : ""}
      <div class="add-line"><button class="btn sm" data-act="add-a-expense">＋ 費目を追加</button></div>`;

  return `<div class="panel"><div class="panel-head"><h3>実績入力</h3>
      <span class="spacer" style="flex:1"></span>
      <span class="num" style="font-size:13px;color:var(--ink-2)">収支 <b class="money ${c.net>=0?'pos':'neg'}">${c.net<0?'−':''}¥${fmt(Math.abs(c.net))}</b></span></div>
    <div class="panel-body">
      ${body}
    </div></div>`;
}

/* ---------- 収支一覧（確定した実績の集計） ---------- */

/* 集計対象の日付。開催日が未設定なら確定日を使う */
function reportDate(ev) {
  if (ev.start_date) return ev.start_date;
  if (ev.actual_confirmed?.at) return new Date(ev.actual_confirmed.at).toISOString().slice(0, 10);
  return "";
}

function reportRows() {
  return state.events
    .filter(ev => ev.actual_confirmed)
    .map(ev => ({ ev, d: reportDate(ev), cf: ev.actual_confirmed }))
    .sort((x, y) => (x.d || "").localeCompare(y.d || ""));
}

function renderReport() {
  const all = reportRows();
  const cats = [UNCATEGORIZED, ...(state.settings.event_categories || [])];

  // 絞り込み条件（未設定なら全期間）
  const f = ui.report || (ui.report = { from: "", to: "", cat: "" });
  const inRange = (r) =>
    (!f.from || (r.d && r.d >= f.from)) &&
    (!f.to || (r.d && r.d <= f.to)) &&
    (!f.cat || (r.ev.category || UNCATEGORIZED) === f.cat);

  const rows = all.filter(inRange);
  const sum = rows.reduce((s, r) => ({
    income: s.income + r.cf.income, expense: s.expense + r.cf.expense, net: s.net + r.cf.net,
  }), { income: 0, expense: 0, net: 0 });

  let h = `<div class="section-head">
      <h2>収支一覧</h2><span class="count">確定した実績のみ集計</span>
      <span class="spacer" style="flex:1"></span>
      ${rows.length ? `<button class="btn sm" data-act="copy-report">表をコピー</button>` : ""}
    </div>`;

  if (!all.length) {
    app.innerHTML = h + `<div class="empty"><h3>確定した実績がまだありません</h3>
      <div>「実績管理」で実際の費用を入力し、<b>「この内容で確定」</b>を押すと、<br>
      そのイベントがここに集計されます。</div></div>` + footnote();
    return;
  }

  // 絞り込み
  h += `<div class="filter-bar">
    <label>期間</label>
    <input type="date" class="in" data-rep="from" value="${esc(f.from)}">
    <span class="tilde">〜</span>
    <input type="date" class="in" data-rep="to" value="${esc(f.to)}">
    <label style="margin-left:10px">区分</label>
    <select class="in" data-rep="cat">
      <option value="">すべて</option>
      ${cats.map(c => `<option value="${esc(c)}" ${f.cat === c ? "selected" : ""}>${esc(c)}</option>`).join("")}
    </select>
    ${(f.from || f.to || f.cat) ? `<button class="btn sm" data-act="clear-report-filter">絞り込みを解除</button>` : ""}
    <span class="spacer" style="flex:1"></span>
    <span class="filter-count">${rows.length} / ${all.length} 件</span>
  </div>`;

  // 合計
  h += `<div class="report-sum">
    <div class="rs-cell"><div class="lbl">収入 合計</div><div class="val">${yen(sum.income)}</div></div>
    <div class="rs-cell"><div class="lbl">支出 合計</div><div class="val">${yen(sum.expense)}</div></div>
    <div class="rs-cell hl"><div class="lbl">利益 合計</div>
      <div class="val money ${sum.net >= 0 ? "pos" : "neg"} num">${sum.net < 0 ? "−" : ""}<span class="yen">¥</span>${fmt(Math.abs(sum.net))}</div>
      <div class="sub">${rows.length}件の合計</div></div>
  </div>`;

  if (!rows.length) {
    h += `<div class="empty" style="padding:40px">この期間・区分に該当するイベントはありません。</div>`;
    app.innerHTML = h + footnote();
    return;
  }

  // 明細
  h += `<div class="cmp-wrap"><table class="cmp report">
    <thead><tr>
      <th class="l">開催日</th><th class="l">イベント名</th><th class="l">区分</th>
      <th>収入</th><th>支出</th><th>収支</th>
    </tr></thead>
    <tbody>`;
  for (const r of rows) {
    const cat = r.ev.category || UNCATEGORIZED;
    h += `<tr data-act="open-event-report" data-id="${r.ev.id}">
      <td class="l num">${esc(r.d || "—")}</td>
      <td class="l"><b>${esc(r.ev.name)}</b></td>
      <td class="l"><span class="pill ${cat === UNCATEGORIZED ? "s-est" : "s-budget"}">${esc(cat)}</span></td>
      <td>${yen(r.cf.income)}</td>
      <td>${yen(r.cf.expense)}</td>
      <td class="net"><span class="money ${r.cf.net >= 0 ? "pos" : "neg"} num">${r.cf.net < 0 ? "−" : ""}¥${fmt(Math.abs(r.cf.net))}</span></td>
    </tr>`;
  }
  h += `</tbody>
    <tfoot><tr class="total">
      <td class="l" colspan="3">合計（${rows.length}件）</td>
      <td>${yen(sum.income)}</td>
      <td>${yen(sum.expense)}</td>
      <td class="net"><span class="money ${sum.net >= 0 ? "pos" : "neg"} num">${sum.net < 0 ? "−" : ""}¥${fmt(Math.abs(sum.net))}</span></td>
    </tr></tfoot></table></div>`;

  h += `<div style="font-size:12px;color:var(--ink-3);margin-top:10px">
    金額は<b>確定した時点</b>の実績です。確定後に数字を変えた場合は、「実績管理」で確定し直すと反映されます。<br>
    行をクリックすると、そのイベントの実績管理を開きます。</div>`;

  app.innerHTML = h + footnote();
}

/* 表計算ソフトに貼れる形（タブ区切り）で書き出す */
function copyReport() {
  const f = ui.report || {};
  const rows = reportRows().filter(r =>
    (!f.from || (r.d && r.d >= f.from)) &&
    (!f.to || (r.d && r.d <= f.to)) &&
    (!f.cat || (r.ev.category || UNCATEGORIZED) === f.cat));
  const lines = [["開催日", "イベント名", "区分", "収入", "支出", "収支"].join("\t")];
  let si = 0, se = 0, sn = 0;
  for (const r of rows) {
    lines.push([r.d, r.ev.name, r.ev.category || UNCATEGORIZED, r.cf.income, r.cf.expense, r.cf.net].join("\t"));
    si += r.cf.income; se += r.cf.expense; sn += r.cf.net;
  }
  lines.push(["合計", "", "", si, se, sn].join("\t"));
  const text = lines.join("\n");
  navigator.clipboard.writeText(text)
    .then(() => toast("表をコピーしました。スプレッドシートに貼り付けられます"))
    .catch(() => toast("コピーできませんでした"));
}

/* ---------- 利用者・招待メールの操作 ---------- */
async function addInvite() {
  const input = document.getElementById("inviteEmail");
  const email = (input?.value || "").trim();
  if (!email || !email.includes("@")) {
    toast("メールアドレスを正しく入力してください");
    return;
  }
  if (state.invites.some(i => i.email === email)) {
    toast("そのメールアドレスはすでに招待済みです");
    return;
  }
  try {
    await setDoc(doc(db, COL_INVITES, email), {
      email, active: true, created_at: Date.now(), invited_by: currentUser ? currentUser.email : "",
    });
    if (input) input.value = "";
    toast(`「${email}」を招待しました。このメールでログインすれば、すぐ使えます。`);
    renderSettings();
  } catch (e) {
    console.error("招待に失敗", e);
    toast("招待できませんでした：" + friendlyError(e));
  }
}

async function toggleInvite(email) {
  const inv = state.invites.find(i => i.email === email);
  if (!inv) return;
  const { email: _drop, ...data } = inv;
  try {
    await setDoc(doc(db, COL_INVITES, email), { ...data, active: inv.active === false }, { merge: true });
  } catch (e) {
    console.error("招待の切り替えに失敗", e);
    toast("変更できませんでした：" + friendlyError(e));
  }
}

async function removeInvite(email) {
  try { await deleteDoc(doc(db, COL_INVITES, email)); }
  catch (e) { console.error("招待の削除に失敗", e); toast("削除できませんでした：" + friendlyError(e)); }
}

async function toggleUser(uid) {
  const u = state.users.find(x => x.uid === uid);
  if (!u) return;
  const { uid: _drop, ...data } = u;
  try {
    await setDoc(doc(db, COL_USERS, uid), { ...data, active: u.active === false }, { merge: true });
  } catch (e) {
    console.error("利用者の切り替えに失敗", e);
    toast("変更できませんでした：" + friendlyError(e));
  }
}

async function removeUser(uid) {
  try { await deleteDoc(doc(db, COL_USERS, uid)); }
  catch (e) { console.error("利用者の削除に失敗", e); toast("削除できませんでした：" + friendlyError(e)); }
}

/* ---------- 利用者・招待メールの一覧表示 ---------- */
function inviteRows() {
  if (!state.invites.length) {
    return `<p style="font-size:12.5px;color:var(--ink-3)">招待中のメールアドレスはありません。</p>`;
  }
  const rows = state.invites.map(inv => {
    const loggedIn = state.users.some(u => u.email === inv.email);
    return `<tr data-email="${esc(inv.email)}">
      <td class="l">${esc(inv.email)}</td>
      <td>${inv.active === false
          ? `<span class="pill">停止中</span>`
          : loggedIn ? `<span class="pill s-budget">ログイン済み</span>` : `<span class="pill">招待中</span>`}</td>
      <td class="rowdel">
        <button class="btn sm" data-act="toggle-invite" data-id="${esc(inv.email)}">${inv.active === false ? "再開" : "停止"}</button>
        <button class="icon-btn del" data-act="remove-invite" data-id="${esc(inv.email)}">×</button>
      </td></tr>`;
  }).join("");
  return `<table class="lines compact"><colgroup><col><col style="width:110px"><col style="width:110px"></colgroup>
    <thead><tr><th class="l">メールアドレス</th><th>状態</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function userRows() {
  if (!state.users.length) {
    return `<p style="font-size:12.5px;color:var(--ink-3)">まだ誰もログインしていません。</p>`;
  }
  const rows = state.users.map(u => `<tr data-uid="${esc(u.uid)}">
      <td class="l">${esc(u.email || "(不明)")}</td>
      <td>${u.active === false ? `<span class="pill">停止中</span>` : `<span class="pill s-budget">有効</span>`}</td>
      <td class="rowdel">
        <button class="btn sm" data-act="toggle-user" data-id="${esc(u.uid)}">${u.active === false ? "再開" : "停止"}</button>
        <button class="icon-btn del" data-act="remove-user" data-id="${esc(u.uid)}">×</button>
      </td></tr>`).join("");
  return `<table class="lines compact"><colgroup><col><col style="width:110px"><col style="width:110px"></colgroup>
    <thead><tr><th class="l">メールアドレス</th><th>状態</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/* ---------- 5.5 料金・費目設定 ---------- */
function renderSettings() {
  const s = state.settings;
  let roomRows = s.room_defaults.map((r, i) => `<tr data-i="${i}">
    <td><input class="in text" data-set="room-type" data-i="${i}" value="${esc(r.room_type)}"></td>
    <td><input class="in num" data-set="room-cap" data-i="${i}" value="${esc(r.capacity)}" inputmode="numeric"></td>
    <td class="rowdel"><button class="icon-btn del" data-act="del-set-room" data-i="${i}">×</button></td></tr>`).join("");
  let mealRows = s.meal_defaults.map((m, i) => `<tr data-i="${i}">
    <td><input class="in text" data-set="meal" data-i="${i}" value="${esc(m)}"></td>
    <td class="rowdel"><button class="icon-btn del" data-act="del-set-meal" data-i="${i}">×</button></td></tr>`).join("");
  let catRows = (s.event_categories || []).map((c, i) => `<tr data-i="${i}">
    <td><input class="in text" data-set="cat" data-i="${i}" value="${esc(c)}"></td>
    <td class="rowdel"><button class="icon-btn del" data-act="del-set-cat" data-i="${i}">×</button></td></tr>`).join("");
  let tplRows = s.expense_templates.map((t, i) => `<tr data-i="${i}">
    <td><input class="in text" data-set="tpl-cat" data-i="${i}" value="${esc(t.category)}"></td>
    <td><input class="in text" data-set="tpl-name" data-i="${i}" value="${esc(t.name)}"></td>
    <td class="rowdel"><button class="icon-btn del" data-act="del-set-tpl" data-i="${i}">×</button></td></tr>`).join("");
  let ncaIncRows = (s.nca_income_types || []).map((t, i) => `<tr data-i="${i}">
    <td><input class="in text" data-set="nca-inc" data-i="${i}" value="${esc(t)}"></td>
    <td class="rowdel"><button class="icon-btn del" data-act="del-set-nca-inc" data-i="${i}">×</button></td></tr>`).join("");
  let ncaExpRows = (s.nca_expense_types || []).map((t, i) => `<tr data-i="${i}">
    <td><input class="in text" data-set="nca-exp" data-i="${i}" value="${esc(t)}"></td>
    <td class="rowdel"><button class="icon-btn del" data-act="del-set-nca-exp" data-i="${i}">×</button></td></tr>`).join("");

  app.innerHTML = `<div class="section-head"><h2>料金・費目設定</h2>
      <span class="count">新規イベント・新規プランの初期値</span></div>
    <div style="background:var(--warn-soft);border:1px solid color-mix(in srgb,var(--warn) 30%,transparent);color:var(--warn);padding:10px 14px;border-radius:9px;font-size:12.5px;margin-bottom:18px">
      ここでの変更は<b>新規作成時の初期値</b>にのみ使われます。既存イベント・既存プランの確定済みの値は書き換えません。</div>

    <div class="set-grid">
      <div class="panel"><div class="panel-head"><h3>既定の目標利益</h3></div>
        <div class="panel-body">
          <div class="field-row"><label>新規イベントの目標利益</label>
            <input class="in num" data-set="target" value="${esc(s.default_target_profit)}" inputmode="numeric"></div>
          <p style="font-size:12px;color:var(--ink-3);margin:8px 3px 0">損益分岐や必要参加費の警告に使われます。</p>
        </div></div>

      <div class="panel"><div class="panel-head"><h3>部屋タイプ別の既定定員</h3></div>
        <div class="panel-body">
          <table class="lines compact">
            <colgroup><col><col style="width:80px"><col style="width:34px"></colgroup>
            <thead><tr><th class="l">部屋タイプ</th><th>定員</th><th></th></tr></thead><tbody>${roomRows}</tbody></table>
          <div class="add-line"><button class="btn sm" data-act="add-set-room">＋ 部屋タイプを追加</button></div>
        </div></div>

      <div class="panel"><div class="panel-head"><h3>イベントの区分</h3></div>
        <div class="panel-body">
          <table class="lines compact">
            <colgroup><col><col style="width:34px"></colgroup>
            <thead><tr><th class="l">区分名</th><th></th></tr></thead><tbody>${catRows}</tbody></table>
          <div class="add-line"><button class="btn sm" data-act="add-set-cat">＋ 区分を追加</button></div>
          <p style="font-size:12px;color:var(--ink-3);margin:8px 3px 0">
            イベント一覧はこの区分ごとに分けて表示されます。</p>
        </div></div>

      <div class="panel"><div class="panel-head"><h3>既定の食事タイミング</h3></div>
        <div class="panel-body">
          <table class="lines compact">
            <colgroup><col><col style="width:34px"></colgroup>
            <thead><tr><th class="l">タイミング</th><th></th></tr></thead><tbody>${mealRows}</tbody></table>
          <div class="add-line"><button class="btn sm" data-act="add-set-meal">＋ 食事タイミングを追加</button></div>
        </div></div>

      <div class="panel"><div class="panel-head"><h3>よく使う任意費目テンプレート</h3></div>
        <div class="panel-body">
          <table class="lines compact">
            <colgroup><col style="width:38%"><col><col style="width:34px"></colgroup>
            <thead><tr><th class="l">区分</th><th class="l">項目名</th><th></th></tr></thead><tbody>${tplRows}</tbody></table>
          <div class="add-line"><button class="btn sm" data-act="add-set-tpl">＋ テンプレートを追加</button></div>
          <p style="font-size:12px;color:var(--ink-3);margin:8px 3px 0">新規プランの任意費目にワンタップで追加できます（将来拡張）。</p>
        </div></div>

      <div class="panel"><div class="panel-head"><h3>NCA：参加種別（収入）</h3></div>
        <div class="panel-body">
          <table class="lines compact">
            <colgroup><col><col style="width:34px"></colgroup>
            <thead><tr><th class="l">参加種別</th><th></th></tr></thead><tbody>${ncaIncRows}</tbody></table>
          <div class="add-line"><button class="btn sm" data-act="add-set-nca-inc">＋ 参加種別を追加</button></div>
          <p style="font-size:12px;color:var(--ink-3);margin:8px 3px 0">NCAイベントの「収入内訳」で選べる参加種別です。</p>
        </div></div>

      <div class="panel"><div class="panel-head"><h3>NCA：支出区分</h3></div>
        <div class="panel-body">
          <table class="lines compact">
            <colgroup><col><col style="width:34px"></colgroup>
            <thead><tr><th class="l">支出区分</th><th></th></tr></thead><tbody>${ncaExpRows}</tbody></table>
          <div class="add-line"><button class="btn sm" data-act="add-set-nca-exp">＋ 支出区分を追加</button></div>
          <p style="font-size:12px;color:var(--ink-3);margin:8px 3px 0">NCAイベントの「支出内訳」で選べる区分です（懇親会費用・セミナー会場・キャンセル料など）。</p>
        </div></div>
    </div>

    <div style="margin-top:24px">
      <div class="panel"><div class="panel-head"><h3>利用者</h3></div>
        <div class="panel-body">
          <p style="font-size:12.5px;color:var(--ink-2);margin:0 0 12px">
            メールアドレスを招待しておくと、その<b>Googleアカウントでログインした瞬間</b>にアクセスできるようになります。
            Firebaseコンソールを開く必要はありません。
          </p>
          <div style="display:flex;gap:8px;margin-bottom:16px">
            <input class="in text" id="inviteEmail" placeholder="招待するメールアドレス" style="flex:1" autocomplete="off">
            <button class="btn sm primary" data-act="add-invite">招待する</button>
          </div>

          <h4 style="font-size:12px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em;margin:0 0 8px">招待中のメールアドレス</h4>
          ${inviteRows()}

          <h4 style="font-size:12px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em;margin:20px 0 8px">利用者（ログイン済み）</h4>
          ${userRows()}
        </div></div>
    </div>

    <div style="margin-top:24px;padding-top:18px;border-top:1px solid var(--border)">
      <div style="background:var(--pos-soft);border:1px solid color-mix(in srgb,var(--pos) 30%,transparent);color:var(--pos);padding:10px 14px;border-radius:9px;font-size:12.5px">
        <b>データはクラウドに保存されています。</b><br>
        登録済みのアカウントであれば、どの端末から開いても同じデータが表示されます。
      </div>

      <h3 style="font-size:13px;color:var(--ink-2);margin:20px 0 8px">バックアップ</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn sm" data-act="export-data">データを書き出す</button>
        <span style="font-size:12px;color:var(--ink-3)">
          全データをテキストで控えられます。通常の利用では不要です。</span>
      </div>
    </div>
    ${footnote()}`;
}

/* ---------- 使い方（マニュアル） ---------- */
function helpShot(src, alt, caption) {
  return `<figure class="help-shot">
      <img src="manual/${src}" alt="${esc(alt)}" loading="lazy"
        onerror="this.closest('.help-shot').classList.add('missing')">
      <figcaption>${caption}</figcaption>
    </figure>`;
}

function helpSection(num, id, title, bodyHtml) {
  return `<section class="help-sec" id="help-${id}">
      <div class="help-head"><span class="help-num">${num}</span><h3>${esc(title)}</h3></div>
      <div class="help-body">${bodyHtml}</div>
    </section>`;
}

function renderHelp() {
  const toc = [
    ["intro", "このアプリでできること"],
    ["login", "ログインする"],
    ["event", "イベントを作る"],
    ["plan-basic", "プランの基本情報を入力する"],
    ["plan-lodging", "宿泊を入力する"],
    ["plan-meal", "食事・会場・任意費目を入力する"],
    ["compare", "プランを比較する"],
    ["adopt", "プランを予算として採用する"],
    ["actual", "実績を入力して確定する"],
    ["report", "収支一覧で確認する"],
    ["settings", "料金・費目の初期値を設定する"],
    ["import", "スプレッドシートから取り込む"],
    ["faq", "困ったときは"],
  ];

  let h = `<div class="section-head"><h2>使い方</h2>
      <span class="count">はじめての方向けガイド</span></div>`;

  h += `<div class="help-wrap">`;

  h += `<div class="help-toc">
      <div class="help-toc-title">目次</div>
      <ol>${toc.map(([id, label], i) =>
        `<li><a data-act="help-jump" data-id="${id}"><span class="help-toc-n">${i + 1}</span>${esc(label)}</a></li>`
      ).join("")}</ol>
    </div>`;

  h += `<div class="help-pages">`;

  h += helpSection(1, "intro", "このアプリでできること", `
    <p>イベントごとに、開催前の<b>試算</b>（複数プランの比較）と、開催後の<b>実績</b>（実際にかかった費用との差額確認）を管理できます。</p>
    <ul class="help-list">
      <li><b>収支シミュレーション</b> … 参加人数や単価を変えながら、複数プランの収支を比較する</li>
      <li><b>実績管理</b> … 採用したプランを予算として固定し、実際の金額を入力して差額を見る</li>
      <li><b>収支一覧</b> … 確定した実績を、期間や区分で絞り込んで一覧できる</li>
    </ul>
    <p>入力すると<b>自動で保存</b>されます。保存ボタンはありません。登録されたアカウントであれば、他の端末からも同じデータが見られます。</p>`);

  h += helpSection(2, "login", "ログインする", `
    <p>アプリを開くと、まずログイン画面が表示されます。<b>Googleでログイン</b>を押して、登録済みのアカウントでログインしてください。</p>
    <p class="help-note">招待されていないアカウントでログインすると「アクセスが許可されていません」と表示されます。その場合は、すでに使える人に「料金・費目設定」の「利用者」からメールアドレスを招待してもらってください。</p>
    ${helpShot("01-login.png", "Googleログイン画面", "ログイン画面。「Googleでログイン」を押す")}`);

  h += helpSection(3, "event", "イベントを作る", `
    <p>「イベント一覧」の<b>＋ 新規イベント</b>を押し、イベント名・区分・開催日を入力します。</p>
    <p>作成すると自動で「収支シミュレーション」画面に移動し、最初のプラン（標準プラン）の入力を始められます。</p>
    ${helpShot("02-new-event.png", "新規イベント作成モーダル", "新規イベントの作成画面。区分は合宿／NCA／未分類などから選ぶ")}
    <p class="help-note">イベントの区分は「料金・費目設定」の画面で自由に追加できます。</p>`);

  h += helpSection(4, "plan-basic", "プランの基本情報を入力する", `
    <p>「収支シミュレーション」で、プランの<b>有料参加者数</b>・<b>参加費</b>・<b>その他収入</b>・<b>目標利益</b>を入力します。ここまで入れると、右上のサマリーに収入・支出・収支が即座に反映されます。</p>
    ${helpShot("03-plan-basic.png", "プランの基本情報入力欄", "有料参加者数・参加費などの基本項目")}`);

  h += helpSection(5, "plan-lodging", "宿泊を入力する", `
    <p>宿泊行を追加し、<b>部屋タイプ</b>をプルダウンから選ぶと、1室あたりの定員が自動で入ります。室数と単価を入れると金額が自動計算されます。</p>
    <p>宿泊の直前キャンセルなどで別立ての費用がある場合は、<b>＋ キャンセル料</b>から名目と金額を追加できます（宿泊定員の計算には影響しません）。</p>
    ${helpShot("04-plan-lodging.png", "宿泊入力欄", "部屋タイプを選ぶと定員が自動入力される")}`);

  h += helpSection(6, "plan-meal", "食事・会場・任意費目を入力する", `
    <p>食事は<b>タイミング・食数・単価</b>を、会場は<b>日付・利用会場・利用時間・数量・単価</b>を入力します。それ以外の費用は「任意費目」に区分・項目名・単価・数量で追加できます。</p>
    ${helpShot("05-plan-meal.png", "食事・会場の入力欄", "食事と会場の入力欄")}`);

  h += helpSection(7, "compare", "プランを比較する", `
    <p>「＋ プランを追加」を押すと、<b>直前のプランの内容をコピー</b>して新しいプランが作られます。人数や室数だけを変えて、複数プランをすぐに比較できます。</p>
    <p>上部の「プラン比較」の行をクリックすると、そのプランがサマリーに反映されます。</p>
    ${helpShot("06-plan-compare.png", "プラン比較表", "複数プランの収入・支出・収支を並べて比較できる")}`);

  h += helpSection(8, "adopt", "プランを予算として採用する", `
    <p>比較して決まったプランのカードにある<b>「採用して予算へ反映」</b>を押すと、そのプランの内容が予算として確定されます（採用時点の内容がスナップショットとして保存されます）。</p>
    ${helpShot("07-adopt-plan.png", "採用ボタン", "プランカード下部の「採用して予算へ反映」ボタン")}`);

  h += helpSection(9, "actual", "実績を入力して確定する", `
    <p>「実績管理」タブで<b>「予算をコピーして開始」</b>を押すと、採用した予算と同じ形の実績入力欄が作られます。実際にかかった金額に書き換えてください。</p>
    <p>入力が終わったら<b>「この内容で確定」</b>を押します。確定した内容が「収支一覧」に集計されます。金額を直したときは、もう一度確定し直してください。</p>
    ${helpShot("08-actual-confirm.png", "実績確定ボタン", "実績を入力し、「この内容で確定」を押す")}`);

  h += helpSection(10, "report", "収支一覧で確認する", `
    <p>確定済みの実績が一覧で表示されます。<b>期間</b>や<b>区分</b>で絞り込むと、その範囲の利益合計が上部に出ます。「表をコピー」でスプレッドシートに貼り付けられる形式で書き出せます。</p>
    ${helpShot("09-report.png", "収支一覧画面", "期間・区分で絞り込んで利益合計を確認できる")}`);

  h += helpSection(11, "settings", "料金・費目の初期値を設定する", `
    <p>新規イベント・新規プランで使われる初期値（既定の目標利益、部屋タイプ別の定員、食事タイミング、費目テンプレート、イベントの区分など）をここで管理します。</p>
    <p class="help-note">ここでの変更は<b>新規作成時の初期値</b>にのみ使われます。既存のイベント・プランの値は書き換わりません。</p>
    <p>同じ画面の「利用者」パネルから、新しく使ってもらいたい人のメールアドレスを招待できます。招待しておくと、その人が<b>指定したGoogleアカウントでログインした瞬間にアクセスできる</b>ようになります（Firebaseコンソールを開く必要はありません）。</p>
    ${helpShot("10-settings.png", "料金・費目設定画面", "部屋タイプ・食事タイミング・イベント区分などの初期値")}`);

  h += helpSection(12, "import", "スプレッドシートから取り込む", `
    <p>「イベント一覧」または「収支シミュレーション」の<b>「スプレッドシートから取り込む」</b>から、既存のスプレッドシート（項目・数量・単価・合計の並び）の内容を貼り付けると、選択中イベントのプランに反映されます。</p>
    <p class="help-note">取り込む前にプレビューが表示されるので、内容を確認してから確定できます。区分の振り分けが違う場合は、取り込んだあとに画面上で直せます。</p>
    ${helpShot("11-import.png", "スプレッドシート取り込み画面", "貼り付けた内容のプレビューと取り込み確定")}`);

  h += helpSection(13, "faq", "困ったときは", `
    <dl class="help-faq">
      <dt>ログインしても「アクセスが許可されていません」と出る</dt>
      <dd>まだ招待されていないアカウントです。すでに使える人に「料金・費目設定」の「利用者」からメールアドレスを招待してもらうか、画面に表示されているユーザーIDを伝えて登録を依頼してください。</dd>
      <dt>入力した内容が保存されているか不安</dt>
      <dd>右上の「保存済み」の表示を確認してください。「保存中…」のまま止まる場合は通信環境を確認し、右上の「更新」を押してください。</dd>
      <dt>他の人が入力した内容が見えない</dt>
      <dd>同じGoogleアカウントで登録されているか確認してください。登録は管理者が「料金・費目設定」ではなくFirebaseコンソール側で行います。</dd>
      <dt>数字を直したのに収支一覧に反映されない</dt>
      <dd>実績管理で「確定」をやり直してください。確定は入力するたびに押し直す必要があります。</dd>
    </dl>`);

  h += `</div>`; // help-pages
  h += `</div>`; // help-wrap
  app.innerHTML = h;
}

/* ---------- 共通の空表示 ---------- */
function noEventEmpty() {
  return `<div class="empty"><h3>イベントがありません</h3>
    <div>まず「イベント一覧」でイベントを作成してください。</div>
    <div style="margin-top:16px"><button class="btn primary" data-act="goto-events">イベント一覧へ</button></div></div>`;
}
function footnote() {
  return `<div class="footnote">入力すると自動で保存されます。保存ボタンはありません。</div>`;
}

/* ============================================================
   部分再描画（入力中にフォーカスを保持）
   ============================================================ */
function repaintSim() {
  const ev = getEvent(); if (!ev) return;
  for (const p of ev.plans) {
    const c = calcBlock(p);
    setText(`[data-plannet="${p.id}"]`, (c.net < 0 ? "−" : "") + "¥" + fmt(Math.abs(c.net)));
    setClass(`[data-plannet="${p.id}"]`, c.net >= 0);
    setText(`[data-planinc="${p.id}"]`, "¥" + fmt(c.income));
    setText(`[data-planexp="${p.id}"]`, "¥" + fmt(c.expense));
    setText(`[data-grptot="lodging-${p.id}"]`, "¥" + fmt(c.lodging));
    setText(`[data-grptot="meal-${p.id}"]`, "¥" + fmt(c.meals));
    setText(`[data-grptot="venue-${p.id}"]`, "¥" + fmt(c.venue));
    setText(`[data-grptot="expense-${p.id}"]`, "¥" + fmt(c.misc));
    setText(`[data-grptot="ncaincome-${p.id}"]`, "¥" + fmt(c.ncaIncome));
    setText(`[data-grptot="ncaexpense-${p.id}"]`, "¥" + fmt(c.ncaExpense));
    const cn = document.querySelector(`[data-capnote="${p.id}"]`);
    if (cn) cn.innerHTML = capNoteHtml(c);
  }
  // 上部のプラン比較表（入力欄を含まないので丸ごと差し替えて良い）
  const ovBody = document.getElementById("ovBody");
  if (ovBody) ovBody.innerHTML = overviewRows(ev);
  // 行金額
  for (const p of ev.plans) {
    p.lodging_items.forEach(r => setText(`[data-rowamt="${r.id}"]`, fmt(n(r.room_count) * n(r.unit_price))));
    p.meal_items.forEach(r => setText(`[data-rowamt="${r.id}"]`, fmt(n(r.meal_count) * n(r.unit_price))));
    (p.venue_items || []).forEach(r => setText(`[data-rowamt="${r.id}"]`, fmt(n(r.quantity) * n(r.unit_price))));
    p.expense_items.forEach(r => setText(`[data-rowamt="${r.id}"]`, fmt(n(r.unit_price) * n(r.quantity))));
    (p.nca_income_items || []).forEach(r => setText(`[data-rowamt="${r.id}"]`, fmt(n(r.count) * n(r.unit_price))));
    (p.nca_expense_items || []).forEach(r => setText(`[data-rowamt="${r.id}"]`, fmt(n(r.count) * n(r.unit_price))));
  }
  // 選択中プランのサマリー
  repaintSummary(ev);
}
function repaintSummary(ev) {
  const plan = getPlan(ev); if (!plan) return;
  const c = calcBlock(plan);
  const cells = document.querySelectorAll(".summary .cell .val");
  if (cells.length >= 3) {
    cells[0].innerHTML = yen(c.income);
    cells[1].innerHTML = yen(c.expense);
    cells[2].innerHTML = `<span class="money ${c.net >= 0 ? "pos" : "neg"} num">${c.net < 0 ? "−" : ""}<span class="yen">¥</span>${fmt(Math.abs(c.net))}</span>`;
  }
  if (cells.length >= 5) {   // 合宿のみ（NCAは3セル）
    cells[3].innerHTML = c.breakeven == null ? "—" : c.breakeven + "<span class='yen'> 名</span>";
    cells[4].innerHTML = c.requiredFee == null ? "—" : "<span class='yen'>¥</span>" + fmt(c.requiredFee);
  }
  // 警告は構造変化しうるので軽く作り直し
  const alertsWrap = document.querySelector(".alerts");
  const holder = alertsWrap || document.querySelector(".summary")?.nextElementSibling;
  let alerts = "";
  if (c.net < 0) alerts += alertBox("neg", "⚠", `赤字警告：収支が ${yen(c.net, { signed: true })} です。`);
  if (c.net >= 0 && !c.targetMet) alerts += alertBox("warn", "△", `目標利益 未達：目標 ¥${fmt(n(plan.target_profit))} に対し収支は ¥${fmt(c.net)}（あと ¥${fmt(n(plan.target_profit) - c.net)}）。`);
  if (c.lodgingShort) alerts += alertBox("warn", "🛏", `宿泊定員 不足：必要 ${c.reqLodging}名 に対し定員 ${c.lodgingCap}名（${c.reqLodging - c.lodgingCap}名不足）。`);
  if (alertsWrap) alertsWrap.innerHTML = alerts;
}
function repaintActual() {
  const ev = getEvent(); if (!ev || !ev.actual) return;
  const p = ev.actual;
  p.lodging_items.forEach(r => setText(`[data-rowamt="${r.id}"]`, fmt(n(r.room_count) * n(r.unit_price))));
  p.meal_items.forEach(r => setText(`[data-rowamt="${r.id}"]`, fmt(n(r.meal_count) * n(r.unit_price))));
  (p.venue_items || []).forEach(r => setText(`[data-rowamt="${r.id}"]`, fmt(n(r.quantity) * n(r.unit_price))));
  p.expense_items.forEach(r => setText(`[data-rowamt="${r.id}"]`, fmt(n(r.unit_price) * n(r.quantity))));
  (p.nca_income_items || []).forEach(r => setText(`[data-rowamt="${r.id}"]`, fmt(n(r.count) * n(r.unit_price))));
  (p.nca_expense_items || []).forEach(r => setText(`[data-rowamt="${r.id}"]`, fmt(n(r.count) * n(r.unit_price))));
  // 比較表と収支は再描画（フォーカスは実績入力側なので表側だけ差し替え）
  const b = calcBlock(ev.budget_snapshot);
  const a = calcBlock(ev.actual);
  const tb = document.querySelector("table.cmp tbody");
  if (tb) {
    const mk = (label, bv, av, isTotal, invert) => {
      const diff = av - bv; let cls = "";
      if (diff !== 0) { const good = invert ? diff < 0 : diff > 0; cls = good ? "pos" : "neg"; }
      return `<tr class="${isTotal ? "total" : ""}"><td class="l rowlabel">${label}</td><td class="col-budget">${yen(bv)}</td><td>${yen(av)}</td><td class="diff ${cls}">${diff === 0 ? yen(0) : yen(diff, { signed: true })}</td></tr>`;
    };
    const breakdown = isNCA(ev) ? "" :
      mk("宿泊費", b.lodging, a.lodging, false, true) + mk("食事費", b.meals, a.meals, false, true) +
      mk("会場費", b.venue, a.venue, false, true) + mk("任意費目", b.misc, a.misc, false, true);
    tb.innerHTML = mk("収入", b.income, a.income, false, false) + breakdown +
      mk("支出", b.expense, a.expense, true, true) + mk("収支", b.net, a.net, true, false);
  }
  const hd = document.querySelector(".panel-head .num b");
  if (hd) { hd.textContent = (a.net < 0 ? "−" : "") + "¥" + fmt(Math.abs(a.net)); hd.className = "money " + (a.net >= 0 ? "pos" : "neg"); }
}
function setText(sel, t) { const el = document.querySelector(sel); if (el) el.textContent = t; }
function setClass(sel, pos) { const el = document.querySelector(sel); if (el) { el.classList.toggle("pos", pos); el.classList.toggle("neg", !pos); } }

/* ============================================================
   入力ハンドリング
   ============================================================ */
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.f != null) return handleFieldInput(t);
  if (t.dataset.set != null) return handleSettingInput(t);
  if (t.dataset.rep != null) {           // 収支一覧の絞り込み
    ui.report = ui.report || { from: "", to: "", cat: "" };
    ui.report[t.dataset.rep] = t.value;
    renderReport();
    return;
  }
});

/* 選ばれた部屋タイプの既定定員を反映する。変更したら true を返す */
function applyDefaultCapacity(row, roomType) {
  const def = state.settings.room_defaults.find(d => d.room_type === roomType);
  if (!def) return false;
  const cap = Math.max(0, n(def.capacity));
  if (n(row.capacity_per_room) === cap) return false;
  row.capacity_per_room = cap;
  return true;
}

function parseField(t, val) {
  // 数値項目か文字列項目か判定
  const numFields = ["paid_participant_count","participation_fee","other_income","target_profit",
    "capacity_per_room","room_count","unit_price","meal_count","quantity","count","amount"];
  if (t.dataset.f === "required_lodging_count") return val === "" ? null : Math.max(0, n(val));
  if (numFields.includes(t.dataset.f)) return Math.max(0, n(val));
  return val;
}

function handleFieldInput(t) {
  const ev = getEvent(); if (!ev) return;
  const rt = t.dataset.rt, f = t.dataset.f, rid = t.dataset.rid, val = t.value;
  const v = parseField(t, val);

  if (rt === "plan") {
    const p = ev.plans.find(x => x.id === rid); if (!p) return;
    p[f] = v;
    ev.updated_at = Date.now();
    commit(); repaintSim();
  } else if (rt === "lodging" || rt === "meal" || rt === "venue" || rt === "expense"
             || rt === "nca-income" || rt === "nca-expense") {
    const key = (rt === "nca-income") ? "nca_income_items" : (rt === "nca-expense") ? "nca_expense_items" : rt + "_items";
    const owner = ev.plans.find(pp => (pp[key] || []).some(r => r.id === rid)) || (ev.plans.find(x => x.id === ui.currentPlanId) || getPlan(ev));
    const arr = owner[key];
    const r = arr.find(x => x.id === rid); if (!r) return;
    r[f] = v;
    // 部屋タイプを選び直したら、設定にある既定の定員を入れ直す（あとから手で変更可）
    if (f === "room_type" && applyDefaultCapacity(r, v)) {
      ev.updated_at = Date.now();
      commit(); renderSim();   // 定員欄の表示も更新する必要があるため描き直す
      return;
    }
    ev.updated_at = Date.now();
    commit(); repaintSim();
  } else if (CANCEL_MAP[rt]) {
    // プランのキャンセル料
    const key = CANCEL_MAP[rt].arr;
    const owner = ev.plans.find(p => (p[key] || []).some(r => r.id === rid));
    const r = owner && owner[key].find(x => x.id === rid); if (!r) return;
    r[f] = v; ev.updated_at = Date.now(); commit(); repaintSim();
  } else if (rt === "a-plan") {
    if (!ev.actual) return;
    ev.actual[f] = v; commit(); repaintActual();
  } else if (rt === "a-lodging" || rt === "a-meal" || rt === "a-venue" || rt === "a-expense") {
    if (!ev.actual) return;
    const key = rt.slice(2) + "_items";
    const r = ev.actual[key].find(x => x.id === rid); if (!r) return;
    r[f] = v; commit(); repaintActual();
  } else if (rt === "a-nca-income" || rt === "a-nca-expense") {
    if (!ev.actual) return;
    const key = (rt === "a-nca-income") ? "nca_income_items" : "nca_expense_items";
    const r = (ev.actual[key] || []).find(x => x.id === rid); if (!r) return;
    r[f] = v; commit(); repaintActual();
  } else if (CANCEL_MAP[rt.replace(/^a-/, "")] && rt.startsWith("a-")) {
    // 実績のキャンセル料
    if (!ev.actual) return;
    const key = CANCEL_MAP[rt.slice(2)].arr;
    const r = (ev.actual[key] || []).find(x => x.id === rid); if (!r) return;
    r[f] = v; commit(); repaintActual();
  }
}
function findRowOwner(ev, rt, rid) {
  const key = rt + "_items";
  return ev.plans.find(p => p[key].some(r => r.id === rid));
}

function handleSettingInput(t) {
  const s = state.settings, key = t.dataset.set, i = t.dataset.i != null ? +t.dataset.i : null;
  if (key === "target") s.default_target_profit = Math.max(0, n(t.value));
  else if (key === "room-type") s.room_defaults[i].room_type = t.value;
  else if (key === "room-cap") s.room_defaults[i].capacity = Math.max(0, n(t.value));
  else if (key === "meal") s.meal_defaults[i] = t.value;
  else if (key === "cat") s.event_categories[i] = t.value;
  else if (key === "nca-inc") s.nca_income_types[i] = t.value;
  else if (key === "nca-exp") s.nca_expense_types[i] = t.value;
  else if (key === "tpl-cat") s.expense_templates[i].category = t.value;
  else if (key === "tpl-name") s.expense_templates[i].name = t.value;
  commitSettings();
}

/* ---------- クリックアクション ---------- */
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act, id = btn.dataset.id;
  const ev = getEvent();

  switch (act) {
    /* ナビ */
    case "goto-events": switchView("events"); break;
    case "goto-sim": switchView("sim"); break;
    case "switch-event": break; // selectはchangeで処理

    /* イベント一覧 */
    case "new-event": openEventModal(null); break;
    case "open-event":
      ui.currentEventId = id;
      const oev = getEvent(); ui.currentPlanId = oev && oev.plans[0] ? oev.plans[0].id : null;
      switchView("sim"); break;
    case "dup-event": duplicateEvent(id); break;
    case "del-event": confirmDelete("このイベントを削除しますか？", "プラン・予算・実績もすべて削除されます。", () => {
        state.events = state.events.filter(x => x.id !== id);
        if (ui.currentEventId === id) ui.currentEventId = state.events[0]?.id || null;
        deleteEventRemote(id); render(); toast("イベントを削除しました");
      }); break;
    case "rename-event": openEventModal(ev); break;

    /* プラン */
    case "select-plan": ui.currentPlanId = id; renderSim(); break;
    case "toggle-plan": {
      // 名前入力欄やボタンのクリックでは開閉しない
      if (e.target.closest("input, button") && !e.target.closest(".chev-main")) {
        if (e.target.tagName === "INPUT") break;
      }
      ui.collapsed[id] = !ui.collapsed[id];
      btn.closest(".plan-card").classList.toggle("collapsed", !!ui.collapsed[id]);
      break;
    }
    case "toggle-all-plans": {
      const anyOpen = ev.plans.some(p => !ui.collapsed[p.id]);
      ev.plans.forEach(p => ui.collapsed[p.id] = anyOpen);
      renderSim(); break;
    }
    case "add-plan": {
      /* 直前のプランを丸ごとコピーして追加する。
         人数や室数だけ違うプランを作ることが多く、毎回入れ直す手間を省くため。
         プランが1つも無いときだけ、空のプランを作る。 */
      const src = ev.plans[ev.plans.length - 1];
      const p = src ? deepCopyPlan(src) : newPlan(state.settings, "");
      p.name = nextPlanName(ev);
      p.is_selected_budget = false;   // 採用予算は引き継がない
      ev.plans.push(p); ui.currentPlanId = p.id; ui.collapsed[p.id] = false;
      ev.updated_at = Date.now();
      commit(); renderSim();
      toast(src ? `「${src.name}」の内容をコピーしました` : "プランを追加しました");
      break;
    }
    case "dup-plan": {
      const src = ev.plans.find(x => x.id === id); if (!src) break;
      const copy = deepCopyPlan(src); copy.name = src.name + " のコピー"; copy.is_selected_budget = false;
      ev.plans.push(copy); ui.currentPlanId = copy.id; ev.updated_at = Date.now();
      commit(); renderSim(); toast("プランを複製しました"); break;
    }
    case "del-plan":
      if (ev.plans.length <= 1) { toast("最後のプランは削除できません"); break; }
      confirmDelete("このプランを削除しますか？", "", () => {
        ev.plans = ev.plans.filter(x => x.id !== id);
        if (ui.currentPlanId === id) ui.currentPlanId = ev.plans[0].id;
        ev.updated_at = Date.now(); commit(); renderSim(); toast("プランを削除しました");
      }); break;
    case "adopt-plan": adoptPlan(ev, id); break;

    /* 行追加 */
    case "add-lodging": addRow(ev, id, "lodging"); break;
    case "add-meal": addRow(ev, id, "meal"); break;
    case "add-venue": addRow(ev, id, "venue"); break;
    case "add-expense": addRow(ev, id, "expense"); break;
    case "add-nca-income": addRow(ev, id, "nca-income"); break;
    case "add-nca-expense": addRow(ev, id, "nca-expense"); break;
    case "del-row": deleteRow(ev, btn.dataset.rt, btn.dataset.rid); break;
    case "add-cancel": addCancelRow(ev, id, btn.dataset.sec); break;
    case "del-cancel": deleteCancelRow(ev, btn.dataset.rt, btn.dataset.rid); break;
    case "add-a-cancel": addActualCancelRow(ev, btn.dataset.sec); break;

    /* 実績 */
    case "init-actual-copy": initActual(ev, true); break;
    case "init-actual-blank": initActual(ev, false); break;
    case "add-a-lodging": addActualRow(ev, "lodging"); break;
    case "add-a-meal": addActualRow(ev, "meal"); break;
    case "add-a-venue": addActualRow(ev, "venue"); break;
    case "add-a-expense": addActualRow(ev, "expense"); break;
    case "add-a-nca-income": addActualRow(ev, "nca-income"); break;
    case "add-a-nca-expense": addActualRow(ev, "nca-expense"); break;
    case "confirm-actual": {
      if (!ev.actual) break;
      const a = calcBlock(ev.actual);
      ev.actual_confirmed = {
        at: Date.now(),
        by: currentUser ? currentUser.email : "",
        income: a.income, expense: a.expense, net: a.net,
        lodging: a.lodging, meals: a.meals, venue: a.venue, misc: a.misc,
      };
      ev.status = "完了";
      ev.updated_at = Date.now();
      commit(); renderActual();
      toast("実績を確定しました。「収支一覧」で確認できます");
      break;
    }
    case "unconfirm-actual":
      confirmDelete("確定を取り消しますか？", "「収支一覧」の集計から外れます。実績の入力内容は残ります。", () => {
        ev.actual_confirmed = null;
        ev.status = "実績入力中";
        ev.updated_at = Date.now();
        commit(); renderActual(); toast("確定を取り消しました");
      }, "取り消す");
      break;

    case "reset-budget": confirmDelete("予算スナップショットを解除しますか？", "実績データも削除されます。", () => {
        ev.budget_snapshot = null; ev.actual = null; ev.actual_confirmed = null;
        ev.plans.forEach(p => p.is_selected_budget = false);
        ev.status = "試算中"; ev.updated_at = Date.now();
        commit(); renderActual(); toast("予算を解除しました");
      }); break;
    case "clear-actual": confirmDelete("実績データをクリアしますか？", "", () => {
        ev.actual = null; ev.actual_confirmed = null; ev.status = "予算確定"; ev.updated_at = Date.now();
        commit(); renderActual(); toast("実績をクリアしました");
      }); break;

    /* 設定 */
    case "add-set-room": state.settings.room_defaults.push({ room_type: "新規", capacity: 1 }); commitSettings(); renderSettings(); break;
    case "del-set-room": state.settings.room_defaults.splice(+btn.dataset.i, 1); commitSettings(); renderSettings(); break;
    case "add-set-cat": state.settings.event_categories.push("新しい区分"); commitSettings(); renderSettings(); break;
    case "add-set-nca-inc": state.settings.nca_income_types.push("新しい参加種別"); commitSettings(); renderSettings(); break;
    case "del-set-nca-inc": state.settings.nca_income_types.splice(+btn.dataset.i, 1); commitSettings(); renderSettings(); break;
    case "add-set-nca-exp": state.settings.nca_expense_types.push("新しい支出区分"); commitSettings(); renderSettings(); break;
    case "del-set-nca-exp": state.settings.nca_expense_types.splice(+btn.dataset.i, 1); commitSettings(); renderSettings(); break;
    case "del-set-cat": {
      const cat = state.settings.event_categories[+btn.dataset.i];
      const used = state.events.filter(e => (e.category || "") === cat).length;
      const go = () => {
        state.settings.event_categories.splice(+btn.dataset.i, 1);
        commitSettings(); renderSettings(); toast("区分を削除しました");
      };
      if (used) confirmDelete(`「${cat}」を削除しますか？`,
        `この区分のイベントが${used}件あります。削除してもイベントは残り、「未分類」として表示されます。`, go);
      else go();
      break;
    }
    case "add-set-meal": state.settings.meal_defaults.push("新規タイミング"); commitSettings(); renderSettings(); break;
    case "del-set-meal": state.settings.meal_defaults.splice(+btn.dataset.i, 1); commitSettings(); renderSettings(); break;
    case "add-set-tpl": state.settings.expense_templates.push({ category: "その他", name: "新規" }); commitSettings(); renderSettings(); break;
    case "del-set-tpl": state.settings.expense_templates.splice(+btn.dataset.i, 1); commitSettings(); renderSettings(); break;
    case "copy-report": copyReport(); break;
    case "clear-report-filter": ui.report = { from: "", to: "", cat: "" }; renderReport(); break;
    case "open-event-report":
      ui.currentEventId = id; ui.currentPlanId = null;
      switchView("actual"); break;
    case "import-sheet": openImportModal(); break;
    case "export-data": exportData(); break;
    case "add-invite": addInvite(); break;
    case "toggle-invite": toggleInvite(id); break;
    case "remove-invite":
      confirmDelete("この招待を削除しますか？", "まだログインしていなければ、以後そのメールではアクセスできなくなります。", () => removeInvite(id));
      break;
    case "toggle-user": toggleUser(id); break;
    case "remove-user":
      confirmDelete("この利用者を削除しますか？", "次回ログイン時にアクセスできなくなります（同じメールを招待し直せば再登録できます）。", () => removeUser(id));
      break;
    case "help-jump": {
      const target = document.getElementById("help-" + btn.dataset.id);
      if (target) target.scrollIntoView({ block: "start" });
      break;
    }
  }
});

/* selectのchange */
document.addEventListener("change", (e) => {
  if (e.target.dataset.act === "switch-event") {
    ui.currentEventId = e.target.value;
    const ev = getEvent(); ui.currentPlanId = ev && ev.plans[0] ? ev.plans[0].id : null;
    render();
  }
  if (e.target.dataset.act === "sort-events") {
    ui.eventSort = e.target.value;
    renderEvents();
  }
});

/* ---------- アクション実装 ---------- */
function switchView(v) { ui.view = v; render(); window.scrollTo({ top: 0 }); }

function addRow(ev, planId, type) {
  const p = ev.plans.find(x => x.id === planId); if (!p) return;
  if (type === "lodging") {
    const def = state.settings.room_defaults[0] || { room_type: "", capacity: 1 };
    p.lodging_items.push({ id: uid(), hotel_name: "", room_type: def.room_type, capacity_per_room: def.capacity, room_count: 1, unit_price: 0, note: "", sort_order: p.lodging_items.length });
  } else if (type === "meal") {
    p.meal_items.push({ id: uid(), timing: "新規", meal_count: 0, unit_price: 0, note: "", sort_order: p.meal_items.length });
  } else if (type === "venue") {
    p.venue_items = p.venue_items || [];
    p.venue_items.push({ id: uid(), date: "", name: "", quantity: 1, unit_price: 0, note: "", sort_order: p.venue_items.length });
  } else if (type === "expense") {
    p.expense_items.push({ id: uid(), category: "その他", name: "", unit_price: 0, quantity: 1, note: "", sort_order: p.expense_items.length });
  } else if (type === "nca-income") {
    p.nca_income_items = p.nca_income_items || [];
    p.nca_income_items.push({ id: uid(), kind: (state.settings.nca_income_types || [])[0] || "", count: 0, unit_price: 0, note: "" });
  } else if (type === "nca-expense") {
    p.nca_expense_items = p.nca_expense_items || [];
    p.nca_expense_items.push({ id: uid(), category: (state.settings.nca_expense_types || [])[0] || "", name: "", count: 1, unit_price: 0, note: "" });
  }
  ev.updated_at = Date.now(); commit(); renderSim();
}
function ncaKeyFor(rt) {
  const base = rt.replace(/^a-/, "");
  if (base === "nca-income") return "nca_income_items";
  if (base === "nca-expense") return "nca_expense_items";
  return null;
}
function deleteRow(ev, rt, rid) {
  if (rt.startsWith("a-")) {
    const key = ncaKeyFor(rt) || (rt.slice(2) + "_items");
    ev.actual[key] = (ev.actual[key] || []).filter(r => r.id !== rid);
    commit(); renderActual(); return;
  }
  const ncaKey = ncaKeyFor(rt);
  if (ncaKey) {
    const owner = ev.plans.find(pp => (pp[ncaKey] || []).some(r => r.id === rid)); if (!owner) return;
    confirmDelete("この行を削除しますか？", "", () => {
      owner[ncaKey] = owner[ncaKey].filter(r => r.id !== rid);
      ev.updated_at = Date.now(); commit(); renderSim();
    });
    return;
  }
  const owner = findRowOwner(ev, rt, rid); if (!owner) return;
  confirmDelete("この行を削除しますか？", "", () => {
    owner[rt + "_items"] = owner[rt + "_items"].filter(r => r.id !== rid);
    ev.updated_at = Date.now(); commit(); renderSim();
  });
}
function addActualRow(ev, type) {
  if (!ev.actual) return;
  if (type === "lodging") ev.actual.lodging_items.push({ id: uid(), hotel_name: "", room_type: "", capacity_per_room: 1, room_count: 1, unit_price: 0, note: "" });
  else if (type === "meal") ev.actual.meal_items.push({ id: uid(), timing: "新規", meal_count: 0, unit_price: 0, note: "" });
  else if (type === "venue") { ev.actual.venue_items = ev.actual.venue_items || []; ev.actual.venue_items.push({ id: uid(), date: "", name: "", quantity: 1, unit_price: 0, note: "" }); }
  else if (type === "expense") ev.actual.expense_items.push({ id: uid(), category: "その他", name: "", unit_price: 0, quantity: 1, note: "" });
  else if (type === "nca-income") { ev.actual.nca_income_items = ev.actual.nca_income_items || []; ev.actual.nca_income_items.push({ id: uid(), kind: (state.settings.nca_income_types||[])[0]||"", count: 0, unit_price: 0, note: "" }); }
  else if (type === "nca-expense") { ev.actual.nca_expense_items = ev.actual.nca_expense_items || []; ev.actual.nca_expense_items.push({ id: uid(), category: (state.settings.nca_expense_types||[])[0]||"", name: "", count: 1, unit_price: 0, note: "" }); }
  commit(); renderActual();
}

/* キャンセル料の行追加・削除（sec は lc/mc/vc または a-lc/a-mc/a-vc） */
function addCancelRow(ev, planId, sec) {
  const p = ev.plans.find(x => x.id === planId); if (!p) return;
  const key = CANCEL_MAP[sec].arr;
  p[key] = p[key] || [];
  p[key].push({ id: uid(), name: "", amount: 0 });
  ev.updated_at = Date.now(); commit(); renderSim();
}
function addActualCancelRow(ev, sec) {
  if (!ev.actual) return;
  const key = CANCEL_MAP[sec.slice(2)].arr;
  ev.actual[key] = ev.actual[key] || [];
  ev.actual[key].push({ id: uid(), name: "", amount: 0 });
  commit(); renderActual();
}
function deleteCancelRow(ev, rt, rid) {
  if (rt.startsWith("a-")) {
    const key = CANCEL_MAP[rt.slice(2)].arr;
    ev.actual[key] = (ev.actual[key] || []).filter(r => r.id !== rid);
    commit(); renderActual(); return;
  }
  const key = CANCEL_MAP[rt].arr;
  const owner = ev.plans.find(p => (p[key] || []).some(r => r.id === rid)); if (!owner) return;
  owner[key] = owner[key].filter(r => r.id !== rid);
  ev.updated_at = Date.now(); commit(); renderSim();
}

function adoptPlan(ev, planId) {
  const p = ev.plans.find(x => x.id === planId); if (!p) return;
  const proceed = () => {
    ev.plans.forEach(x => x.is_selected_budget = (x.id === planId));
    const snap = deepCopyPlan(p);
    snap.source_plan_id = p.id;
    snap.source_plan_name = p.name;
    snap.snapshot_at = Date.now();
    ev.budget_snapshot = snap;
    ev.status = ev.actual ? "実績入力中" : "予算確定";
    ev.updated_at = Date.now();
    commit(); renderSim();
    toast(`「${p.name}」を予算として採用しました`);
  };
  if (ev.budget_snapshot) {
    confirmDelete("予算を上書きしますか？", "現在の予算スナップショットが新しいプランで置き換わります（実績データは保持されます）。", proceed, "上書きして採用");
  } else proceed();
}

function initActual(ev, copyFromBudget) {
  if (copyFromBudget && ev.budget_snapshot) {
    ev.actual = deepCopyPlan(ev.budget_snapshot);
    delete ev.actual.source_plan_id; delete ev.actual.source_plan_name; delete ev.actual.snapshot_at;
    ev.actual.is_selected_budget = false;
  } else {
    ev.actual = newPlan(state.settings, "実績");
    ev.actual.meal_items = []; // 空から
  }
  ev.status = "実績入力中"; ev.updated_at = Date.now();
  commit(); renderActual();
}

function duplicateEvent(id) {
  const src = state.events.find(x => x.id === id); if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid(); copy.name = src.name + " のコピー";
  copy.status = "試算中"; copy.budget_snapshot = null; copy.actual = null; copy.actual_confirmed = null;
  copy.created_at = Date.now(); copy.updated_at = Date.now();
  copy.plans.forEach(p => { p.id = uid(); p.is_selected_budget = false;
    p.lodging_items.forEach(r => r.id = uid());
    p.meal_items.forEach(r => r.id = uid());
    (p.venue_items = p.venue_items || []).forEach(r => r.id = uid());
    p.expense_items.forEach(r => r.id = uid());
    ["lodging_cancels","meal_cancels","venue_cancels","nca_income_items","nca_expense_items"].forEach(k => (p[k] = p[k] || []).forEach(r => r.id = uid()));
  });
  state.events.push(copy); scheduleSaveEvent(copy); render(); toast("イベントを複製しました");
}
/* 既存の名前とぶつからない「プランN」を作る */
function nextPlanName(ev) {
  const used = new Set(ev.plans.map(p => p.name));
  let i = ev.plans.length + 1;
  while (used.has("プラン" + i)) i++;
  return "プラン" + i;
}

function deepCopyPlan(p) {
  const c = JSON.parse(JSON.stringify(p));
  c.id = uid();
  c.lodging_items.forEach(r => r.id = uid());
  c.meal_items.forEach(r => r.id = uid());
  (c.venue_items = c.venue_items || []).forEach(r => r.id = uid());
  c.expense_items.forEach(r => r.id = uid());
  ["lodging_cancels","meal_cancels","venue_cancels","nca_income_items","nca_expense_items"].forEach(k => (c[k] = c[k] || []).forEach(r => r.id = uid()));
  return c;
}

/* ============================================================
   モーダル / トースト
   ============================================================ */
function openEventModal(evOrNull) {
  const isNew = !evOrNull;
  const ev = evOrNull || {};
  const scrim = document.createElement("div");
  scrim.className = "modal-scrim";
  scrim.innerHTML = `<div class="modal">
    <h3>${isNew ? "新規イベント" : "イベントの編集"}</h3>
    <div class="m-body">
      <label class="fl">イベント名</label>
      <input id="m-name" value="${esc(ev.name || "")}" placeholder="例：秋の合宿2026" autocomplete="off">
      <label class="fl">区分</label>
      <select id="m-category">
        ${(state.settings.event_categories || []).map(cat =>
          `<option value="${esc(cat)}" ${(ev.category || "") === cat ? "selected" : ""}>${esc(cat)}</option>`).join("")}
        <option value="" ${!ev.category ? "selected" : ""}>${UNCATEGORIZED}</option>
      </select>
      <div class="grid2">
        <div><label class="fl">開催開始日</label><input id="m-start" type="date" value="${esc(ev.start_date || "")}"></div>
        <div><label class="fl">開催終了日</label><input id="m-end" type="date" value="${esc(ev.end_date || "")}"></div>
      </div>
      ${!isNew ? `<label class="fl">状態</label>
      <select id="m-status">
        ${["試算中","予算確定","実績入力中","完了"].map(s => `<option ${ev.status === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>` : ""}
    </div>
    <div class="m-foot">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="m-save">${isNew ? "作成" : "保存"}</button>
    </div>
  </div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener("click", (e) => { if (e.target === scrim || e.target.hasAttribute("data-close")) close(); });
  const nameInput = scrim.querySelector("#m-name");
  nameInput.focus(); nameInput.select();
  scrim.querySelector("#m-save").addEventListener("click", () => {
    const name = nameInput.value.trim() || "無題のイベント";
    const start = scrim.querySelector("#m-start").value;
    const end = scrim.querySelector("#m-end").value;
    const category = scrim.querySelector("#m-category").value;
    if (isNew) {
      const e2 = newEvent(state.settings, name, category);
      e2.start_date = start; e2.end_date = end;
      state.events.push(e2);
      ui.currentEventId = e2.id; ui.currentPlanId = e2.plans[0].id;
      commit(); close(); switchView("sim"); toast("イベントを作成しました");
    } else {
      const real = getEvent();
      real.name = name; real.category = category; real.start_date = start; real.end_date = end;
      real.status = scrim.querySelector("#m-status").value;
      real.updated_at = Date.now();
      commit(); close(); render(); toast("保存しました");
    }
  });
  scrim.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "m-name") scrim.querySelector("#m-save").click(); });
}

function confirmDelete(title, desc, onYes, yesLabel) {
  const scrim = document.createElement("div");
  scrim.className = "modal-scrim";
  scrim.innerHTML = `<div class="modal">
    <h3>${esc(title)}</h3>
    <div class="m-body"><p>${desc ? esc(desc) : "この操作は取り消せません。"}</p></div>
    <div class="m-foot">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="c-yes" style="background:var(--neg);border-color:var(--neg)">${esc(yesLabel || "削除する")}</button>
    </div>
  </div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener("click", (e) => { if (e.target === scrim || e.target.hasAttribute("data-close")) close(); });
  scrim.querySelector("#c-yes").addEventListener("click", () => { close(); onYes(); });
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ---------- データ入出力 ----------
   共有相手とデータをやり取りする唯一の手段。ファイルのダウンロードは
   埋め込み環境で制限されることがあるため、コピー＆ペーストを主経路にする。 */
function exportData() {
  const json = JSON.stringify(state, null, 2);
  const scrim = document.createElement("div");
  scrim.className = "modal-scrim";
  scrim.innerHTML = `<div class="modal wide">
    <h3>データを書き出す</h3>
    <div class="m-body">
      <p>下のテキストをすべてコピーして、相手に送ってください。受け取った人は「データを読み込む」に貼り付けます。</p>
      <textarea id="x-json" class="json-box" readonly>${esc(json)}</textarea>
      <div class="x-meta">イベント ${state.events.length}件 ／ ${(json.length / 1024).toFixed(1)} KB</div>
    </div>
    <div class="m-foot">
      <button class="btn" data-close>閉じる</button>
      <button class="btn" id="x-file">ファイルで保存</button>
      <button class="btn primary" id="x-copy">コピーする</button>
    </div>
  </div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener("click", (e) => { if (e.target === scrim || e.target.hasAttribute("data-close")) close(); });

  scrim.querySelector("#x-copy").addEventListener("click", async () => {
    const ta = scrim.querySelector("#x-json");
    let ok = false;
    try { await navigator.clipboard.writeText(json); ok = true; }
    catch (_) {
      // クリップボードAPIが使えない環境では選択状態にして手動コピーを促す
      ta.removeAttribute("readonly"); ta.focus(); ta.select();
      try { ok = document.execCommand("copy"); } catch (__) { ok = false; }
      ta.setAttribute("readonly", "");
    }
    toast(ok ? "コピーしました" : "自動コピーできません。文字を選んで Ctrl/⌘+C を押してください");
  });

  scrim.querySelector("#x-file").addEventListener("click", () => {
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "event-budget-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("ファイルを保存しました");
    } catch (e) {
      toast("この環境ではファイル保存できません。コピーをお使いください");
    }
  });
}

/* ============================================================
   スプレッドシートの内容を貼り付けて取り込む
   ------------------------------------------------------------
   共有設定を変えずに済むよう、URLからの自動取得はせず
   「コピー＆貼り付け」のみに対応する。
   ============================================================ */

/* イベントの区分から見た区分を推測する */
function guessCategory(name, extra) {
  const s = (name || "") + " " + (extra || "");
  if (/NCA/i.test(s)) return NCA_CATEGORY;
  if (/合宿/.test(s)) return "合宿";
  return "";
}

/* セルを数値に。「¥1,234」「(500)」なども読む。数値でなければ null */
function cellNum(v) {
  let s = String(v == null ? "" : v).replace(/[¥￥,，\s　]/g, "");
  if (!s) return null;
  let neg = false;
  if (/^[(（].+[)）]$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith("−") || s.startsWith("▲") || s.startsWith("△")) { neg = true; s = s.slice(1); }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const x = parseFloat(s);
  return neg ? -Math.abs(x) : x;
}

/* 「2025.3.8-3.9」「2024/3/2」などから開始日を取り出して YYYY-MM-DD にする */
function cellDate(v) {
  const s = String(v == null ? "" : v);
  // 「2023.6.-1.2」のように日の前にハイフンが入る書き方にも対応する
  const m = s.match(/(\d{4})\s*[.\/年-]\s*(\d{1,2})\s*[.\/月-]\s*-?\s*(\d{1,2})/);
  if (!m) return "";
  const pad = (x) => String(x).padStart(2, "0");
  const mo = +m[2], da = +m[3];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return "";
  return `${m[1]}-${pad(mo)}-${pad(da)}`;
}

/* CSV / TSV を2次元配列にする（引用符に対応） */
function parseTable(text) {
  const head = text.split("\n").slice(0, 5).join("\n");
  const d = head.includes("\t") ? "\t" : ",";
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/* 一覧シート（1行＝1イベント）かどうかを見出し行から判定する */
function findListHeader(rows) {
  const trimmedRows = rows.slice(0, Math.min(rows.length, 40))
    .map(r => r.map(x => String(x == null ? "" : x).trim()));

  for (let i = 0; i < trimmedRows.length; i++) {
    const c = trimmedRows[i];
    const idxName = c.findIndex(x => /イベント名|行事名|名称/.test(x));
    if (idxName < 0) continue;

    // 「収入」「支出」の見出しは、結合セルなどで数行上に離れていることがある。
    // イベント名の行を中心に、シートの先頭付近を広めに探す。
    let idxIn = -1, idxOut = -1;
    for (let d = 0; d <= 10 && (idxIn < 0 || idxOut < 0); d++) {
      for (const r of (d === 0 ? [i] : [i - d, i + d])) {
        if (r < 0 || r >= trimmedRows.length) continue;
        const rc = trimmedRows[r];
        const fin = rc.findIndex(x => /^収入/.test(x));
        const fout = rc.findIndex(x => /^支出/.test(x));
        if (fin >= 0 && fout >= 0) { idxIn = fin; idxOut = fout; break; }
      }
    }
    if (idxIn < 0 || idxOut < 0) continue;

    return { row: i, idxName, idxIn, idxOut,
      idxDate: c.findIndex(x => /日時|日付|開催/.test(x)),
      idxCat: c.findIndex(x => /会社|区分|種別|カテゴリ/.test(x)) };
  }
  return null;
}

/* 明細の各行を、名前の言葉から費目に振り分ける手がかり。
   表の見出し（会場費詳細、など）に頼らず、行の名前だけで判定する。
   理由：横並びの表を1回のコピーで貼り付けると、表の見出し行は含まれず
   データ行だけが渡されることが多いため。 */
const SHEET_ITEM_RULES = [
  { re: /シングル|ツイン|ダブル|トリプル|和室|洋室|素泊|宿泊|ホテル|客室|部屋/, key: "lodging", label: "宿泊" },
  { re: /弁当|昼食|夕食|朝食|食事|ランチ|ディナー|飲食|ドリンク/, key: "meal", label: "食事" },
  { re: /会場|ホール|会議室|貸室/, key: "venue", label: "会場" },
  { re: /懇親会|交流会/, key: "nca_party", label: "懇親会" },
  { re: /セミナー|講座|研修/, key: "nca_seminar", label: "セミナー" },
  { re: /備品|機材|設備/, key: "expense", label: "備品" },
  { re: /消費税/, key: "expense", label: "税" },
  { re: /交通|タクシー|バス|移動/, key: "expense", label: "交通費" },
];
const SHEET_CANCEL_RE = /キャンセル/;
const SHEET_INCOME_HINT_RE = /収入|参加費|入金|売上|会費|回収/;

/* 「イベント名」「開催日」などの見出しを、シート全体から拾う */
function readSheetMeta(rows) {
  const meta = { name: "", date: "" };
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r] || [];
    for (let c = 0; c < cells.length; c++) {
      const t = String(cells[c] || "").trim();
      const next = () => {
        for (let k = c + 1; k < Math.min(c + 4, cells.length); k++) {
          const v = String(cells[k] || "").trim();
          if (v) return v;
        }
        return "";
      };
      if (!meta.name && /^イベント名/.test(t)) meta.name = next();
      if (!meta.date && /^開催日/.test(t)) { const v = next(); meta.date = cellDate(v) || v; }
    }
    if (meta.name && meta.date) break;
  }
  return meta;
}

/* 表を読み取って、取り込める形に変換する */
function analyzeSheet(rows) {
  const head = findListHeader(rows);

  /* ---- 一覧シート（1行＝1イベント） ---- */
  if (head) {
    const events = [];
    for (let i = head.row + 1; i < rows.length; i++) {
      const c = rows[i].map(x => String(x == null ? "" : x).trim());
      const name = c[head.idxName] || "";
      const income = cellNum(c[head.idxIn]);
      const expense = cellNum(c[head.idxOut]);
      if (!name || income == null || expense == null) continue;
      const date = head.idxDate >= 0 ? cellDate(c[head.idxDate]) : "";
      const catCell = head.idxCat >= 0 ? c[head.idxCat] : "";
      const category = guessCategory(name, catCell);
      const dup = state.events.some(e => e.name === name && (!date || e.start_date === date));
      events.push({ name, date, category, income, expense, net: income - expense, dup });
    }
    if (events.length) return { type: "list", events };
  }

  /* ---- 明細（複数の表が縦・横に並ぶ管理シート／見積書） ----
     表ごとに見出し行（項目・人数・単価・合計…）を読み直しながら、
     上から順に処理する。表の位置（列）は当てにしない。空行やタイトル行を
     節目として、そのつど「いまの表の列構成」を更新していく。 */
  const items = [], checks = [];
  let cols = null;          // 今の表の列構成 {name, qty, unit, amount}
  let isIncomeTable = false;
  let target = "plan";      // "実際の…" と書かれた表は実績として扱う
  let tableLabel = "";
  let prevKey = null;       // キャンセル料の直前の費目
  let runningSum = 0;

  const resetTable = () => { cols = null; isIncomeTable = false; target = "plan"; prevKey = null; runningSum = 0; };

  for (const r of rows) {
    const cells = (r || []).map(x => String(x == null ? "" : x).trim());
    const nonEmpty = cells.filter(Boolean);

    if (!nonEmpty.length) { resetTable(); continue; }   // 空行＝表の切れ目

    // タイトルだけの行（例：「収入金額計算（予定）」）
    if (nonEmpty.length === 1 && !cols) {
      tableLabel = nonEmpty[0];
      isIncomeTable = SHEET_INCOME_HINT_RE.test(tableLabel);
      target = /実際|結果/.test(tableLabel) ? "actual" : "plan";
      continue;
    }

    // 見出し行かどうか（単価・合計の列があるか）
    if (!cols) {
      const uc = cells.findIndex(c => /単価|回収金額\s*\/?\s*人/.test(c));
      const ac = cells.findIndex(c => /合計.*金額|合計$/.test(c));
      if (uc >= 0 && ac >= 0) {
        const qc = cells.findIndex(c => /^(人数|回収人数|数量|室数|個数)$/.test(c));
        let nc = cells.findIndex(c => /^項目$/.test(c));
        if (nc < 0) nc = 0;
        cols = { name: nc, qty: qc, unit: uc, amount: ac };
        if (SHEET_INCOME_HINT_RE.test(cells.join(""))) isIncomeTable = true;
        continue;
      }
      continue;   // 見出しでも表データでもない行（サマリー等）は読み飛ばす
    }

    // データ行
    const name = cells[cols.name] || "";
    const amount = cellNum(cells[cols.amount]);
    if (/^合\s*計|^総\s*計/.test(name)) {
      if (amount != null) checks.push({ name: tableLabel || "合計", sum: runningSum, stated: amount,
        ok: Math.abs(runningSum - amount) < 1 });
      resetTable();
      continue;
    }
    if (amount == null || amount === 0) continue;   // 空欄・0円の行は取り込まない

    const qty = cols.qty >= 0 ? cellNum(cells[cols.qty]) : null;
    const unit = cols.unit >= 0 ? cellNum(cells[cols.unit]) : null;
    const isCancel = SHEET_CANCEL_RE.test(name);

    let key, label;
    if (isIncomeTable) { key = "income"; label = "収入"; }
    else if (isCancel && prevKey) {
      key = prevKey;
      label = (SHEET_ITEM_RULES.find(x => x.key === prevKey) || { label: "その他" }).label + "のキャンセル料";
    } else {
      const own = SHEET_ITEM_RULES.find(x => x.re.test(name));
      key = own ? own.key : "expense";
      label = own ? own.label : "その他";
    }
    if (!isCancel && !isIncomeTable) prevKey = key;

    runningSum += amount;
    items.push({ key, label, name, qty: qty == null ? 1 : qty, unit: unit == null ? amount : unit,
      amount, cancel: isCancel, target });
  }

  const totals = {};
  for (const it of items) totals[it.key] = (totals[it.key] || 0) + it.amount;
  return { type: "detail", items, totals, checks, meta: readSheetMeta(rows) };
}

/* 読み取った明細を、予算（プラン）や実績の入れ物に書き込む */
function fillBlockFromItems(block, items, nca, replace) {
  if (replace) {
    block.lodging_items = []; block.meal_items = []; block.venue_items = [];
    block.expense_items = []; block.nca_income_items = []; block.nca_expense_items = [];
    block.lodging_cancels = []; block.meal_cancels = []; block.venue_cancels = [];
  }
  ["lodging_items","meal_items","venue_items","expense_items","nca_income_items",
   "nca_expense_items","lodging_cancels","meal_cancels","venue_cancels"]
    .forEach(k => { if (!Array.isArray(block[k])) block[k] = []; });

  let otherIncome = 0, gotFee = false;
  for (const it of items) {
    /* 収入 */
    if (it.key === "income") {
      if (nca) {
        block.nca_income_items.push({ id: uid(), kind: it.name, count: it.qty, unit_price: it.unit, note: "" });
      } else if (!gotFee && it.qty > 1) {
        gotFee = true;                    // 最初の「人数×単価」を参加費として扱う
        block.paid_participant_count = it.qty;
        block.participation_fee = it.unit;
      } else otherIncome += it.amount;
      continue;
    }
    /* キャンセル料 */
    if (it.cancel) {
      if (nca) {
        const cat = it.key === "nca_seminar" ? "キャンセル料（セミナー）" : "キャンセル料（懇親会）";
        block.nca_expense_items.push({ id: uid(), category: cat, name: it.name, count: it.qty, unit_price: it.unit, note: "" });
      } else {
        const key = it.key === "meal" ? "meal_cancels" : it.key === "venue" ? "venue_cancels" : "lodging_cancels";
        block[key].push({ id: uid(), name: it.name, amount: it.amount });
      }
      continue;
    }
    /* 支出 */
    if (nca) {
      const cat = it.key === "nca_party" ? "懇親会費用"
                : it.key === "nca_seminar" ? "セミナー会場" : it.label;
      block.nca_expense_items.push({ id: uid(), category: cat, name: it.name, count: it.qty, unit_price: it.unit, note: "" });
    } else if (it.key === "lodging") {
      // 品名が「シングル」「ツイン」等そのままなら部屋タイプに、そうでなければホテル名として入れる
      const rd = (state.settings.room_defaults || []).find(d => it.name.startsWith(d.room_type));
      block.lodging_items.push({
        id: uid(), hotel_name: rd ? "" : it.name, room_type: rd ? rd.room_type : "",
        capacity_per_room: rd ? rd.capacity : 0,
        room_count: it.qty, unit_price: it.unit, note: "", sort_order: block.lodging_items.length });
    } else if (it.key === "meal") {
      block.meal_items.push({ id: uid(), timing: it.name, meal_count: it.qty, unit_price: it.unit,
        note: "", sort_order: block.meal_items.length });
    } else if (it.key === "venue") {
      block.venue_items.push({ id: uid(), date: "", name: it.name, quantity: it.qty, unit_price: it.unit,
        note: "", sort_order: block.venue_items.length });
    } else {
      block.expense_items.push({ id: uid(), category: it.label, name: it.name, unit_price: it.unit,
        quantity: it.qty, note: "", sort_order: block.expense_items.length });
    }
  }
  if (!nca && otherIncome) block.other_income = n(block.other_income) + otherIncome;
}

function applyDetailToPlan(ev, plan, parsed, replace) {
  const nca = isNCA(ev);
  const planItems = parsed.items.filter(i => i.target !== "actual");
  const actualItems = parsed.items.filter(i => i.target === "actual");

  if (planItems.length) fillBlockFromItems(plan, planItems, nca, replace);

  if (actualItems.length) {
    // 実績を入れるには予算が必要なので、無ければ今のプランを予算として確定する
    if (!ev.budget_snapshot) {
      const snap = deepCopyPlan(plan);
      snap.source_plan_id = plan.id; snap.source_plan_name = plan.name; snap.snapshot_at = Date.now();
      ev.budget_snapshot = snap;
      ev.plans.forEach(x => x.is_selected_budget = (x.id === plan.id));
    }
    if (!ev.actual) ev.actual = emptyActual();
    fillBlockFromItems(ev.actual, actualItems, nca, replace);
    ev.status = "実績入力中";
  }
  ev.updated_at = Date.now();
}

function applyListAsEvents(parsed, skipDup) {
  let made = 0;
  for (const row of parsed.events) {
    if (skipDup && row.dup) continue;
    const e2 = newEvent(state.settings, row.name, row.category);
    e2.start_date = row.date; e2.end_date = row.date;
    e2.status = "完了";
    // 内訳のない一覧なので、確定した実績としてそのまま登録する
    e2.actual_confirmed = {
      at: Date.now(), by: currentUser ? currentUser.email : "",
      income: row.income, expense: row.expense, net: row.net,
      lodging: 0, meals: 0, venue: 0, misc: 0, imported: true,
    };
    state.events.push(e2);
    scheduleSaveEvent(e2);
    made++;
  }
  return made;
}

/* ---- 取り込み画面（貼り付けのみ） ---- */
function openImportModal() {
  const ev = getEvent();
  const scrim = document.createElement("div");
  scrim.className = "modal-scrim";
  scrim.innerHTML = `<div class="modal wide">
    <h3>スプレッドシートから取り込む</h3>
    <div class="m-body">
      ${!ev ? `<div class="imp-meta warn">
        イベントが選ばれていません。<b>一覧シート</b>（複数イベントを一括登録）はこのまま取り込めますが、
        <b>明細シート</b>（1イベント分の内訳）を反映するには、先に「イベント一覧」から対象のイベントを開いてください。
      </div>` : `<div class="imp-meta">取り込み先：<b>${esc(ev.name)}</b>（明細シートの場合）</div>`}
      <p>スプレッドシートで範囲を選んでコピー（⌘C）し、下に貼り付けてください。
        共有設定を変える必要はありません。</p>
      <textarea id="imp-text" class="json-box" placeholder="ここに貼り付け"></textarea>
      <div id="imp-result"></div>
    </div>
    <div class="m-foot">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="imp-read">読み取る</button>
    </div>
  </div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim || e.target.hasAttribute("data-close")) close();
  });

  const resultBox = scrim.querySelector("#imp-result");
  let parsed = null;

  scrim.querySelector("#imp-read").addEventListener("click", () => {
    const text = scrim.querySelector("#imp-text").value;
    if (!text.trim()) {
      resultBox.innerHTML = `<div class="imp-status err">内容が空です。</div>`;
      return;
    }
    parsed = analyzeSheet(parseTable(text));
    renderImportPreview(resultBox, ev, parsed, close);
  });
}

function renderImportPreview(box, ev, parsed, close) {
  if (parsed.type === "list") {
    const news = parsed.events.filter(e => !e.dup).length;
    const dups = parsed.events.length - news;
    box.innerHTML = `<div class="imp-status ok">一覧シートとして読み取りました（${parsed.events.length}件）</div>
      <div class="lines-wrap"><table class="lines compact imp-prev">
        <thead><tr><th class="l">開催日</th><th class="l">イベント名</th><th class="l">区分</th><th>収入</th><th>支出</th><th>収支</th></tr></thead>
        <tbody>${parsed.events.map(e => `<tr class="${e.dup ? "dup" : ""}">
          <td class="l num">${esc(e.date || "—")}</td>
          <td class="l">${esc(e.name)}${e.dup ? ' <span class="imp-dup">既にあります</span>' : ""}</td>
          <td class="l">${esc(e.category || UNCATEGORIZED)}</td>
          <td class="amt">${fmt(e.income)}</td><td class="amt">${fmt(e.expense)}</td>
          <td class="amt"><span class="money ${e.net >= 0 ? "pos" : "neg"}">${fmt(e.net)}</span></td>
        </tr>`).join("")}</tbody></table></div>
      <div class="imp-note">確定した実績として登録し、「収支一覧」に集計されます。
        ${dups ? `同じ名前のイベントが${dups}件あるため、その分は取り込みません。` : ""}</div>
      <div class="imp-actions"><button class="btn primary" id="imp-apply">${news}件を取り込む</button></div>`;
    const btn = box.querySelector("#imp-apply");
    if (!news) { btn.disabled = true; btn.textContent = "取り込むものがありません"; return; }
    btn.addEventListener("click", () => {
      const made = applyListAsEvents(parsed, true);
      close(); render(); toast(`${made}件のイベントを取り込みました`);
    });
    return;
  }

  // 明細シート
  if (!parsed.items.length) {
    box.innerHTML = `<div class="imp-status err">金額のある明細を読み取れませんでした。<br><br>
      よくある原因：<b>1つの行に複数の表が横並びになっている</b>シートです
      （見出しが結合セルになっていたり、集計表とシミュレーション表が同じ行に同居しているケース）。<br><br>
      <b>実際に使いたい明細（項目・人数・単価・合計の並び）だけ</b>を選んでコピー＆貼り付けしてください。
      ざっくり集計やシミュレーション表は含めないでください（同じ金額を二重に取り込んでしまいます）。</div>`;
    return;
  }
  if (!ev) {
    box.innerHTML = `<div class="imp-status err">先にイベントを選んでください。
      明細シートは、選択中のイベントのプランに反映します。</div>`;
    return;
  }
  const plan = getPlan(ev);
  const sum = parsed.items.reduce((s, i) => s + (i.key === "income" ? 0 : i.amount), 0);
  const inc = parsed.items.reduce((s, i) => s + (i.key === "income" ? i.amount : 0), 0);
  const meta = parsed.meta || {};
  const checks = parsed.checks || [];
  const nameDiff = meta.name && ev.name && meta.name !== ev.name;
  const hasActual = parsed.items.some(i => i.target === "actual");

  box.innerHTML = `<div class="imp-status ok">シートを読み取りました（${parsed.items.length}行）</div>

    ${meta.name || meta.date ? `<div class="imp-meta ${nameDiff ? "warn" : ""}">
      シートのイベント：<b>${esc(meta.name || "（名前なし）")}</b>${meta.date ? `　${esc(meta.date)}` : ""}
      ${nameDiff ? `<br>取り込み先は「${esc(ev.name)}」です。別のイベントのシートではないか確認してください。` : ""}
    </div>` : ""}

    ${checks.length ? `<div class="imp-check">
      ${checks.map(c => `<div class="${c.ok ? "ok" : "ng"}">
        ${c.ok ? "✓" : "⚠"} ${esc(c.name)}：読み取り ¥${fmt(c.sum)} ／ シートの合計 ¥${fmt(c.stated)}
        ${c.ok ? "（一致）" : "（差 ¥" + fmt(c.sum - c.stated) + "）"}
      </div>`).join("")}
    </div>` : ""}

    <div class="lines-wrap"><table class="lines compact imp-prev">
      <thead><tr><th class="l">区分</th><th class="l">項目</th><th>数量</th><th>単価</th><th>金額</th></tr></thead>
      <tbody>${parsed.items.map(i => `<tr>
        <td class="l"><span class="pill ${i.key === "income" ? "s-done" : i.cancel ? "s-actual" : "s-est"}">${esc(i.label)}</span>${
          i.target === "actual" ? ' <span class="imp-dup">実績</span>' : ""}</td>
        <td class="l">${esc(i.name)}</td>
        <td class="amt">${fmt(i.qty)}</td><td class="amt">${fmt(i.unit)}</td><td class="amt">${fmt(i.amount)}</td>
      </tr>`).join("")}</tbody></table></div>
    <div class="imp-sum">支出 合計 <b class="num">¥${fmt(sum)}</b>${inc ? ` ／ 収入 合計 <b class="num">¥${fmt(inc)}</b>` : ""}</div>
    <div class="imp-note">「${esc(ev.name)}」の<b>${esc(plan ? plan.name : "プラン")}</b>に反映します。
      ${hasActual ? "「実際の…」の欄に入力があるため、実績にも反映します。" : ""}
      区分の振り分けが違う場合は、取り込んだあとに画面上で直せます。</div>
    <div class="imp-actions">
      <button class="btn" id="imp-append">今の内容に追加する</button>
      <button class="btn primary" id="imp-replace">今の内容を置き換える</button>
    </div>`;

  const go = (replace) => {
    applyDetailToPlan(ev, plan, parsed, replace);
    commit(); close(); renderSim();
    toast(replace ? "取り込んで置き換えました" : "取り込んで追加しました");
  };
  box.querySelector("#imp-append").addEventListener("click", () => go(false));
  box.querySelector("#imp-replace").addEventListener("click", () => {
    close();
    confirmDelete("今の内容を置き換えますか？",
      "このプランの宿泊・食事・会場・費目の行がすべて入れ替わります。", () => {
        applyDetailToPlan(ev, plan, parsed, true);
        commit(); render(); toast("取り込んで置き換えました");
      }, "置き換える");
  });
}

/* ---------- テーマ切替 ---------- */
document.getElementById("themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const cur = root.getAttribute("data-theme");
  const sysDark = matchMedia("(prefers-color-scheme: dark)").matches;
  let next;
  if (!cur) next = sysDark ? "light" : "dark";
  else if (cur === "dark") next = "light";
  else next = "dark";
  root.setAttribute("data-theme", next);
});

/* ---------- タブ ---------- */
document.getElementById("tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab"); if (!tab) return;
  switchView(tab.dataset.view);
});

/* ---------- 初期化 ---------- */
/* 動作確認・不具合調査用の窓口。ブラウザの開発者ツールから
   __app.state で現在のデータを確認できる。 */
window.__app = {
  get state() { return state; },
  get ui() { return ui; },
  get user() { return currentUser; },
  render, calcBlock,
};

boot();
