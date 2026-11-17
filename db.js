// 数据存储：有 DATABASE_URL 时用 Postgres，否则退回本地 JSON 文件（仅供本地开发/测试）
// 这里存的全部是游戏筹码，不是真钱。
import fs from "node:fs";
import path from "node:path";

const rowToUser = (r) => r && ({
  id: Number(r.id), username: r.username, passHash: r.pass_hash, balance: Number(r.balance), isAdmin: !!r.is_admin,
  isHouse: !!r.is_house, banned: !!r.banned, lastClaim: r.last_claim || null,
  publicId: r.public_id == null ? null : Number(r.public_id), avatarVer: Number(r.avatar_ver || 0),
  handsPlayed: Number(r.hands_played || 0), handsWon: Number(r.hands_won || 0), pokerBest: Number(r.poker_best || 0),
  turnover: Number(r.turnover || 0), invitedBy: r.invited_by == null ? null : Number(r.invited_by), inviteStatus: r.invite_status || null,
  regIp: r.reg_ip || null, lastIp: r.last_ip || null, firstPlayed: !!r.first_played,
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
      ALTER TABLE users ADD COLUMN IF NOT EXISTS public_id INTEGER UNIQUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_ver INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS hands_played INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS hands_won INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS poker_best BIGINT NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS avatars (user_id INTEGER PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE SEQUENCE IF NOT EXISTS user_public_id_seq START 10001;
      ALTER TABLE slot_spins ADD COLUMN IF NOT EXISTS detail TEXT;
      CREATE INDEX IF NOT EXISTS slot_spins_game ON slot_spins(game, id DESC);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS turnover BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by INTEGER;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_status TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reg_ip TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS first_played BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE INDEX IF NOT EXISTS users_invited_by ON users(invited_by);
      CREATE TABLE IF NOT EXISTS game_rounds (
        id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL, game TEXT NOT NULL, stake BIGINT NOT NULL, state TEXT NOT NULL,
        ver INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX IF NOT EXISTS game_rounds_active ON game_rounds(user_id, game) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS reward_claims (
        id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, ref TEXT NOT NULL, amount BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (type, user_id, ref));
    `);
    await this.backfillPublicIds();
    await this.migrateCents();
  }
  // 金额改成整数“分”：老数据全部 ×100，只做一次（settings 里记标记，事务 + 咨询锁防止两个实例同时迁移）
  async migrateCents() {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(7401100)");
      const done = (await c.query(`SELECT 1 FROM settings WHERE key='amountsInCents'`)).rows.length;
      let migrated = false;
      if (!done) {
        await c.query(`UPDATE users SET balance = balance * 100, poker_best = poker_best * 100`);
        await c.query(`UPDATE ledger SET delta = delta * 100, balance_after = balance_after * 100`);
        await c.query(`UPDATE slot_spins SET bet = bet * 100, win = win * 100, balance_after = balance_after * 100`);
        await c.query(`INSERT INTO settings (key, value) VALUES ('amountsInCents', '1')`);
        migrated = true;
      }
      await c.query("COMMIT"); return migrated;
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }
  // 玩家 ID：从 10001 开始按注册顺序分配；老账号补发，已有的永远不变
  async backfillPublicIds() {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN"); await c.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
      const mx = Number((await c.query(`SELECT COALESCE(max(public_id), 10000) AS m FROM users`)).rows[0].m);
      const seq = (await c.query(`SELECT last_value, is_called FROM user_public_id_seq`)).rows[0];
      const cur = seq.is_called ? Number(seq.last_value) : Number(seq.last_value) - 1;
      if (cur < mx) await c.query(`SELECT setval('user_public_id_seq', $1, true)`, [mx]);
      const todo = (await c.query(`SELECT id FROM users WHERE public_id IS NULL AND NOT is_house ORDER BY id`)).rows;
      for (const r of todo) await c.query(`UPDATE users SET public_id = nextval('user_public_id_seq') WHERE id=$1`, [r.id]);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }
  q(sql, args) { return this.pool.query(sql, args); }
  async createUser(username, passHash, balance, { isAdmin = false, isHouse = false, invitedBy = null, inviteStatus = null, regIp = null } = {}) {
    try {
      const r = await this.q(`INSERT INTO users (username, username_lower, pass_hash, balance, is_admin, is_house, public_id, invited_by, invite_status, reg_ip, last_ip) VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6 THEN NULL ELSE nextval('user_public_id_seq') END, $7, $8, $9, $9) RETURNING *`,
        [username, username.toLowerCase(), passHash, balance, isAdmin, isHouse, invitedBy, inviteStatus, regIp]);
      const u = rowToUser(r.rows[0]);
      if (balance) await this.q(`INSERT INTO ledger (user_id, delta, balance_after, reason, actor) VALUES ($1,$2,$2,$3,'system')`, [u.id, balance, "注册赠送"]);
      return u;
    } catch (e) { if (e.code === "23505") throw new Error("EXISTS"); throw e; }
  }
  async getUserByName(name) { return rowToUser((await this.q(`SELECT * FROM users WHERE username_lower=$1`, [String(name).toLowerCase()])).rows[0]); }
  async getUser(id) { return rowToUser((await this.q(`SELECT * FROM users WHERE id=$1`, [id])).rows[0]); }
  async updateUser(id, f) {
    const map = { passHash: "pass_hash", isAdmin: "is_admin", banned: "banned", lastLogin: "last_login", lastIp: "last_ip" };
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
    const n = /^\d{5,9}$/.test(String(q).trim()) ? Number(String(q).trim()) : -1;
    const r = await this.q(`SELECT * FROM users WHERE NOT is_house AND (username_lower LIKE $1 OR public_id = $3) ORDER BY id DESC LIMIT $2`, ["%" + String(q).toLowerCase().replace(/[%_]/g, "") + "%", limit, n]);
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
  // opts.need：这一局要求的最低余额（例如牛牛最多输 5 倍）；opts.detail：给历史记录看的牌面摘要
  async slotSpin(userId, houseId, game, bet, win, freeSpins, label, opts = {}) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(`UPDATE users SET balance = balance - $2 + $3, turnover = turnover + $2 WHERE id=$1 AND balance >= $4 AND balance - $2 + $3 >= 0 AND NOT banned RETURNING balance`, [userId, bet, win, Math.max(bet, opts.need || 0)]);
      if (!r.rows.length) { await c.query("ROLLBACK"); throw new Error("INSUFFICIENT"); }
      const bal = Number(r.rows[0].balance);
      await c.query(`INSERT INTO ledger (user_id, delta, balance_after, reason, actor) VALUES ($1,$2,$3,$4,'system')`, [userId, win - bet, bal, label]);
      const hr = await c.query(`UPDATE users SET balance = balance + $2 WHERE id=$1 RETURNING balance`, [houseId, bet - win]);
      if (bet !== win) await c.query(`INSERT INTO ledger (user_id, delta, balance_after, reason, actor) VALUES ($1,$2,$3,$4,'system')`, [houseId, bet - win, Number(hr.rows[0].balance), label]);
      const ins = await c.query(`INSERT INTO slot_spins (user_id, game, bet, win, free_spins, balance_after, detail) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`, [userId, game, bet, win, freeSpins, bal, opts.detail ? JSON.stringify(opts.detail) : null]);
      await c.query("COMMIT");
      return { balance: bal, id: Number(ins.rows[0].id), at: new Date(ins.rows[0].created_at).getTime() };
    } catch (e) { if (e.message !== "INSUFFICIENT") await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }
  async slotHistory(userId, game, limit = 20) {
    const r = await this.q(`SELECT s.*, u.username FROM slot_spins s JOIN users u ON u.id=s.user_id WHERE ($1::int IS NULL OR s.user_id=$1) AND s.game=$2 ORDER BY s.id DESC LIMIT $3`, [userId, game, limit]);
    return r.rows.map((x) => ({ id: Number(x.id), userId: Number(x.user_id), username: x.username, bet: Number(x.bet), win: Number(x.win), freeSpins: x.free_spins, balanceAfter: Number(x.balance_after), detail: x.detail ? JSON.parse(x.detail) : null, at: new Date(x.created_at).getTime() }));
  }
  async slotTotals(game, userId = null) {
    const r = await this.q(`SELECT count(*) AS spins, COALESCE(sum(bet),0) AS bets, COALESCE(sum(win),0) AS wins, count(DISTINCT user_id) AS players, COALESCE(sum(CASE WHEN free_spins>0 THEN 1 ELSE 0 END),0) AS features, COALESCE(max(win),0) AS best FROM slot_spins WHERE game=$1 AND ($2::int IS NULL OR user_id=$2)`, [game, userId]);
    const x = r.rows[0]; return { spins: Number(x.spins), bets: Number(x.bets), wins: Number(x.wins), players: Number(x.players), features: Number(x.features), best: Number(x.best) };
  }
  async slotTopPlayers(game, limit = 10) {
    const r = await this.q(`SELECT s.user_id, u.username, count(*) AS spins, sum(s.bet) AS bets, sum(s.win) AS wins FROM slot_spins s JOIN users u ON u.id=s.user_id WHERE s.game=$1 GROUP BY s.user_id, u.username ORDER BY sum(s.bet) DESC LIMIT $2`, [game, limit]);
    return r.rows.map((x) => ({ userId: Number(x.user_id), username: x.username, spins: Number(x.spins), bets: Number(x.bets), wins: Number(x.wins) }));
  }
  async getUserByPublicId(pid) { return rowToUser((await this.q(`SELECT * FROM users WHERE public_id=$1`, [pid])).rows[0]); }
  async setAvatar(userId, mime, buf) {
    await this.q(`INSERT INTO avatars (user_id, mime, data) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now()`, [userId, mime, buf]);
    return Number((await this.q(`UPDATE users SET avatar_ver = abs(avatar_ver) + 1 WHERE id=$1 RETURNING avatar_ver`, [userId])).rows[0].avatar_ver);
  }
  async clearAvatar(userId) { await this.q(`DELETE FROM avatars WHERE user_id=$1`, [userId]); return Number((await this.q(`UPDATE users SET avatar_ver = -abs(avatar_ver) WHERE id=$1 RETURNING avatar_ver`, [userId])).rows[0].avatar_ver); }
  async getAvatar(userId) { const r = (await this.q(`SELECT mime, data FROM avatars WHERE user_id=$1`, [userId])).rows[0]; return r ? { mime: r.mime, data: r.data } : null; }
  async addPokerStats(userId, won, amount, turnover = 0) {
    await this.q(`UPDATE users SET hands_played = hands_played + 1, hands_won = hands_won + $2, poker_best = GREATEST(poker_best, $3), turnover = turnover + $4 WHERE id=$1`, [userId, won ? 1 : 0, amount, turnover]);
  }
  // ---- 多步骤牌局（21点 / 炸金花）：开局先押注，过程中可以加注，最后一次性结算 ----
  async tx(fn) {
    const c = await this.pool.connect();
    try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
    catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }
  async debitIn(c, userId, amount, label) {
    const r = await c.query(`UPDATE users SET balance = balance - $2 WHERE id=$1 AND balance >= $2 AND NOT banned RETURNING balance`, [userId, amount]);
    if (!r.rows.length) throw new Error("INSUFFICIENT");
    const bal = Number(r.rows[0].balance);
    await c.query(`INSERT INTO ledger (user_id, delta, balance_after, reason, actor) VALUES ($1,$2,$3,$4,'system')`, [userId, -amount, bal, label]);
    return bal;
  }
  async roundStart(userId, game, stake, state, label) {
    return this.tx(async (c) => {
      const balance = await this.debitIn(c, userId, stake, label);
      let r; try { r = await c.query(`INSERT INTO game_rounds (user_id, game, stake, state) VALUES ($1,$2,$3,$4) RETURNING id`, [userId, game, stake, JSON.stringify(state)]); }
      catch (e) { if (e.code === "23505") throw new Error("ACTIVE"); throw e; }
      return { id: Number(r.rows[0].id), ver: 0, stake, balance };
    });
  }
  async roundGet(userId, game) {
    const x = (await this.q(`SELECT * FROM game_rounds WHERE user_id=$1 AND game=$2 AND status='active'`, [userId, game])).rows[0];
    return x ? { id: Number(x.id), ver: x.ver, stake: Number(x.stake), state: JSON.parse(x.state) } : null;
  }
  async roundUpdate(id, ver, userId, state, extra, label) {
    return this.tx(async (c) => {
      const balance = extra > 0 ? await this.debitIn(c, userId, extra, label) : null;
      const r = await c.query(`UPDATE game_rounds SET state=$3, stake = stake + $4, ver = ver + 1, updated_at = now() WHERE id=$1 AND ver=$2 AND status='active' RETURNING stake`, [id, ver, JSON.stringify(state), extra]);
      if (!r.rows.length) throw new Error("CONFLICT");
      return { ver: ver + 1, stake: Number(r.rows[0].stake), balance };
    });
  }
  // 结算：退还/奖金、庄家对冲、历史记录、关闭牌局，一个事务完成
  // extra：结算前最后一步要追加的押注（例如加倍、跟注），在同一个事务里先扣
  async roundSettle(id, ver, userId, houseId, game, payout, state, label, detail, extra = 0, extraLabel = "") {
    return this.tx(async (c) => {
      if (extra > 0) await this.debitIn(c, userId, extra, extraLabel || label);
      const r = await c.query(`UPDATE game_rounds SET status='settled', state=$3, stake = stake + $4, ver = ver + 1, updated_at = now() WHERE id=$1 AND ver=$2 AND status='active' RETURNING stake`, [id, ver, JSON.stringify(state), extra]);
      if (!r.rows.length) throw new Error("CONFLICT");
      const stake = Number(r.rows[0].stake);
      const u = await c.query(`UPDATE users SET balance = balance + $2, turnover = turnover + $3 WHERE id=$1 RETURNING balance`, [userId, payout, stake]);
      const bal = Number(u.rows[0].balance);
      if (payout) await c.query(`INSERT INTO ledger (user_id, delta, balance_after, reason, actor) VALUES ($1,$2,$3,$4,'system')`, [userId, payout, bal, label]);
      if (stake !== payout) { const h = await c.query(`UPDATE users SET balance = balance + $2 WHERE id=$1 RETURNING balance`, [houseId, stake - payout]);
        await c.query(`INSERT INTO ledger (user_id, delta, balance_after, reason, actor) VALUES ($1,$2,$3,$4,'system')`, [houseId, stake - payout, Number(h.rows[0].balance), label]); }
      const ins = await c.query(`INSERT INTO slot_spins (user_id, game, bet, win, free_spins, balance_after, detail) VALUES ($1,$2,$3,$4,0,$5,$6) RETURNING id`, [userId, game, stake, payout, bal, detail ? JSON.stringify(detail) : null]);
      return { balance: bal, stake, id: Number(ins.rows[0].id) };
    });
  }
  // ---- 跑马灯：最近的大奖 ----
  async recentBigWins(limit = 20) {
    const r = await this.q(`SELECT s.game, s.bet, s.win, s.created_at, u.username FROM slot_spins s JOIN users u ON u.id=s.user_id WHERE s.win >= 500 AND (s.win >= s.bet * 10 OR s.win >= 10000) ORDER BY s.id DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({ game: x.game, bet: Number(x.bet), win: Number(x.win), username: x.username, at: new Date(x.created_at).getTime() }));
  }
  // ---- 邀请好友（固定奖励，没有提成、没有多级） ----
  async firstPlay(userId) { const r = await this.q(`UPDATE users SET first_played = TRUE WHERE id=$1 AND NOT first_played RETURNING invited_by, invite_status`, [userId]); return r.rows[0] ? { invitedBy: r.rows[0].invited_by == null ? null : Number(r.rows[0].invited_by), inviteStatus: r.rows[0].invite_status } : null; }
  async countInviteesByIp(inviterId, ip) { return Number((await this.q(`SELECT count(*) AS n FROM users WHERE invited_by=$1 AND (reg_ip=$2 OR last_ip=$2)`, [inviterId, ip])).rows[0].n); }
  async inviteReward(inviteeId, amount, cap) {
    return this.tx(async (c) => {
      const me = (await c.query(`SELECT invited_by, invite_status, username FROM users WHERE id=$1 FOR UPDATE`, [inviteeId])).rows[0];
      if (!me || me.invite_status !== "pending" || me.invited_by == null) return me ? me.invite_status : null;
      const inviter = Number(me.invited_by);
      const iv = (await c.query(`SELECT username FROM users WHERE id=$1 FOR UPDATE`, [inviter])).rows[0]; if (!iv) return null;
      const n = Number((await c.query(`SELECT count(*) AS n FROM users WHERE invited_by=$1 AND invite_status='rewarded'`, [inviter])).rows[0].n);
      if (n >= cap) { await c.query(`UPDATE users SET invite_status='capped' WHERE id=$1`, [inviteeId]); return "capped"; }
      await c.query(`INSERT INTO reward_claims (user_id, type, ref, amount) VALUES ($1,'invite',$3,$4), ($2,'invited',$3,$4)`, [inviter, inviteeId, "u" + inviteeId, amount]);
      for (const [uid, why] of [[inviter, `邀请好友奖励（${me.username} 首次游戏）`], [inviteeId, `受邀注册奖励（邀请人 ${iv.username}）`]]) {
        const b = await c.query(`UPDATE users SET balance = balance + $2 WHERE id=$1 RETURNING balance`, [uid, amount]);
        await c.query(`INSERT INTO ledger (user_id, delta, balance_after, reason, actor) VALUES ($1,$2,$3,$4,'system')`, [uid, amount, Number(b.rows[0].balance), why]);
      }
      await c.query(`UPDATE users SET invite_status='rewarded' WHERE id=$1`, [inviteeId]);
      return "rewarded";
    });
  }
  async inviteList(inviterId) {
    const r = await this.q(`SELECT username, invite_status, created_at FROM users WHERE invited_by=$1 ORDER BY id DESC LIMIT 100`, [inviterId]);
    return r.rows.map((x) => ({ username: x.username, status: x.invite_status, at: new Date(x.created_at).getTime() }));
  }
  async inviteStats() {
    const s = (await this.q(`SELECT invite_status AS st, count(*) AS n FROM users WHERE invited_by IS NOT NULL GROUP BY invite_status`)).rows;
    const top = (await this.q(`SELECT i.id, i.username, i.public_id, count(*) AS total, sum(CASE WHEN u.invite_status='rewarded' THEN 1 ELSE 0 END) AS rewarded FROM users u JOIN users i ON i.id=u.invited_by GROUP BY i.id, i.username, i.public_id ORDER BY rewarded DESC, total DESC LIMIT 30`)).rows;
    return { byStatus: Object.fromEntries(s.map((x) => [x.st || "none", Number(x.n)])), inviters: top.map((x) => ({ userId: Number(x.id), username: x.username, publicId: Number(x.public_id), total: Number(x.total), rewarded: Number(x.rewarded) })) };
  }
  async rewardTotals() {
    const r = await this.q(`SELECT type, count(*) AS n, COALESCE(sum(amount),0) AS amount FROM reward_claims GROUP BY type`);
    return Object.fromEntries(r.rows.map((x) => [x.type, { count: Number(x.n), amount: Number(x.amount) }]));
  }
  async close() { await this.pool.end(); }
}

class JsonStore {
  constructor(file) { this.file = file; this.kind = file ? "json" : "memory"; }
  async init() {
    this.d = { seq: 0, users: [], ledger: [], sessions: {}, settings: {} };
    if (this.file && fs.existsSync(this.file)) this.d = JSON.parse(fs.readFileSync(this.file, "utf8"));
    this.lock = Promise.resolve();
    // 玩家 ID 补发（按注册顺序，从 10001 开始）
    this.d.avatars ||= {};
    let mx = Math.max(10000, this.d.pubSeq || 0, ...this.d.users.map((u) => u.publicId || 0));
    for (const u of [...this.d.users].sort((a, b) => a.id - b.id)) if (!u.isHouse && !u.publicId) u.publicId = ++mx;
    this.d.pubSeq = mx;
    this.migrateCentsSync(); this.save();
  }
  migrateCentsSync() {
    const d = this.d; d.settings ||= {};
    if (d.settings.amountsInCents) return false;
    for (const u of d.users) { u.balance = Math.round((u.balance || 0) * 100); if (u.pokerBest) u.pokerBest *= 100; }
    for (const l of d.ledger || []) { l.delta *= 100; l.balanceAfter *= 100; }
    for (const x of d.slotSpins || []) { x.bet *= 100; x.win *= 100; x.balanceAfter *= 100; }
    for (const t of Object.values(d.slotTotals || {})) { t.bets *= 100; t.wins *= 100; t.best *= 100; }
    d.settings.amountsInCents = 1; return true;
  }
  async migrateCents() { const m = this.migrateCentsSync(); this.save(); return m;
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(this.d)); fs.renameSync(tmp, this.file);
  }
  u(id) { return this.d.users.find((x) => x.id === id); }
  pub(r) { return r && { publicId: null, avatarVer: 0, handsPlayed: 0, handsWon: 0, pokerBest: 0, turnover: 0, invitedBy: null, inviteStatus: null, regIp: null, lastIp: null, firstPlayed: false, ...r }; }
  log(id, delta, bal, reason, actor) {
    this.d.ledger.push({ userId: id, delta, balanceAfter: bal, reason, actor, at: Date.now() });
    if (this.d.ledger.length > 50000) this.d.ledger.splice(0, this.d.ledger.length - 50000);
  }
  async createUser(username, passHash, balance, { isAdmin = false, isHouse = false, invitedBy = null, inviteStatus = null, regIp = null } = {}) {
    if (this.d.users.some((x) => x.username.toLowerCase() === username.toLowerCase())) throw new Error("EXISTS");
    const r = { id: ++this.d.seq, username, passHash, balance, isAdmin, isHouse, banned: false, lastClaim: null, createdAt: Date.now(), lastLogin: null,
      turnover: 0, invitedBy, inviteStatus, regIp, lastIp: regIp, firstPlayed: false,
      publicId: isHouse ? null : (this.d.pubSeq = Math.max(10000, this.d.pubSeq || 0) + 1), avatarVer: 0, handsPlayed: 0, handsWon: 0, pokerBest: 0 };
    this.d.users.push(r); if (balance) this.log(r.id, balance, balance, "注册赠送", "system"); this.save(); return this.pub(r);
  }
  async getUserByName(name) { return this.pub(this.d.users.find((x) => x.username.toLowerCase() === String(name).toLowerCase())); }
  async getUser(id) { return this.pub(this.u(Number(id))); }
  async updateUser(id, f) { const r = this.u(id); if (!r) return; for (const k of ["passHash", "isAdmin", "banned", "lastLogin", "lastIp"]) if (k in f) r[k] = f[k]; this.save(); }
  async adjust(id, delta, reason, actor = "system", allowNegative = false) {
    const r = this.u(id); if (!r) throw new Error("NOUSER");
    if (!allowNegative && r.balance + delta < 0) throw new Error("INSUFFICIENT");
    r.balance += delta; this.log(id, delta, r.balance, reason, actor); this.save(); return r.balance;
  }
  async claimDaily(id, day, amount) {
    const r = this.u(id); if (!r || r.lastClaim === day) return null;
    r.lastClaim = day; r.balance += amount; this.log(id, amount, r.balance, "每日免费领取", "system"); this.save(); return r.balance;
  }
  async searchUsers(q = "", limit = 50) { q = String(q).toLowerCase().trim(); return this.d.users.filter((x) => !x.isHouse && (x.username.toLowerCase().includes(q) || String(x.publicId) === q)).sort((a, b) => b.id - a.id).slice(0, limit).map((x) => this.pub(x)); }
  async countUsers() { return this.d.users.filter((x) => !x.isHouse).length; }
  async ledger(userId, limit = 50) { return this.d.ledger.filter((x) => x.userId === userId).slice(-limit).reverse().map(({ userId: _u, ...x }) => x); }
  async createSession(token, userId, expiresAt) { this.d.sessions[token] = { userId, expiresAt }; this.save(); }
  async getSession(token) { const s = this.d.sessions[token]; return s && s.expiresAt > Date.now() ? { token, userId: s.userId } : null; }
  async deleteSession(token) { delete this.d.sessions[token]; this.save(); }
  async deleteUserSessions(userId) { for (const [t, s] of Object.entries(this.d.sessions)) if (s.userId === userId) delete this.d.sessions[t]; this.save(); }
  async getSettings() { return { ...this.d.settings }; }
  async setSetting(k, v) { this.d.settings[k] = v; this.save(); }
  async slotSpin(userId, houseId, game, bet, win, freeSpins, label, opts = {}) {
    const r = this.u(userId); if (!r) throw new Error("NOUSER");
    if (r.banned || r.balance < Math.max(bet, opts.need || 0) || r.balance - bet + win < 0) throw new Error("INSUFFICIENT");
    r.balance += win - bet; r.turnover = (r.turnover || 0) + bet; this.log(userId, win - bet, r.balance, label, "system");
    const h = this.u(houseId); if (h) { h.balance += bet - win; if (bet !== win) this.log(houseId, bet - win, h.balance, label, "system"); }
    const d = this.d; d.slotSpins ||= []; d.slotSeq = (d.slotSeq || 0) + 1; d.slotTotals ||= {};
    const rec = { id: d.slotSeq, userId, game, bet, win, freeSpins, balanceAfter: r.balance, detail: opts.detail || null, at: Date.now() };
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
  async getUserByPublicId(pid) { return this.pub(this.d.users.find((x) => x.publicId === Number(pid))); }
  async setAvatar(userId, mime, buf) { const u = this.u(userId); this.d.avatars[userId] = { mime, b64: buf.toString("base64") }; u.avatarVer = Math.abs(u.avatarVer || 0) + 1; this.save(); return u.avatarVer; }
  async clearAvatar(userId) { delete this.d.avatars[userId]; const u = this.u(userId); u.avatarVer = -Math.abs(u.avatarVer || 0); this.save(); return u.avatarVer; }
  async getAvatar(userId) { const a = this.d.avatars[userId]; return a ? { mime: a.mime, data: Buffer.from(a.b64, "base64") } : null; }
  async addPokerStats(userId, won, amount, turnover = 0) { const u = this.u(userId); if (!u) return; u.handsPlayed = (u.handsPlayed || 0) + 1; u.handsWon = (u.handsWon || 0) + (won ? 1 : 0); u.pokerBest = Math.max(u.pokerBest || 0, amount); u.turnover = (u.turnover || 0) + turnover; this.save(); }
  // 多步骤牌局（JSON 版：单线程，内存里一次改完就等于一个事务）
  async roundStart(userId, game, stake, state, label) {
    const d = this.d; d.rounds ||= {}; const k = userId + ":" + game; if (d.rounds[k]) throw new Error("ACTIVE");
    const u = this.u(userId); if (!u || u.banned || u.balance < stake) throw new Error("INSUFFICIENT");
    u.balance -= stake; this.log(userId, -stake, u.balance, label, "system");
    d.roundSeq = (d.roundSeq || 0) + 1; d.rounds[k] = { id: d.roundSeq, ver: 0, stake, state: JSON.stringify(state) }; this.save();
    return { id: d.roundSeq, ver: 0, stake, balance: u.balance };
  }
  findRound(id) { return Object.entries(this.d.rounds || {}).find(([, r]) => r.id === id); }
  async roundGet(userId, game) { const r = (this.d.rounds || {})[userId + ":" + game]; return r ? { id: r.id, ver: r.ver, stake: r.stake, state: JSON.parse(r.state) } : null; }
  async roundUpdate(id, ver, userId, state, extra, label) {
    const f = this.findRound(id); if (!f || f[1].ver !== ver) throw new Error("CONFLICT");
    const u = this.u(userId); let balance = null;
    if (extra > 0) { if (u.banned || u.balance < extra) throw new Error("INSUFFICIENT"); u.balance -= extra; balance = u.balance; this.log(userId, -extra, u.balance, label, "system"); }
    const r = f[1]; r.ver++; r.stake += extra; r.state = JSON.stringify(state); this.save(); return { ver: r.ver, stake: r.stake, balance };
  }
  async roundSettle(id, ver, userId, houseId, game, payout, state, label, detail, extra = 0, extraLabel = "") {
    const f = this.findRound(id); if (!f || f[1].ver !== ver) throw new Error("CONFLICT");
    const u = this.u(userId);
    if (extra > 0) { if (u.banned || u.balance < extra) throw new Error("INSUFFICIENT"); u.balance -= extra; this.log(userId, -extra, u.balance, extraLabel || label, "system"); }
    const stake = f[1].stake + extra; delete this.d.rounds[f[0]]; u.balance += payout; u.turnover = (u.turnover || 0) + stake; if (payout) this.log(userId, payout, u.balance, label, "system");
    const h = this.u(houseId); if (h && stake !== payout) { h.balance += stake - payout; this.log(houseId, stake - payout, h.balance, label, "system"); }
    const d = this.d; d.slotSpins ||= []; d.slotSeq = (d.slotSeq || 0) + 1; d.slotTotals ||= {};
    d.slotSpins.push({ id: d.slotSeq, userId, game, bet: stake, win: payout, freeSpins: 0, balanceAfter: u.balance, detail: detail || null, at: Date.now() });
    for (const key of [game, game + ":" + userId]) { const t = (d.slotTotals[key] ||= { spins: 0, bets: 0, wins: 0, features: 0, best: 0 }); t.spins++; t.bets += stake; t.wins += payout; t.best = Math.max(t.best, payout); }
    this.save(); return { balance: u.balance, stake, id: d.slotSeq };
  }
  async recentBigWins(limit = 20) {
    return (this.d.slotSpins || []).filter((x) => x.win >= 500 && (x.win >= x.bet * 10 || x.win >= 10000)).slice(-limit).reverse()
      .map((x) => ({ game: x.game, bet: x.bet, win: x.win, username: (this.u(x.userId) || {}).username, at: x.at }));
  }
  async firstPlay(userId) { const u = this.u(userId); if (!u || u.firstPlayed) return null; u.firstPlayed = true; this.save(); return { invitedBy: u.invitedBy ?? null, inviteStatus: u.inviteStatus ?? null }; }
  async countInviteesByIp(inviterId, ip) { return this.d.users.filter((x) => x.invitedBy === inviterId && (x.regIp === ip || x.lastIp === ip)).length; }
  async inviteReward(inviteeId, amount, cap) {
    const me = this.u(inviteeId); if (!me || me.inviteStatus !== "pending" || me.invitedBy == null) return me ? me.inviteStatus : null;
    const iv = this.u(me.invitedBy); if (!iv) return null;
    if (this.d.users.filter((x) => x.invitedBy === iv.id && x.inviteStatus === "rewarded").length >= cap) { me.inviteStatus = "capped"; this.save(); return "capped"; }
    const C = (this.d.claims ||= []);
    if (C.some((c) => c.type === "invite" && c.ref === "u" + inviteeId)) return "rewarded";
    C.push({ userId: iv.id, type: "invite", ref: "u" + inviteeId, amount, at: Date.now() }, { userId: inviteeId, type: "invited", ref: "u" + inviteeId, amount, at: Date.now() });
    iv.balance += amount; this.log(iv.id, amount, iv.balance, `邀请好友奖励（${me.username} 首次游戏）`, "system");
    me.balance += amount; this.log(me.id, amount, me.balance, `受邀注册奖励（邀请人 ${iv.username}）`, "system");
    me.inviteStatus = "rewarded"; this.save(); return "rewarded";
  }
  async inviteList(inviterId) { return this.d.users.filter((x) => x.invitedBy === inviterId).sort((a, b) => b.id - a.id).slice(0, 100).map((x) => ({ username: x.username, status: x.inviteStatus, at: x.createdAt })); }
  async inviteStats() {
    const inv = this.d.users.filter((x) => x.invitedBy != null); const byStatus = {}; inv.forEach((x) => (byStatus[x.inviteStatus || "none"] = (byStatus[x.inviteStatus || "none"] || 0) + 1));
    const m = new Map(); inv.forEach((x) => { const t = m.get(x.invitedBy) || { total: 0, rewarded: 0 }; t.total++; if (x.inviteStatus === "rewarded") t.rewarded++; m.set(x.invitedBy, t); });
    const inviters = [...m].map(([id, t]) => { const u = this.u(id) || {}; return { userId: id, username: u.username, publicId: u.publicId, ...t }; }).sort((a, b) => b.rewarded - a.rewarded || b.total - a.total).slice(0, 30);
    return { byStatus, inviters };
  }
  async rewardTotals() { const o = {}; for (const c of this.d.claims || []) { const t = (o[c.type] ||= { count: 0, amount: 0 }); t.count++; t.amount += c.amount; } return o; }
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
