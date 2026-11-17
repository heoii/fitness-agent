import { NextRequest, NextResponse } from "next/server";

/**
 * 应用层 token 守卫（2026-11-17）
 *
 * 为什么不用「来源 IP 是 127.0.0.1」判断本机：Cloudflare 隧道也是在同一台 Mac 上
 * 转发到 127.0.0.1:3000，按 IP 豁免会把公网请求一起放行，等于没鉴权。
 * 判据改成「有没有 Cloudflare 注入的头」：本机浏览器直连没有这些头 → 放行；
 * 经隧道进来的请求必带 cf-connecting-ip / cf-ray → 必须带正确 token。
 *
 * 这样 src/app/page.tsx 用相对路径 fetch 的本机网页不用改，也不需要在页面里塞 token
 * （页面经隧道打开时本身就拿不到 token，正好不会泄露）。
 *
 * 拒绝时只记一行粗日志：不记 token、不记问题正文、不记完整 URL。
 */
const CF_MARKERS = ["cf-connecting-ip", "cf-ray"];

function viaTunnel(req: NextRequest): boolean {
  return CF_MARKERS.some((h) => !!req.headers.get(h));
}

/**
 * 返回 null 表示放行；否则返回一个 401 JSON 响应。
 * field 用来对齐各路由自己的失败体形状：/api/ask 用 reason，/api/extract 用 raw。
 */
export function authGuard(
  req: NextRequest,
  field: "reason" | "raw" = "reason"
): NextResponse | null {
  if (!viaTunnel(req)) return null;

  const expected = process.env.FIT_AGENT_TOKEN || "";
  const got = req.headers.get("x-fit-token") || "";
  // 没配 token 时一律拒绝（fail closed），避免「忘了配」变成「公网裸奔」
  if (expected && got === expected) return null;

  try {
    console.log("[auth] denied: tunneled request without valid token");
  } catch {
    /* 日志不可用时不影响拒绝 */
  }
  return NextResponse.json({ ok: false, [field]: "未授权" }, { status: 401 });
}
