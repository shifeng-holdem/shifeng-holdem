// 平台功能（全部是游戏币）：VIP 等级（只是外观：头像框和称号，不发任何按流水比例的奖励）、
// 邀请好友（固定奖励、每人上限、荣誉称号；没有提成、没有多级、没有代理）、大奖跑马灯、公告。
export const VIP = [
  { level: 0, need: 0, title: "新手" }, { level: 1, need: 5000, title: "青铜" }, { level: 2, need: 20000, title: "白银" },
  { level: 3, need: 100000, title: "黄金" }, { level: 4, need: 300000, title: "铂金" }, { level: 5, need: 1000000, title: "钻石" },
  { level: 6, need: 3000000, title: "星耀" }, { level: 7, need: 10000000, title: "王者" }, { level: 8, need: 30000000, title: "紫晶" },
  { level: 9, need: 100000000, title: "至尊皇冠" },
]; // need：累计有效流水（分）
export function vipOf(turnover = 0) {
  let v = VIP[0]; for (const x of VIP) if (turnover >= x.need) v = x;
  const next = VIP[v.level + 1] || null;
  return { level: v.level, title: v.title, turnover, next: next ? { level: next.level, title: next.title, need: next.need } : null,
    progress: next ? Math.min(1, (turnover - v.need) / (next.need - v.need)) : 1 };
}
export const INVITE_TITLES = [{ n: 1, title: "紫晶新星" }, { n: 10, title: "紫晶推广大使" }, { n: 50, title: "金牌推广大使" }, { n: 100, title: "皇家荣誉大使" }];
export function inviteTitle(n) { let t = null; for (const x of INVITE_TITLES) if (n >= x.n) t = x.title; const next = INVITE_TITLES.find((x) => n < x.n) || null; return { title: t, next }; }
// 邀请奖励（全部是固定数额的游戏币，和好友的余额、下注都无关）：
//   amount     被邀请的好友固定得到的数额（5.00）
//   tiers      邀请人第 n 位成功邀请得到的数额：按 n 落在哪一档（from = 这一档从第几位开始）
//   milestones 邀请人成功邀请累计达到 at 位时，一次性额外奖励 bonus（每档只发一次）
//   cap        每位邀请人最多奖励多少位好友；0 = 不限
export const DEFAULT_REWARDS = { invite: { enabled: true, amount: 500, cap: 0,
  tiers: [{ from: 1, amount: 500 }, { from: 11, amount: 800 }, { from: 51, amount: 1000 }],
  milestones: [{ at: 10, bonus: 2000 }, { at: 50, bonus: 10000 }, { at: 100, bonus: 30000 }] } };
// 第 n 位成功邀请（从 1 开始）给邀请人的数额
export function tierAmount(n, tiers = DEFAULT_REWARDS.invite.tiers) { let a = 0; for (const t of [...tiers].sort((x, y) => x.from - y.from)) if (n >= t.from) a = t.amount; return a; }
// 已经成功邀请 done 位时：当前档（下一位按这一档发）、下一档、进度
export function tierInfo(done, tiers = DEFAULT_REWARDS.invite.tiers) {
  const T = [...tiers].sort((x, y) => x.from - y.from), k = done + 1;
  let i = -1; T.forEach((t, j) => { if (k >= t.from) i = j; });
  const cur = i >= 0 ? { ...T[i], to: T[i + 1] ? T[i + 1].from - 1 : null } : null, nxt = T[i + 1] || null;
  return { current: cur, next: nxt ? { ...nxt, need: nxt.from - 1 - done } : null,
    progress: nxt ? Math.min(1, (done - ((cur ? cur.from : 1) - 1)) / (nxt.from - (cur ? cur.from : 1))) : 1 };
}
// 校验后台提交的档位和里程碑
export function cleanTiers(list) {
  if (!Array.isArray(list) || !list.length || list.length > 10) return null;
  const T = list.map((t) => ({ from: Math.trunc(Number(t.from)), amount: Math.trunc(Number(t.amount)) })).sort((a, b) => a.from - b.from);
  if (T[0].from !== 1) return null;
  for (let i = 0; i < T.length; i++) { const t = T[i]; if (!(t.from >= 1 && t.amount >= 0 && t.amount <= 100000) || (i && t.from <= T[i - 1].from)) return null; }
  return T;
}
export function cleanMilestones(list) {
  if (!Array.isArray(list) || list.length > 20) return null;
  const M = list.map((m) => ({ at: Math.trunc(Number(m.at)), bonus: Math.trunc(Number(m.bonus)) })).sort((a, b) => a.at - b.at);
  for (let i = 0; i < M.length; i++) { const m = M[i]; if (!(m.at >= 1 && m.at <= 1000000 && m.bonus >= 0 && m.bonus <= 1000000) || (i && m.at === M[i - 1].at)) return null; }
  return M;
}
export function mask(name = "") { const a = [...String(name)]; if (a.length <= 1) return a.join("") + "*"; if (a.length === 2) return a[0] + "*"; return a[0] + "***" + a[a.length - 1]; }
