# Spark Finanças

Controle financeiro pessoal inteligente (PWA) com lançamentos por voz, cartões de crédito com virada automática de fatura, provisões mensais, indicadores e persistência em tempo real no **Firebase Cloud Firestore**.

## Arquitetura de Dados (Firebase Cloud Firestore)

Em vez de sobrescrever uma planilha inteira em bloco único, cada entidade fica em sua própria coleção sob `workspaces/{workspaceId}`:

- `workspaces/{workspaceId}/meta/config` — metadados de inicialização e versão do schema
- `workspaces/{workspaceId}/accounts/{accountId}` — contas livres, reservas, benefícios (VR/Flash) e cartões de crédito
- `workspaces/{workspaceId}/months/{YYYY-MM}` — previsões de entradas e provisões de saídas do mês
- `workspaces/{workspaceId}/transactions/{txId}` — cada lançamento em um documento próprio

Benefícios:
- **Offline nativo (IndexedDB):** lançamentos feitos sem internet ficam na fila real do Firestore e sobem automaticamente quando a conexão retorna.
- **Tempo real (`onSnapshot`):** atualizações no celular aparecem instantaneamente no computador, sem sobrescrever dados novos com cache antigo.
- **Gravações atômicas (`writeBatch`):** criar, editar, excluir, parcelar ou pagar fatura atualiza transação + saldo da conta + provisão em uma única transação atômica.

## Estrutura do Projeto

- `index.html` — interface e lógica principal (ES Module sem bundler)
- `js/firebase-config.js` — configuração do projeto Firebase e seleção de workspace
- `js/firebase-db.js` — inicialização do Firestore com cache persistente, listeners `onSnapshot` e `writeBatch`
- `firestore.rules` — regras de segurança do Cloud Firestore
- `firestore.indexes.json` e `firebase.json` — configuração de deploy do Firebase
- `sw.js` e `manifest.json` — suporte a PWA instalável e cache offline seguro

## Como Conectar a um Novo Projeto Firebase

### Opção 1: Pelo Console do Firebase (mais rápido, sem CLI)
1. Acesse [console.firebase.google.com](https://console.firebase.google.com/) e clique em **Adicionar projeto**.
2. No menu lateral, vá em **Criação > Firestore Database > Criar banco de dados** (escolha a região mais próxima, ex: `southamerica-east1`).
3. Na aba **Regras** do Firestore, cole o conteúdo do arquivo [`firestore.rules`](./firestore.rules) e clique em **Publicar**.
4. Na página inicial do projeto (**Visão geral do projeto**), clique no ícone **Web (`</>`)** para registrar o app e copie o objeto `firebaseConfig`.
5. Preencha `FIREBASE_CONFIG` em [`js/firebase-config.js`](./js/firebase-config.js) (recomendado para GitHub Pages) **ou** abra o app, clique em **Firebase & Backup** na barra lateral e cole o `firebaseConfig` diretamente na interface.

### Opção 2: Via Firebase CLI (requer Node.js >= 20)
```bash
npx -y firebase-tools@latest login
npx -y firebase-tools@latest projects:create spark-financas-seu-id --display-name "Spark Finanças"
npx -y firebase-tools@latest use spark-financas-seu-id
npx -y firebase-tools@latest apps:create web spark-financas-web
npx -y firebase-tools@latest deploy --only firestore:rules,hosting
```

## Migração de Dados Antigos e Backup
- Se você usava a versão anterior ligada ao Google Sheets e ainda tem dados salvos no navegador (`spark_github_cache_v1`), abra **Firebase & Backup** no app e clique em **Migrar Dados Antigos do Navegador para o Firebase**.
- Você também pode exportar e importar snapshots completos em `.json` a qualquer momento pelo mesmo modal.
