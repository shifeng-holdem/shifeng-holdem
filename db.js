// 数据存储：有 DATABASE_URL 时用 Postgres，否则退回本地 JSON 文件（仅供本地开发/测试）
// 这里存的全部是游戏筹码，不是真钱。
import fs from "node:fs";
import path from "node:path";

const rowToUser = (r) => r && ({
  id: Number(r.id), username: r.username, passHash: r.pass_hash, balance: Number(r.balance), isAdmin: !!r.is_admin,
  isHouse: !!r.is_house, banned: !!r.banned, lastClaim: r.last_claim || null,
  createdAt: r.created_at ? new Date(r.created_at).getTime() : null, lastLogin: r.last_login ? new Date(r.last_login).getTime() : null,
});

class PgStore {
  constructor(url, schema) { this.url = url; this.schema = schema; this.kind = "postgres"; }
  async init() {
    const { default: pg } = await import("pg");
    const local = /localhost|127\.0\.0\.1/.test(this.url) || process.env.PGSSL === "disable";
    const base = { connectionString: this.url, ssl: local ? false : { rejectUnauthorized: false } };
    if (this.schema) { // 测试用：每次启动一个独立 schema
      const c = new pg.Client(base); await c.connect(); await c.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`); await c.end();
      base.options = `-c search_path=${this.schema}`;
    }
    this.pool = new pg.Pool({ ...base, max: 5 });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
        balance BIGINT NOT NULL DEFAULT 0, is_admin BOOLEAN NOT NULL DEFAULT FALSE, is_house BOOLEAN NOT NULL DEFAULT FALSE,
        banned BOOLEAN NOT NULL DEFAULT FALSE, last_claim TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_login TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS ledger (
        id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL, delta BIGINT NOT NULL, balance_after BIGINT NOT NULL,
        reason TEXT NOT NULL, actor TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id DESC);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS slot_spins (
        id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL, game TEXT NOT NULL, bet BIGINT NOT NULL, win BIGINT NOT NULL,
        free_spins INTEGER NOT NULL DEFAULT 0, balance_after BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS slot_spins_user ON slot_spins(user_id, id DESC);
    `);
  }
  q(sql, args) { return this.pool.query(sql, args); }
  async createUser(username, passHash, balance, { isAdmin = false, isHouse = false } = {}) {
    try {
      const r = await this.q(`INSERT INTO users (username, username_lower, pass_hash, balance, is_admin, is_house) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [username, username.toLowerCase(), passHash, balance, isAdmin, isHouse]);
      const u = rowToUser(r.rows[0]);
      if (balance) await this.q(`INSERT INTO ledger (user_id, delta, balance_after, reason, actor) VALUES ($1,$2,$2,$3,'system')`, [u.id, balance, "注册赠送"]);
      return u;
    } catch (e) { if (e.code === "23505") throw new Error("EXISTS"); throw e; }
  }
  async getUserByName(name) { return rowToUser((await this.q(`SELECT * FROM users WHERE username_lower=$1`, [String(name).toLowerCase()])).rows[0]); }
  async getUser(id) { return rowToUser((await this.q(`SELECT * FROM users WHERE id=$1`, [id])).rows[0]); }
  async updateUser(id, f) {
    const map = { passHash: "pass_hash", isAdmin: "is_admin", banned: "banned", lastLogin: "last_login" };
    const keys = Object.keys(f).filter((k) => map[k]); if (!keys.length) return;
    const vals = keys.map((k) => (k === "lastLogin" ? new Date(f[k]) : f[k]));
    await this.q(`UPDATE users SET ${keys.map((k, i) => `${map[k]}=$${i + 2}`).join(",")} WHERE id=$1`, [id, ...vals]);
  }
  async adjust(id, delta, reason, actor = "system", allowNegative = false) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(`UPDATE users SET balance = balance + $2 WHERE id=$1 ${allowNegative ? "" : "AND balance + $2 >= 0"} RETURNING balance`, [id, delta]);
      if (!r.rows.length) { await c.query("ROLLBACK"); throw new Error("INSUFFICIENT"); }
      const bal = Number(r.rows[0].balance);
      await c.query(`INSERT INTO ledger (user_id, delta, balance_after, reason, actor) VALUES ($1,$2,$3,$4,$5)`, [id, delta, bal, reason, actor]);
      await c.query("COMMIT");
      return bal;
    } catch (e) { if (e.message !== "INSUFFICIENT") await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }
  async claimDaily(id, day, amount) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(`UPDATE users SET balance = balance + $3, last_claim=$2 WHERE id=$1 AND (last_claim IS NULL OR last_claim <> $2) RETURNING balance`, [id, day, amount]);
      if (!r.rows.length) { await c.query("ROLLBACK"); return null; }
      const bal = Number(r.rows[0].balance);
      await c.query(`INSERT INTO ledger (user_id, delta, balance_after, reason, actor) VALUES ($1,$2,$3,'每日免费领取','system')`, [id, amount, bal]);
      await c.query("COMMIT");
      return bal;
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }
  async searchUsers(q = "", limit = 50) {
    const r = await this.q(`SELECT * FROM users WHERE NOT is_house AND username_lower LIKE $1 ORDER BY id DESC LIMIT $2`, ["%" + String(q).toLowerCase().replace(/[%_]/g, "") + "%", limit]);
    return r.rows.map(rowToUser);
  }
  async countUsers() { return Number((await this.q(`SELECT count(*) AS n FROM users WHERE NOT is_house`)).rows[0].n); }
  async ledger(userId, limit = 50) {
    const r = await this.q(`SELECT * FROM ledger WHERE user_id=$1 ORDER BY id DESC LIMIT $2`, [userId, limit]);
    return r.rows.map((x) => ({ delta: Number(x.delta), balanceAfter: Number(x.balance_after), reason: x.reason, actor: x.actor, at: new Date(x.created_at).getTime() }));
  }
  async createSession(token, userId, expiresAt) { await this.q(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`, [token, userId, new Date(expiresAt)]); }
  async getSession(token) {
    const r = await this.q(`SELECT * FROM sessions WHERE token=$1 AND expires_at > now()`, [token]);
    return r.rows[0] ? { token, userId: Number(r.rows[0].user_id) } : null;
  }
  async deleteSession(token) { await this.q(`DELETE FROM sessions WHERE token=$1`, [token]); }
  async deleteUserSessions(userId) { await this.q(`DELETE FROM sessions WHERE user_id=$1`, [userId]); }
  async getSettings() { const r = await this.q(`SELECT * FROM settings`); return Object.fromEntries(r.rows.map((x) => [x.key, JSON.parse(x.value)])); }
  async setSetting(k, v) { await this.q(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [k, JSON.stringify(v)]); }
  // 转轴游戏一次下注：扣下注、加奖金、记账、记录、庄家对冲，全部在一个事务里；余额不够就整笔作废
  async slotSpin(userId, houseId, game, bet, win, freeSpins, label) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(`UPDATE users SET balance = balance - $2 + $3 WHERE id=$1 AND balance >= $2 AND NOT banned RETURNING balance`, [userId, bet, win]);
      if (!r.rows.length) { await c.query("ROLLBACK"); throw new Error("INSUFFICIENT"); }
      const bal = Number(r.rows[0].balance);
      await c.query(`INSERT INTO ledger (user_id, delta, balance_after, reason, actor) VALUES ($1,$2,$3,$4,'system')`, [userId, win - bet, bal, label]);
      const hr = await c.query(`UPDATE users SET balance = balance + $2 WHERE id=$1 RETURNING balance`, [houseId, bet - win]);
      if (bet !== win) await c.query(`INSERT INTO ledger (user_id, delta, balance_after, reason, actor) VALUES ($1,$2,$3,$4,'system')`, [houseId, bet - win, Number(hr.rows[0].balance), label]);
      const ins = await c.query(`INSERT INTO slot_spins (user_id, game, bet, win, free_spins, balance_after) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`, [userId, game, bet, win, freeSpins, bal]);
      await c.query("COMMIT");
      return { balance: bal, id: Number(ins.rows[0].id), at: new Date(ins.rows[0].created_at).getTime() };
    } catch (e) { if (e.message !== "INSUFFICIENT") await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }
  async slotHistory(userId, game, limit = 20) {
    const r = await this.q(`SELECT s.*, u.username FROM slot_spins s JOIN users u ON u.id=s.user_id WHERE ($1::int IS NULL OR s.user_id=$1) AND s.game=$2 ORDER BY s.id DESC LIMIT $3`, [userId, game, limit]);
    return r.rows.map((x) => ({ id: Number(x.id), userId: Number(x.user_id), username: x.username, bet: Number(x.bet), win: Number(x.win), freeSpins: x.free_spins, balanceAfter: Number(x.balance_after), at: new Date(x.created_at).getTime() }));
  }
  async slotTotals(game, userId = null) {
    const r = await this.q(`SELECT count(*) AS spins, COALESCE(sum(bet),0) AS bets, COALESCE(sum(win),0) AS wins, count(DISTINCT user_id) AS players, COALESCE(sum(CASE WHEN free_spins>0 THEN 1 ELSE 0 END),0) AS features, COALESCE(max(win),0) AS best FROM slot_spins WHERE game=$1 AND ($2::int IS NULL OR user_id=$2)`, [game, userId]);
    const x = r.rows[0]; return { spins: Number(x.spins), bets: Number(x.bets), wins: Number(x.wins), players: Number(x.players), features: Number(x.features), best: Number(x.best) };
  }
  async slotTopPlayers(game, limit = 10) {
    const r = await this.q(`SELECT s.user_id, u.username, count(*) AS spins, sum(s.bet) AS bets, sum(s.win) AS wins FROM slot_spins s JOIN users u ON u.id=s.user_id WHERE s.game=$1 GROUP BY s.user_id, u.username ORDER BY sum(s.bet) DESC LIMIT $2`, [game, limit]);
    return r.rows.map((x) => ({ userId: Number(x.user_id), username: x.username, spins: Number(x.spins), bets: Number(x.bets), wins: Number(x.wins) }));
  }
  async close() { await this.pool.end(); }
}

class JsonStore {
  constructor(file) { this.file = file; this.kind = file ? "json" : "memory"; }
  async init() {
    this.d = { seq: 0, users: [], ledger: [], sessions: {}, settings: {} };
    if (this.file && fs.existsSync(this.file)) this.d = JSON.parse(fs.readFileSync(this.file, "utf8"));
    this.lock = Promise.resolve();
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(this.d)); fs.renameSync(tmp, this.file);
  }
  u(id) { return this.d.users.find((x) => x.id === id); }
  pub(r) { return r && { ...r }; }
  log(id, delta, bal, reason, actor) {
    this.d.ledger.push({ userId: id, delta, balanceAfter: bal, reason, actor, at: Date.now() });
    if (this.d.ledger.length > 50000) this.d.ledger.splice(0, this.d.ledger.length - 50000);
  }
  async createUser(username, passHash, balance, { isAdmin = false, isHouse = false } = {}) {
    if (this.d.users.some((x) => x.username.toLowerCase() === username.toLowerCase())) throw new Error("EXISTS");
    const r = { id: ++this.d.seq, username, passHash, balance, isAdmin, isHouse, banned: false, lastClaim: null, createdAt: Date.now(), lastLogin: null };
    this.d.users.push(r); if (balance) this.log(r.id, balance, balance, "注册赠送", "system"); this.save(); return this.pub(r);
  }
  async getUserByName(name) { return this.pub(this.d.users.find((x) => x.username.toLowerCase() === String(name).toLowerCase())); }
  async getUser(id) { return this.pub(this.u(Number(id))); }
  async updateUser(id, f) { const r = this.u(id); if (!r) return; for (const k of ["passHash", "isAdmin", "banned", "lastLogin"]) if (k in f) r[k] = f[k]; this.save(); }
  async adjust(id, delta, reason, actor = "system", allowNegative = false) {
    const r = this.u(id); if (!r) throw new Error("NOUSER");
    if (!allowNegative && r.balance + delta < 0) throw new Error("INSUFFICIENT");
    r.balance += delta; this.log(id, delta, r.balance, reason, actor); this.save(); return r.balance;
  }
  async claimDaily(id, day, amount) {
    const r = this.u(id); if (!r || r.lastClaim === day) return null;
    r.lastClaim = day; r.balance += amount; this.log(id, amount, r.balance, "每日免费领取", "system"); this.save(); return r.balance;
  }
  async searchUsers(q = "", limit = 50) { q = String(q).toLowerCase(); return this.d.users.filter((x) => !x.isHouse && x.username.toLowerCase().includes(q)).sort((a, b) => b.id - a.id).slice(0, limit).map((x) => this.pub(x)); }
  async countUsers() { return this.d.users.filter((x) => !x.isHouse).length; }
  async ledger(userId, limit = 50) { return this.d.ledger.filter((x) => x.userId === userId).slice(-limit).reverse().map(({ userId: _u, ...x }) => x); }
  async createSession(token, userId, expiresAt) { this.d.sessions[token] = { userId, expiresAt }; this.save(); }
  async getSession(token) { const s = this.d.sessions[token]; return s && s.expiresAt > Date.now() ? { token, userId: s.userId } : null; }
  async deleteSession(token) { delete this.d.sessions[token]; this.save(); }
  async deleteUserSessions(userId) { for (const [t, s] of Object.entries(this.d.sessions)) if (s.userId === userId) delete this.d.sessions[t]; this.save(); }
  async getSettings() { return { ...this.d.settings }; }
  async setSetting(k, v) { this.d.settings[k] = v; this.save(); }
  async slotSpin(userId, houseId, game, bet, win, freeSpins, label) {
    const r = this.u(userId); if (!r) throw new Error("NOUSER");
    if (r.banned || r.balance < bet) throw new Error("INSUFFICIENT");
    r.balance += win - bet; this.log(userId, win - bet, r.balance, label, "system");
    const h = this.u(houseId); if (h) { h.balance += bet - win; if (bet !== win) this.log(houseId, bet - win, h.balance, label, "system"); }
    const d = this.d; d.slotSpins ||= []; d.slotSeq = (d.slotSeq || 0) + 1; d.slotTotals ||= {};
    const rec = { id: d.slotSeq, userId, game, bet, win, freeSpins, balanceAfter: r.balance, at: Date.now() };
    d.slotSpins.push(rec); if (d.slotSpins.length > 20000) d.slotSpins.splice(0, d.slotSpins.length - 20000);
    // 汇总单独累计，历史记录裁剪后总数仍然准确
    for (const key of [game, game + ":" + userId]) {
      const t = (d.slotTotals[key] ||= { spins: 0, bets: 0, wins: 0, features: 0, best: 0 });
      t.spins++; t.bets += bet; t.wins += win; if (freeSpins) t.features++; t.best = Math.max(t.best, win);
    }
    this.save(); return { balance: r.balance, id: rec.id, at: rec.at };
  }
  async slotHistory(userId, game, limit = 20) {
    return (this.d.slotSpins || []).filter((x) => x.game === game && (userId == null || x.userId === userId)).slice(-limit).reverse()
      .map((x) => ({ ...x, username: (this.u(x.userId) || {}).username }));
  }
  async slotTotals(game, userId = null) {
    const T = this.d.slotTotals || {}; const t = T[userId == null ? game : game + ":" + userId] || { spins: 0, bets: 0, wins: 0, features: 0, best: 0 };
    const players = userId == null ? Object.keys(T).filter((k) => k.startsWith(game + ":")).length : (t.spins ? 1 : 0);
    return { spins: t.spins, bets: t.bets, wins: t.wins, players, features: t.features, best: t.best };
  }
  async slotTopPlayers(game, limit = 10) {
    const T = this.d.slotTotals || {};
    return Object.entries(T).filter(([k]) => k.startsWith(game + ":")).map(([k, t]) => { const id = Number(k.split(":")[1]); return { userId: id, username: (this.u(id) || {}).username, spins: t.spins, bets: t.bets, wins: t.wins }; })
      .sort((a, b) => b.bets - a.bets).slice(0, limit);
  }
  async close() { this.save(); }
}

export async function openStore({ databaseUrl, dataFile, memory, schema } = {}) {
  let store;
  if (databaseUrl) store = new PgStore(databaseUrl, schema);
  else {
    if (!memory) console.warn(`⚠️  没有设置 DATABASE_URL，使用本地文件存储 ${dataFile}。Render 免费实例每次部署/重启都会清空这个文件，正式上线请配置 Postgres。`);
    store = new JsonStore(memory ? null : dataFile);
  }
  await store.init();
  return store;
}
