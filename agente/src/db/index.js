import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'lc-sdr.db');
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function runSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Migrações leves pra bancos existentes (idempotentes)
  // SQLite: ALTER TABLE ADD COLUMN só falha se a coluna já existir → catch e seguir.
  const safeAddColumn = (table, column, type) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      console.log(`[migrate] +coluna ${table}.${column}`);
    } catch (err) {
      // duplicate column name — esperado se já rodou. Não logar.
      if (!/duplicate column/i.test(err.message)) {
        console.warn(`[migrate] erro adicionando ${table}.${column}:`, err.message);
      }
    }
  };

  safeAddColumn('contacts', 'campaign_source', 'TEXT');
  safeAddColumn('contacts', 'campaign_tags', 'TEXT');

  // Tracking de versão/modelo/provider em mensagens outbound da IA.
  // Permite cruzar feedback humano com a versão exata do prompt + modelo
  // que gerou aquela resposta. Sem isso, todo feedback do mutirão fica
  // desconectado da versão que produziu.
  safeAddColumn('messages', 'cached_tokens', 'INTEGER DEFAULT 0');
  safeAddColumn('messages', 'provider', 'TEXT');         // 'openai' | 'anthropic'
  safeAddColumn('messages', 'model_used', 'TEXT');       // 'gpt-4.1-mini' | 'claude-sonnet-4-6'
  safeAddColumn('messages', 'prompt_version', 'TEXT');   // SHA1[:10] do TINA_SYSTEM_PROMPT

  // Etiqueta de temperatura atual do lead no GHL (quente/morno/frio).
  // Guardada localmente pra só chamar a API do GHL quando a faixa MUDA.
  safeAddColumn('contacts', 'ghl_temp_tag', 'TEXT');

  // Continuidade via coluna "IA Tina" (o time arrasta o card pra Tina assumir):
  //  - ia_tina_self_moved_at: marca quando a PRÓPRIA Tina moveu a opp pra IA Tina
  //    (anti-loop: o handler do webhook de stage IGNORA o eco da própria
  //    movimentação dentro de um TTL).
  //  - ia_tina_continuation_at: quando a Tina já mandou a mensagem de retomada
  //    (cooldown anti-spam / idempotência contra retries e re-arrasto do card).
  safeAddColumn('contacts', 'ia_tina_self_moved_at', 'DATETIME');
  safeAddColumn('contacts', 'ia_tina_self_moved_opp', 'TEXT');   // opp id da própria movimentação (anti-loop por id, não só por tempo)
  safeAddColumn('contacts', 'ia_tina_continuation_at', 'DATETIME');
  // serviço identificado pela Tina — usado pra rotear a agenda (leitura crítica e
  // curso só vão pra Gabriel/Bruna, nunca pros closers; regra LC 25/09)
  safeAddColumn('contacts', 'service_recommended', 'TEXT');
}

// Garante schema na primeira importação
runSchema();
