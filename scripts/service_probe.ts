/**
 * 常驻服务配置自检：`npm run w8:service`（不调模型、不依赖 launchd 能否注册）
 *
 * 为什么需要它：W15 装自启时，`launchctl bootstrap` 在这个会话里报
 * "Input/output error"，连一个只打印 hello 的最小 plist 都注册不了 —— 是环境
 * 没有 GUI 登录上下文，不是配置写错。这种情况下最容易犯的错是**嘴上说装好了**。
 * 所以把「能静态验的」全部做成判据，把「必须下次登录才知道的」单独列出。
 *
 * 判据分两类，输出里明写哪类没验证：
 *   ① 静态配置（这里全过才能保证下次登录会生效）
 *   ② 运行时（服务在不在、只听不听回环）—— 只作观测量，不算判据，
 *      因为服务可能恰好没开，那不是配置错。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const repo = process.cwd();
const home = process.env.HOME ?? "";
const label = "com.heoii.fitness-agent";
const plistPath = join(home, "Library/LaunchAgents", `${label}.plist`);

const cases: Array<{ name: string; ok: boolean; got: string; want: string }> = [];
const push = (name: string, ok: boolean, got: unknown, want: unknown) =>
  cases.push({ name, ok, got: String(got), want: String(want) });

/* ── ① 静态配置 ── */
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const dev: string = pkg.scripts?.dev ?? "";
const start: string = pkg.scripts?.start ?? "";
push("dev 绑定回环", dev.includes("-H 127.0.0.1"), dev, "含 -H 127.0.0.1");
push("start 绑定回环", start.includes("-H 127.0.0.1"), start, "含 -H 127.0.0.1");
push("start 是生产模式", start.trim().startsWith("next start"), start.trim(), "next start …");

const sh = join(repo, "scripts/service.sh");
push("service.sh 存在", existsSync(sh), existsSync(sh), true);
push("service.sh 可执行", existsSync(sh) && !!(statSync(sh).mode & 0o111),
  existsSync(sh) ? (statSync(sh).mode & 0o777).toString(8) : "缺失", "含 x 位");
const shText = existsSync(sh) ? readFileSync(sh, "utf8") : "";
for (const cmd of ["install", "uninstall", "status", "logs", "restart", "start-once"]) {
  push(`service.sh 有 ${cmd}`, shText.includes(`  ${cmd})`), shText.includes(`  ${cmd})`), true);
}
push("status 绕过代理", shText.includes("--noproxy '*'"),
  shText.includes("--noproxy '*'"), true);
push("install 不谎报成功", shText.includes("尚未在本机验证") || shText.includes("⚠"),
  shText.includes("尚未在本机验证") || shText.includes("⚠"), true);

push("BUILD_ID 存在", existsSync(join(repo, ".next/BUILD_ID")),
  existsSync(join(repo, ".next/BUILD_ID")), true);

/* ── ② plist（本机文件，不进仓）── */
push("plist 已就位", existsSync(plistPath), existsSync(plistPath), true);
if (existsSync(plistPath)) {
  const p = readFileSync(plistPath, "utf8");
  let lint = "";
  try { lint = execFileSync("plutil", ["-lint", plistPath], { encoding: "utf8" }).trim(); }
  catch (e) { lint = e instanceof Error ? e.message : String(e); }
  push("plist 语法合法", lint.includes(": OK"), lint.includes(": OK") ? "OK" : lint.slice(0, 80), "OK");
  push("Label 正确", p.includes(`<string>${label}</string>`), p.includes(label), true);
  push("RunAtLoad 开", /<key>RunAtLoad<\/key>\s*<true\/>/.test(p),
    /<key>RunAtLoad<\/key>\s*<true\/>/.test(p), true);
  push("KeepAlive 开", /<key>KeepAlive<\/key>\s*<true\/>/.test(p),
    /<key>KeepAlive<\/key>\s*<true\/>/.test(p), true);
  push("ThrottleInterval ≥10", /<key>ThrottleInterval<\/key>\s*<integer>(\d+)/.test(p) &&
    Number(p.match(/<key>ThrottleInterval<\/key>\s*<integer>(\d+)/)?.[1] ?? 0) >= 10,
    p.match(/<key>ThrottleInterval<\/key>\s*<integer>(\d+)/)?.[1] ?? "缺", ">=10");
  push("走生产 start 而非 dev", p.includes("run start") && !p.includes("run dev"),
    p.includes("run start"), true);
  push("stdout 日志落盘", p.includes("StandardOutPath"), p.includes("StandardOutPath"), true);
  push("stderr 日志落盘", p.includes("StandardErrorPath"), p.includes("StandardErrorPath"), true);
  // 公开仓不许带本机绝对路径：这里检查的是「plist 里该有」，同时确保 plist 不在仓内
  push("plist 不在仓库里", !existsSync(join(repo, `${label}.plist`)),
    !existsSync(join(repo, `${label}.plist`)), true);
}

/* ── 观测量：不算判据，如实打印 ── */
console.log("── 静态配置 ──");
for (const c of cases) console.log(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(26)} got=${c.got}  want=${c.want}`);
const bad = cases.filter((c) => !c.ok).length;

console.log("\n── 运行时观测量（不算判据）──");
let listening = "";
try { listening = execFileSync("lsof", ["-nP", "-iTCP:3000", "-sTCP:LISTEN"], { encoding: "utf8" }).trim(); }
catch { listening = "（没有服务在 3000）"; }
const listenLine = listening.split("\n").slice(1)[0] ?? "";
console.log(`· 3000 监听: ${listenLine || "无"}`);
console.log(`· 监听回环: ${/127\.0\.0\.1:3000/.test(listening)}`);
console.log("\n── 尚未验证（必须说清）──");
console.log("· 下次登录后 launchd 是否真的加载并拉起服务 —— 本会话无 GUI 登录上下文，");
console.log("  launchctl bootstrap 报 Input/output error，连最小 plist 也失败。");
console.log("· 进程被 kill 后 KeepAlive 是否自动拉起 —— 同上，需登录后在 launchd 接管下测。");
console.log(`  验证命令：./scripts/service.sh status（state = running）`);

console.log(`\n${bad === 0 ? "✓ 静态配置全过" : "✗ 配置有偏差"}：${cases.length - bad}/${cases.length}`);
if (bad) process.exitCode = 1;
