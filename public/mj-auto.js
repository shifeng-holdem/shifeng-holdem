// 时烽麻将消消乐 · 自动转的判断逻辑（纯函数，浏览器和测试共用）
(function (root) {
  const COUNTS = [10, 30, 50, 100, Infinity];
  // 金额是整数分
  const money = (c) => { c = Math.round(+c || 0); return Math.floor(c / 100).toLocaleString("en-US") + "." + String(c % 100).padStart(2, "0"); };
  // 一局结束后决定是否继续；返回停止原因（字符串）或 null 表示继续
  function afterSpin(a, { balance, bet, win, error, hidden, left: leftPage }) {
    if (error) return "出错了，自动已停止";
    if (leftPage || hidden) return "已离开游戏，自动已停止";
    if (a.stopReq) return "自动已停止";
    if (a.winOver > 0 && win > a.winOver) return `单次赢得 ${money(win)}，超过 ${money(a.winOver)}，自动已停止`;
    if (a.balUnder > 0 && balance < a.balUnder) return `余额低于 ${money(a.balUnder)}，自动已停止`;
    if (a.left !== Infinity && a.left <= 0) return "自动转完成";
    if (balance < bet) return "余额不足，请联系客服获取游戏币";
    return null;
  }
  // 开始前的检查
  function canStart({ balance, bet }) { return balance >= bet ? null : "余额不足，请联系客服获取游戏币"; }
  function create(count, { winOver = 0, balUnder = 0 } = {}) {
    if (!COUNTS.includes(count)) throw new Error("bad count");
    return { total: count, left: count, done: 0, winOver: Math.max(0, Math.floor(+winOver || 0)), balUnder: Math.max(0, Math.floor(+balUnder || 0)), stopReq: false };
  }
  function consume(a) { a.done++; if (a.left !== Infinity) a.left--; return a; }
  const label = (a) => (a.left === Infinity ? "∞" : String(a.left));
  root.MJAuto = { COUNTS, afterSpin, canStart, create, consume, label };
  if (typeof module !== "undefined") module.exports = root.MJAuto;
})(typeof window !== "undefined" ? window : globalThis);
