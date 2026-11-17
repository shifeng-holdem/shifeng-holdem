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
export const INVITE_TITLES = [{ n: 1, title: "紫晶新星" }, { n: 5, title: "紫晶推广大使" }, { n: 10, title: "金牌推广大使" }, { n: 20, title: "皇家荣誉大使" }];
export function inviteTitle(n) { let t = null; for (const x of INVITE_TITLES) if (n >= x.n) t = x.title; const next = INVITE_TITLES.find((x) => n < x.n) || null; return { title: t, next }; }
export const DEFAULT_REWARDS = { invite: { enabled: true, amount: 500, cap: 20 } }; // 5.00，每人最多 20 位好友
export function mask(name = "") { const a = [...String(name)]; if (a.length <= 1) return a.join("") + "*"; if (a.length === 2) return a[0] + "*"; return a[0] + "***" + a[a.length - 1]; }
