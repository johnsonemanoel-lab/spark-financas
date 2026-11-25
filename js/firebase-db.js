/**
 * Camada de acesso ao Cloud Firestore (SDK Modular v11+) para o Spark Finanças.
 *
 * Usa persistência offline nativa (IndexedDB multi-aba) e listeners em tempo real (onSnapshot)
 * para garantir funcionamento offline no PWA e sincronização imediata entre celular e PC,
 * sem sobrescrever alterações locais pendentes.
 */

import {
  initializeApp,
  getApps,
  deleteApp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";

import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  persistentSingleTabManager,
  collection,
  doc,
  onSnapshot,
  writeBatch,
  serverTimestamp,
  getDocFromServer,
  getDocsFromServer,
  getDocs,
  waitForPendingWrites,
  terminate
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

let firebaseApp = null;
let firestoreDb = null;

const ALLOWED_ACCOUNT_TYPES = new Set(["free", "reserve", "receivable", "benefit", "credit"]);
const ALLOWED_TX_TYPES = new Set(["entrada", "saida", "pagamento_fatura"]);
const MAX_BATCH_OPS = 400;

/**
 * Remove valores undefined recursivamente (o Firestore rejeita campos undefined).
 * Preserva instâncias especiais do SDK (ex: FieldValue de serverTimestamp()).
 */
function sanitizeValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeValue(item))
      .filter((item) => item !== undefined);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const clean = sanitizeValue(v);
    if (clean !== undefined) {
      out[k] = clean;
    }
  }
  return out;
}

function toFiniteNumber(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? +n.toFixed(2) : fallback;
}

function toIntInRange(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function serializeAccount(acc) {
  const type = ALLOWED_ACCOUNT_TYPES.has(acc?.type) ? acc.type : "free";
  const payload = {
    name: String(acc?.name || "Conta").trim().slice(0, 80) || "Conta",
    balance: toFiniteNumber(acc?.balance, 0),
    type,
    updatedAt: serverTimestamp()
  };

  if (type === "credit") {
    payload.closingDay = toIntInRange(acc?.closingDay, 1, 31, 5);
    payload.dueDay = toIntInRange(acc?.dueDay, 1, 31, 12);
    payload.limit = Math.max(0, toFiniteNumber(acc?.limit, 2000));
  }

  return sanitizeValue(payload);
}

export function serializeMonth(monthObj, monthId) {
  const incomes = Array.isArray(monthObj?.incomes) ? monthObj.incomes.slice(0, 200) : [];
  const provisions = Array.isArray(monthObj?.provisions) ? monthObj.provisions.slice(0, 200) : [];

  return sanitizeValue({
    label: String(monthObj?.label || monthId || "").trim().slice(0, 40) || String(monthId || ""),
    incomes: incomes.map((item) => ({
      id: String(item?.id || ""),
      name: String(item?.name || "").slice(0, 120),
      budgeted: toFiniteNumber(item?.budgeted, 0),
      remaining: toFiniteNumber(item?.remaining, 0),
      ...(item?.target ? { target: String(item.target) } : {}),
      keywords: Array.isArray(item?.keywords) ? item.keywords.map((k) => String(k)) : []
    })),
    provisions: provisions.map((item) => ({
      id: String(item?.id || ""),
      name: String(item?.name || "").slice(0, 120),
      budgeted: toFiniteNumber(item?.budgeted, 0),
      remaining: toFiniteNumber(item?.remaining, 0),
      keywords: Array.isArray(item?.keywords) ? item.keywords.map((k) => String(k)) : [],
      ...(item?.coveredByReserve !== undefined ? { coveredByReserve: Boolean(item.coveredByReserve) } : {}),
      ...(item?.reserveAccount ? { reserveAccount: String(item.reserveAccount) } : {}),
      ...(item?.autoCreatedForTx ? { autoCreatedForTx: String(item.autoCreatedForTx) } : {})
    })),
    updatedAt: serverTimestamp()
  });
}

export function serializeTransaction(tx, isNew = false) {
  const txType = ALLOWED_TX_TYPES.has(tx?.type) ? tx.type : "saida";
  const amount = Math.max(0.01, toFiniteNumber(tx?.amount, 0.01));
  const payload = {
    id: String(tx?.id || "").slice(0, 100),
    month: String(tx?.month || "2026-11").slice(0, 7),
    date: String(tx?.date || new Date().toLocaleDateString("pt-BR")).slice(0, 10),
    desc: (String(tx?.desc || "Lançamento").trim() || "Lançamento").slice(0, 200),
    amount,
    type: txType,
    accountKey: (String(tx?.accountKey || "mp_livre").trim() || "mp_livre").slice(0, 60),
    account: (String(tx?.account || "Conta").trim() || "Conta").slice(0, 120),
    category: (String(tx?.category || "Avulso").trim() || "Avulso").slice(0, 100),
    groupId: tx?.groupId ? String(tx.groupId).slice(0, 100) : null,
    targetId: tx?.targetId ? String(tx.targetId).slice(0, 100) : null,
    provisionDelta: toFiniteNumber(tx?.provisionDelta, 0),
    incomeDelta: toFiniteNumber(tx?.incomeDelta, 0),
    leandraDelta: toFiniteNumber(tx?.leandraDelta, 0),
    paidCardKey: tx?.paidCardKey ? String(tx.paidCardKey).slice(0, 60) : null,
    creditCardPayDelta: tx?.creditCardPayDelta !== undefined && tx?.creditCardPayDelta !== null
      ? toFiniteNumber(tx.creditCardPayDelta, 0)
      : 0,
    isInvoicePayment: Boolean(tx?.isInvoicePayment || txType === "pagamento_fatura"),
    updatedAt: serverTimestamp()
  };

  if (isNew) {
    payload.createdAt = serverTimestamp();
  } else if (tx?.createdAt) {
    payload.createdAt = tx.createdAt;
  }

  return sanitizeValue(payload);
}

/**
 * Inicializa o Firebase App e o Firestore com cache persistente offline (IndexedDB).
 */
export async function initFirebase(config) {
  if (firestoreDb && firebaseApp) {
    try {
      await terminate(firestoreDb);
    } catch (_) {}
    firestoreDb = null;
  }
  if (getApps().length > 0) {
    for (const existing of getApps()) {
      try {
        await deleteApp(existing);
      } catch (_) {}
    }
  }

  firebaseApp = initializeApp(config);

  try {
    firestoreDb = initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
      })
    });
  } catch (errMulti) {
    try {
      firestoreDb = initializeFirestore(firebaseApp, {
        localCache: persistentLocalCache({
          tabManager: persistentSingleTabManager({})
        })
      });
    } catch (errSingle) {
      firestoreDb = getFirestore(firebaseApp);
    }
  }

  return { app: firebaseApp, db: firestoreDb };
}

export function getDbInstance() {
  return firestoreDb;
}

/**
 * Registra listeners em tempo real para contas, meses, lançamentos e metadados do workspace.
 */
export function subscribeWorkspace(workspaceId, callbacks = {}) {
  if (!firestoreDb) {
    throw new Error("Firestore não inicializado.");
  }

  const stateMeta = {
    accounts: { loaded: false, fromCache: true, hasPendingWrites: false },
    months: { loaded: false, fromCache: true, hasPendingWrites: false },
    transactions: { loaded: false, fromCache: true, hasPendingWrites: false },
    meta: { loaded: false, fromCache: true, hasPendingWrites: false }
  };

  let lastSyncedAt = null;
  let lastError = null;

  const emitStatus = () => {
    const entries = Object.values(stateMeta);
    const allLoaded = entries.every((s) => s.loaded);
    const anyFromCache = entries.some((s) => s.fromCache);
    const hasPendingWrites = entries.some((s) => s.hasPendingWrites);
    const browserOnline = typeof navigator !== "undefined" ? navigator.onLine : true;

    if (allLoaded && !anyFromCache && !hasPendingWrites && browserOnline) {
      lastSyncedAt = new Date();
      lastError = null;
    }

    if (typeof callbacks.onStatus === "function") {
      callbacks.onStatus({
        connected: browserOnline && !lastError && (!anyFromCache || !allLoaded),
        browserOnline,
        fromCache: anyFromCache,
        hasPendingWrites,
        allLoaded,
        lastSyncedAt,
        error: lastError
      });
    }
  };

  const handleError = (scope, err) => {
    lastError = err;
    console.error(`[Spark Firebase] Erro em ${scope}:`, err);
    emitStatus();
    if (typeof callbacks.onError === "function") {
      callbacks.onError(err, scope);
    }
  };

  const accountsCol = collection(firestoreDb, "workspaces", workspaceId, "accounts");
  const monthsCol = collection(firestoreDb, "workspaces", workspaceId, "months");
  const txCol = collection(firestoreDb, "workspaces", workspaceId, "transactions");
  const metaDocRef = doc(firestoreDb, "workspaces", workspaceId, "meta", "config");

  const unsubAccounts = onSnapshot(
    accountsCol,
    { includeMetadataChanges: true },
    (snapshot) => {
      const accountsMap = {};
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        accountsMap[docSnap.id] = {
          name: data.name,
          balance: toFiniteNumber(data.balance, 0),
          type: data.type || "free",
          ...(data.closingDay !== undefined ? { closingDay: data.closingDay } : {}),
          ...(data.dueDay !== undefined ? { dueDay: data.dueDay } : {}),
          ...(data.limit !== undefined ? { limit: data.limit } : {})
        };
      });
      stateMeta.accounts = {
        loaded: true,
        fromCache: snapshot.metadata.fromCache,
        hasPendingWrites: snapshot.metadata.hasPendingWrites
      };
      if (typeof callbacks.onAccounts === "function") {
        callbacks.onAccounts(accountsMap, snapshot.metadata);
      }
      emitStatus();
    },
    (err) => handleError("accounts", err)
  );

  const unsubMonths = onSnapshot(
    monthsCol,
    { includeMetadataChanges: true },
    (snapshot) => {
      const monthsMap = {};
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        monthsMap[docSnap.id] = {
          label: data.label || docSnap.id,
          incomes: Array.isArray(data.incomes) ? data.incomes : [],
          provisions: Array.isArray(data.provisions) ? data.provisions : []
        };
      });
      stateMeta.months = {
        loaded: true,
        fromCache: snapshot.metadata.fromCache,
        hasPendingWrites: snapshot.metadata.hasPendingWrites
      };
      if (typeof callbacks.onMonths === "function") {
        callbacks.onMonths(monthsMap, snapshot.metadata);
      }
      emitStatus();
    },
    (err) => handleError("months", err)
  );

  const unsubTransactions = onSnapshot(
    txCol,
    { includeMetadataChanges: true },
    (snapshot) => {
      const txList = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        txList.push({
          ...data,
          id: data.id || docSnap.id,
          amount: toFiniteNumber(data.amount, 0)
        });
      });
      stateMeta.transactions = {
        loaded: true,
        fromCache: snapshot.metadata.fromCache,
        hasPendingWrites: snapshot.metadata.hasPendingWrites
      };
      if (typeof callbacks.onTransactions === "function") {
        callbacks.onTransactions(txList, snapshot.metadata);
      }
      emitStatus();
    },
    (err) => handleError("transactions", err)
  );

  const unsubMeta = onSnapshot(
    metaDocRef,
    { includeMetadataChanges: true },
    (docSnap) => {
      stateMeta.meta = {
        loaded: true,
        fromCache: docSnap.metadata.fromCache,
        hasPendingWrites: docSnap.metadata.hasPendingWrites
      };
      if (typeof callbacks.onMeta === "function") {
        callbacks.onMeta(docSnap.exists() ? docSnap.data() : null, docSnap.metadata);
      }
      emitStatus();
    },
    (err) => handleError("meta", err)
  );

  const onOnline = () => emitStatus();
  const onOffline = () => emitStatus();
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
  }

  return () => {
    unsubAccounts();
    unsubMonths();
    unsubTransactions();
    unsubMeta();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    }
  };
}

/**
 * Executa uma lista de operações no Firestore em lotes atômicos (<= 400 ops por batch).
 */
async function executeBatchedOperations(ops) {
  if (!firestoreDb) throw new Error("Firestore não inicializado.");
  if (!ops.length) return { ok: true, opCount: 0 };

  for (let i = 0; i < ops.length; i += MAX_BATCH_OPS) {
    const chunk = ops.slice(i, i + MAX_BATCH_OPS);
    const batch = writeBatch(firestoreDb);
    for (const op of chunk) {
      if (op.kind === "set") {
        batch.set(op.ref, op.data, op.options || undefined);
      } else if (op.kind === "delete") {
        batch.delete(op.ref);
      }
    }
    await batch.commit();
  }

  return { ok: true, opCount: ops.length };
}

/**
 * Persiste alterações incrementais de forma atômica via writeBatch.
 */
export async function commitChanges(workspaceId, changes = {}) {
  if (!firestoreDb) throw new Error("Firestore não inicializado.");
  const ops = [];

  if (changes.accountsUpsert) {
    for (const [accKey, accObj] of Object.entries(changes.accountsUpsert)) {
      if (!accKey || !accObj) continue;
      ops.push({
        kind: "set",
        ref: doc(firestoreDb, "workspaces", workspaceId, "accounts", accKey),
        data: serializeAccount(accObj)
      });
    }
  }

  if (Array.isArray(changes.accountsDelete)) {
    for (const accKey of changes.accountsDelete) {
      if (!accKey) continue;
      ops.push({
        kind: "delete",
        ref: doc(firestoreDb, "workspaces", workspaceId, "accounts", accKey)
      });
    }
  }

  if (changes.monthsUpsert) {
    for (const [monthId, monthObj] of Object.entries(changes.monthsUpsert)) {
      if (!monthId || !monthObj) continue;
      ops.push({
        kind: "set",
        ref: doc(firestoreDb, "workspaces", workspaceId, "months", monthId),
        data: serializeMonth(monthObj, monthId)
      });
    }
  }

  if (Array.isArray(changes.transactionsUpsert)) {
    for (const tx of changes.transactionsUpsert) {
      if (!tx || !tx.id) continue;
      ops.push({
        kind: "set",
        ref: doc(firestoreDb, "workspaces", workspaceId, "transactions", String(tx.id)),
        data: serializeTransaction(tx, Boolean(tx._isNew))
      });
    }
  }

  if (Array.isArray(changes.transactionsDelete)) {
    for (const txId of changes.transactionsDelete) {
      if (!txId) continue;
      ops.push({
        kind: "delete",
        ref: doc(firestoreDb, "workspaces", workspaceId, "transactions", String(txId))
      });
    }
  }

  if (changes.markSeeded) {
    ops.push({
      kind: "set",
      ref: doc(firestoreDb, "workspaces", workspaceId, "meta", "config"),
      data: {
        schemaVersion: 1,
        seeded: true,
        updatedAt: serverTimestamp()
      },
      options: { merge: true }
    });
  }

  return executeBatchedOperations(ops);
}

/**
 * Importa um estado completo (INITIAL_STATE, cache antigo do localStorage ou backup JSON)
 * para o Firestore, opcionalmente substituindo documentos obsoletos.
 */
export async function importStateToWorkspace(workspaceId, stateData, { replaceExisting = false } = {}) {
  if (!firestoreDb) throw new Error("Firestore não inicializado.");
  if (!stateData || typeof stateData !== "object" || !stateData.accounts || !stateData.months) {
    throw new Error("Estrutura de dados inválida para importação.");
  }

  const ops = [];
  const nextAccountKeys = new Set(Object.keys(stateData.accounts || {}));
  const nextMonthKeys = new Set(Object.keys(stateData.months || {}));
  const txs = Array.isArray(stateData.transactions) ? stateData.transactions : [];
  const nextTxIds = new Set(txs.map((t) => String(t.id)));

  if (replaceExisting) {
    const [existingAccs, existingMonths, existingTxs] = await Promise.all([
      getDocs(collection(firestoreDb, "workspaces", workspaceId, "accounts")),
      getDocs(collection(firestoreDb, "workspaces", workspaceId, "months")),
      getDocs(collection(firestoreDb, "workspaces", workspaceId, "transactions"))
    ]);

    existingAccs.forEach((d) => {
      if (!nextAccountKeys.has(d.id)) ops.push({ kind: "delete", ref: d.ref });
    });
    existingMonths.forEach((d) => {
      if (!nextMonthKeys.has(d.id)) ops.push({ kind: "delete", ref: d.ref });
    });
    existingTxs.forEach((d) => {
      if (!nextTxIds.has(d.id)) ops.push({ kind: "delete", ref: d.ref });
    });
  }

  for (const [accKey, accObj] of Object.entries(stateData.accounts || {})) {
    ops.push({
      kind: "set",
      ref: doc(firestoreDb, "workspaces", workspaceId, "accounts", accKey),
      data: serializeAccount(accObj)
    });
  }

  for (const [monthId, monthObj] of Object.entries(stateData.months || {})) {
    ops.push({
      kind: "set",
      ref: doc(firestoreDb, "workspaces", workspaceId, "months", monthId),
      data: serializeMonth(monthObj, monthId)
    });
  }

  for (const tx of txs) {
    if (!tx || !tx.id) continue;
    ops.push({
      kind: "set",
      ref: doc(firestoreDb, "workspaces", workspaceId, "transactions", String(tx.id)),
      data: serializeTransaction(tx, true)
    });
  }

  ops.push({
    kind: "set",
    ref: doc(firestoreDb, "workspaces", workspaceId, "meta", "config"),
    data: {
      schemaVersion: 1,
      seeded: true,
      initializedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    },
    options: { merge: true }
  });

  return executeBatchedOperations(ops);
}

/**
 * Inicializa o banco remoto com INITIAL_STATE apenas se o servidor confirmar
 * que este workspace ainda está vazio (nunca sobrescreve dados existentes nem roda offline).
 */
export async function seedWorkspaceIfEmpty(workspaceId, initialState) {
  if (!firestoreDb) throw new Error("Firestore não inicializado.");

  const metaRef = doc(firestoreDb, "workspaces", workspaceId, "meta", "config");
  const accCol = collection(firestoreDb, "workspaces", workspaceId, "accounts");

  const [metaSnap, accSnap] = await Promise.all([
    getDocFromServer(metaRef),
    getDocsFromServer(accCol)
  ]);

  if (metaSnap.exists() && metaSnap.data()?.seeded) {
    return { seededNow: false, reason: "already_seeded" };
  }
  if (!accSnap.empty) {
    await commitChanges(workspaceId, { markSeeded: true });
    return { seededNow: false, reason: "existing_accounts" };
  }

  await importStateToWorkspace(workspaceId, initialState, { replaceExisting: false });
  return { seededNow: true, reason: "empty_workspace" };
}

/**
 * Aguarda o servidor confirmar todas as gravações locais pendentes na fila offline.
 */
export async function confirmServerSync() {
  if (!firestoreDb) throw new Error("Firestore não inicializado.");
  await waitForPendingWrites(firestoreDb);
  return true;
}
