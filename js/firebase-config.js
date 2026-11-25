/**
 * Configuração do Firebase para o Spark Finanças.
 *
 * Você pode:
 * 1) Preencher o objeto FIREBASE_CONFIG abaixo diretamente no repositório (para GitHub Pages / Firebase Hosting), OU
 * 2) Colar o firebaseConfig dentro do próprio app pelo botão "Firebase & Backup" (salvo no navegador).
 */

export const DEFAULT_WORKSPACE_ID = "spark_04801a2893edcc83dc4b";

export const RUNTIME_CONFIG_STORAGE_KEY = "spark_firebase_runtime_config_v1";
export const WORKSPACE_STORAGE_KEY = "spark_firebase_workspace_id_v1";

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA2JBOQQNzztrXCsUizg5EScex3yj2z0YM",
  authDomain: "gestao-financeira-5ed99.firebaseapp.com",
  projectId: "gestao-financeira-5ed99",
  storageBucket: "gestao-financeira-5ed99.firebasestorage.app",
  messagingSenderId: "1078327156915",
  appId: "1:1078327156915:web:f6ce11db726c06251710c6",
  measurementId: "G-4HW1N0GHZ9"
};

/**
 * Valida se o ID do workspace segue o padrão permitido pelas Security Rules (6..64 chars).
 */
export function isValidWorkspaceId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{6,64}$/.test(id.trim());
}

/**
 * Verifica se o firebaseConfig possui as chaves mínimas reais (não vazias / não placeholders).
 */
export function isValidFirebaseConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return false;
  const required = ["apiKey", "projectId", "appId"];
  return required.every((key) => {
    const val = typeof cfg[key] === "string" ? cfg[key].trim() : "";
    if (!val) return false;
    if (/^(COLE_AQUI|YOUR_|REPLACE_|EXEMPLO)/i.test(val)) return false;
    return val.length >= 4;
  });
}

/**
 * Normaliza apenas os campos suportados pelo SDK Web do Firebase.
 */
export function normalizeFirebaseConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const clean = {
    apiKey: String(cfg.apiKey || "").trim(),
    authDomain: String(cfg.authDomain || "").trim(),
    projectId: String(cfg.projectId || "").trim(),
    storageBucket: String(cfg.storageBucket || "").trim(),
    messagingSenderId: String(cfg.messagingSenderId || "").trim(),
    appId: String(cfg.appId || "").trim()
  };
  if (cfg.measurementId) {
    clean.measurementId = String(cfg.measurementId).trim();
  }
  return clean;
}

/**
 * Interpreta texto colado do Console do Firebase (JSON puro ou trecho JS `const firebaseConfig = { ... };`).
 */
export function parseFirebaseConfigInput(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new Error("Cole o objeto firebaseConfig gerado no Console do Firebase.");
  }

  let text = rawText.trim();
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) {
    throw new Error("Formato inválido: não foi encontrado um objeto { ... }.");
  }

  text = text.slice(braceStart, braceEnd + 1);

  // Tenta JSON estrito primeiro
  try {
    const parsed = JSON.parse(text);
    const normalized = normalizeFirebaseConfig(parsed);
    if (!isValidFirebaseConfig(normalized)) {
      throw new Error("Faltam campos obrigatórios (apiKey, projectId, appId).");
    }
    return normalized;
  } catch (_) {
    // Continua para parser tolerante a sintaxe JS do Firebase Console (chaves sem aspas / aspas simples)
  }

  const jsonLike = text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => `"${inner.replace(/"/g, '\\"')}"`)
    .replace(/,\s*([}\]])/g, "$1");

  let parsedObj;
  try {
    parsedObj = JSON.parse(jsonLike);
  } catch (err) {
    throw new Error("Não foi possível ler o firebaseConfig. Verifique se copiou o bloco completo { ... }.");
  }

  const normalized = normalizeFirebaseConfig(parsedObj);
  if (!isValidFirebaseConfig(normalized)) {
    throw new Error("Faltam campos obrigatórios válidos (apiKey, projectId, appId).");
  }
  return normalized;
}

/**
 * Retorna a configuração ativa (prioridade: localStorage runtime > constante FIREBASE_CONFIG).
 */
export function getActiveFirebaseConfig() {
  try {
    const raw = localStorage.getItem(RUNTIME_CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = normalizeFirebaseConfig(JSON.parse(raw));
      if (isValidFirebaseConfig(parsed)) {
        return { config: parsed, source: "localStorage" };
      }
    }
  } catch (_) {}

  const staticCfg = normalizeFirebaseConfig(FIREBASE_CONFIG);
  if (isValidFirebaseConfig(staticCfg)) {
    return { config: staticCfg, source: "file" };
  }

  return { config: null, source: "none" };
}

/**
 * Salva configuração Firebase no navegador (para conectar sem precisar editar arquivos).
 */
export function saveRuntimeFirebaseConfig(cfg, workspaceId) {
  const normalized = normalizeFirebaseConfig(cfg);
  if (!isValidFirebaseConfig(normalized)) {
    throw new Error("Configuração Firebase inválida.");
  }
  localStorage.setItem(RUNTIME_CONFIG_STORAGE_KEY, JSON.stringify(normalized));

  if (workspaceId !== undefined && workspaceId !== null && String(workspaceId).trim() !== "") {
    saveWorkspaceId(workspaceId);
  }
  return normalized;
}

/**
 * Remove configuração Firebase salva no localStorage.
 */
export function clearRuntimeFirebaseConfig() {
  localStorage.removeItem(RUNTIME_CONFIG_STORAGE_KEY);
}

/**
 * Salva o ID do workspace ativo.
 */
export function saveWorkspaceId(workspaceId) {
  const clean = String(workspaceId || "").trim();
  if (!isValidWorkspaceId(clean)) {
    throw new Error("O ID do Workspace deve ter entre 6 e 64 caracteres (letras, números, _ ou -).");
  }
  localStorage.setItem(WORKSPACE_STORAGE_KEY, clean);
  return clean;
}

/**
 * Resolve o Workspace ID ativo: parâmetro ?ws= na URL > localStorage > DEFAULT_WORKSPACE_ID.
 */
export function getActiveWorkspaceId() {
  try {
    const params = new URLSearchParams(window.location.search);
    const wsFromUrl = params.get("ws");
    if (wsFromUrl && isValidWorkspaceId(wsFromUrl)) {
      const clean = wsFromUrl.trim();
      localStorage.setItem(WORKSPACE_STORAGE_KEY, clean);
      return clean;
    }
  } catch (_) {}

  try {
    const saved = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (saved && isValidWorkspaceId(saved)) {
      return saved.trim();
    }
  } catch (_) {}

  return DEFAULT_WORKSPACE_ID;
}
