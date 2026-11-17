/**
 * 练练健身（KeepStrong）写入客户端（2026-11-17）
 *
 * 只做一件事：把「某档动作清单」写成练练日历上的排期训练。
 *
 * 为什么不用 MCP 连接器：keepstrong 的 MCP 只在 WorkBuddy 会话里可用，
 * 小程序/云函数调不到。这里直接在服务端发 HTTP，密钥来源两个：
 *   ① 环境变量 KEEPSTRONG_API_KEY / KEEPSTRONG_BASE_URL（部署时配）
 *   ② 本机回落到 ~/.workbuddy/mcp.json 里已配好的连接器 env（不复制、不落盘）
 *
 * 三条硬约束（来自练练 Skill 文档，违反会写坏数据）：
 *   · dayStr 必须是 yyyyMMdd
 *   · 动作必须用动作库返回的 actionId，不得臆造
 *   · 重量未指定发 ""，绝不用 0（0 会关掉自动历史重量）
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const SKILL_VERSION = process.env.KEEPSTRONG_SKILL_VERSION || "1.29.0";

interface KsCreds {
  base: string;
  key: string;
}

let cached: KsCreds | null = null;

/** 优先环境变量；没有就读本机 mcp.json 里 keepstrong 的 env。只读，不打印。 */
async function creds(): Promise<KsCreds> {
  if (cached) return cached;
  let base = process.env.KEEPSTRONG_BASE_URL || "";
  let key = process.env.KEEPSTRONG_API_KEY || "";
  if (!base || !key) {
    try {
      const p = path.join(homedir(), ".workbuddy", "mcp.json");
      const j = JSON.parse(await readFile(p, "utf8")) as {
        mcpServers?: Record<string, { env?: Record<string, string> }>;
      };
      const e = j.mcpServers?.keepstrong?.env || {};
      base = base || e.KEEPSTRONG_BASE_URL || "";
      key = key || e.KEEPSTRONG_API_KEY || "";
    } catch {
      /* 读不到就让调用方报「没配」 */
    }
  }
  if (!base || !key) throw new Error("没有练练的 API Key（KEEPSTRONG_API_KEY）");
  cached = { base: base.replace(/\/+$/, ""), key };
  return cached;
}

/**
 * 写操作的 Idempotency-Key 必须自己带：MCP 连接器会自动加，直连 HTTP 不会，
 * 缺了练练直接 400 INVALID_IDEMPOTENCY_KEY（2026-11-17 实测）。
 */
function headers(key: string, idempotent = false): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
    "X-KeepStrong-Skill-Version": SKILL_VERSION,
    "X-KeepStrong-Agent-Name": "WorkBuddy",
    "X-Timezone-Offset": "480",
  };
  if (idempotent) {
    h["Idempotency-Key"] =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return h;
}

/** 搜动作库拿 actionId。返回完全同名优先，其次包含关系最像的那个。 */
async function findActionId(name: string): Promise<string> {
  const { base, key } = await creds();
  const url = base + "/api/v1/ai/training/actions?keyword=" + encodeURIComponent(name) + "&page=1&pageSize=10";
  const r = await fetch(url, { headers: headers(key) });
  if (!r.ok) return "";
  const j = (await r.json()) as { list?: { actionId?: string; id?: string; name?: string }[] };
  const list = j.list || [];
  if (!list.length) return "";
  const pick = (x: { actionId?: string; id?: string; name?: string }) => x.actionId || x.id || "";
  const exact = list.find((x) => (x.name || "").trim() === name.trim());
  if (exact) return pick(exact);
  // 退一步：名字互相包含（「史密斯推胸」vs「史密斯机推胸」）
  const loose = list.find((x) => {
    const a = (x.name || "").replace(/\s/g, "");
    const b = name.replace(/\s/g, "");
    return a && (a.includes(b) || b.includes(a));
  });
  return loose ? pick(loose) : "";
}

/** "37.5–42.5kg" → "37.5"（起手取下限，与引擎「起手区间」的口径一致） */
export function lowerWeight(w: string): string {
  if (!w) return "";
  if (w.indexOf("自重") >= 0) return "";
  const m = w.match(/\d+(?:\.\d+)?/);
  return m ? m[0] : "";
}

export interface SaveAction {
  name: string;
  sets: number;
  reps: string;
  weight: string;
  rest?: string;
  /** 逐级热身；不传就只有正式组（旧调用方兼容） */
  warmups?: { weight: string; reps: string }[];
}

export interface SaveResult {
  ok: boolean;
  saved: number;
  skipped: string[];
  dayStr: string;
  reason?: string;
  /** dryRun 时回显组装结果：每个动作几组、其中几组是热身。用来验证热身有没有挂上 */
  preview?: { name: string; groups: number; hot: number }[];
}

/**
 * 写一条排期训练。逐动作搜 actionId，匹配不到就跳过并回报，绝不臆造 ID。
 * userConfirmed=true 由调用方保证「用户已在小程序点过确认」。
 */
export async function saveScheduledWorkout(
  date: string,
  title: string,
  actions: SaveAction[],
  dryRun = false
): Promise<SaveResult> {
  const dayStr = date.replace(/-/g, "");
  if (!/^\d{8}$/.test(dayStr)) {
    return { ok: false, saved: 0, skipped: [], dayStr, reason: "日期格式不对（要 yyyyMMdd）" };
  }
  const { base, key } = await creds();

  const built: unknown[] = [];
  const skipped: string[] = [];
  for (const a of actions) {
    const actionId = await findActionId(a.name);
    if (!actionId) {
      skipped.push(a.name);
      continue;
    }
    const rest = Number(String(a.rest || "").replace(/[^\d]/g, "")) || 90;
    const w = lowerWeight(a.weight);
    const reps = String(a.reps || "8");
    const n = Math.max(1, Math.min(20, Number(a.sets) || 1));
    // 热身组要和正式组一起塞进 groups，并用 flag:"hot" 标记——这是练练自己的口径
    // （引擎 is_warmup 就是认这个字段）。少了它，App 里只看到正式组，热身等于没写。
    // 热身排在正式组前面，跟实际练的顺序一致；组间休息短，固定 60s。
    const warmGroups = (a.warmups || [])
      .filter((x) => x && String(x.weight) !== "")
      .map((x) => ({
        weight: String(x.weight),
        reps: String(x.reps || "8"),
        realRestSeconds: 60,
        combGroups: [] as unknown[],
        flag: "hot",
      }));
    built.push({
      actionId,
      name: a.name,
      weightUnit: "kg",
      restSeconds: rest,
      groups: [
        ...warmGroups,
        ...Array.from({ length: n }, () => ({
          weight: w, // 自重动作给 ""，绝不填 0
          reps,
          realRestSeconds: rest,
          combGroups: [] as unknown[],
        })),
      ],
      combActions: [],
    });
  }

  if (!built.length) {
    return { ok: false, saved: 0, skipped, dayStr, reason: "动作一个都没匹配上练练的动作库" };
  }
  // 干跑：只回报能匹配几个、每个动作组装出几组（含几组热身），不落库。
  // 用来验证名字映射与热身挂载，也不在日历里留测试垃圾。
  if (dryRun) {
    const preview = built.map((b) => {
      const o = b as { name?: string; groups?: { flag?: string }[] };
      const gs = o.groups || [];
      return { name: String(o.name || ""), groups: gs.length, hot: gs.filter((g) => g.flag === "hot").length };
    });
    return { ok: true, saved: built.length, skipped, dayStr, reason: "dryRun（未写入）", preview };
  }

  const r = await fetch(base + "/api/v1/ai/training/scheduled-workouts", {
    method: "POST",
    headers: headers(key, true),
    body: JSON.stringify({
      userConfirmed: true,
      dayStr,
      name: title,
      actions: built,
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return {
      ok: false,
      saved: 0,
      skipped,
      dayStr,
      reason: `练练返回 HTTP ${r.status}${txt ? "：" + txt.slice(0, 120) : ""}`,
    };
  }
  return { ok: true, saved: built.length, skipped, dayStr };
}
