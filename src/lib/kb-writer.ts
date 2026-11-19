/**
 * 把小程序确认的判档结果写回知识库（2026-11-17）
 *
 * 为什么在这里写、不走云数据库队列：
 *   本机服务就在知识库这台机器上，`/api/save-plan` 跑的时候文件系统就在手边，
 *   没必要绕「小程序写队列 → 云函数 → 本机脚本回灌」那一圈。
 *
 * 写什么（只有这些，别扩大）：
 *   ① frontmatter：5 个判档维度 + 体重体脂 + 6 个 checkin_* 溯源字段
 *   ② 正文：`<!-- 判档:begin/end -->` 标记块，整段重写（同一天重复确认 = 覆盖）
 *
 * 纪律：
 *   - **只改自己那几行**，手写的「补录说明」等正文一个字不碰；
 *   - 当天记录不存在就报错，**不新建**（建空记录会污染日历和周复盘）；
 *   - 判档行必须是一行 `**判档：X**`，`build_weekly_module.py` 的正则靠它取结论。
 */
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Verdict {
  judge?: string;
  status?: string;
  red?: number;
  yellow?: number;
  dimensions?: number;
  dims?: { name: string; level: string; detail?: string }[];
}

export interface WriteCheckinOpts {
  /** YYYY-MM-DD */
  date: string;
  /** 小程序录入的原始值（引擎键名） */
  checkin?: Record<string, unknown>;
  verdict?: Verdict;
  tiers?: { tier: string; totalSets: number }[];
  /** 练练写入结果，用于在记录里留一行「已写入」 */
  saved?: { saved?: number; dayStr?: string; skipped?: string[] };
  chosenTier?: string;
}

export interface WriteResult {
  ok: boolean;
  path?: string;
  reason?: string;
  published?: boolean;
  /** 当天记录原本不存在、这次是新建成的最小骨架 */
  created?: boolean;
}

/** 知识库根：KB_DIRS 第一项优先（与 plan-session 同一条规则）。 */
function kbRoot(): string {
  const dirs = process.env.KB_DIRS || "";
  if (dirs) return dirs.split(",")[0].trim();
  const kbDir = process.env.KB_DIR || "";
  return kbDir ? path.dirname(kbDir) : "";
}

function recordPath(date: string): string {
  return path.join(kbRoot(), "01 每日记录", `${date}-健康记录.md`);
}

function num(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtVal(v: string | number | null): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  return `"${String(v).replace(/"/g, '\\"')}"`;
}

/** 拆 frontmatter：返回 head（不含两条 ---）与 body。格式不对返回 null。 */
function splitDoc(text: string): { head: string[]; body: string } | null {
  const lines = text.split("\n");
  if ((lines[0] || "").trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  return { head: lines.slice(1, end), body: lines.slice(end + 1).join("\n") };
}

/**
 * 只改给定字段：存在就原地替换（保持原有顺序），不存在就追加到末尾。
 * 不重排、不删字段——记录里还有大量别的字段（睡眠分期、HRV…）不能动。
 */
function setFields(head: string[], updates: Record<string, string | number | null>): string[] {
  const out = head.slice();
  for (const [k, v] of Object.entries(updates)) {
    const idx = out.findIndex((l) => l.startsWith(`${k}:`));
    const line = `${k}: ${fmtVal(v)}`;
    if (idx >= 0) out[idx] = line;
    else out.push(line);
  }
  return out;
}

const BLOCK_BEGIN = "<!-- 判档:begin -->";
const BLOCK_END = "<!-- 判档:end -->";
const DIET_BEGIN = "<!-- 饮食计划:begin -->";

function clockText(): string {
  return new Date().toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function isoNow(): string {
  // 与记录里其他时间戳同口径：本地东八区，带 +08:00
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+08:00`;
}

const DIM_LABEL: Record<string, string> = {
  静息心率: "静息心率",
  心率: "静息心率",
  睡眠: "睡眠",
  深睡: "睡眠",
  主观疲劳: "疲劳",
  疲劳: "疲劳",
  肌肉酸痛: "酸痛",
  酸痛: "酸痛",
};

const LEVEL_CN: Record<string, string> = {
  red: "红",
  yellow: "黄",
  green: "绿",
  ok: "绿",
};

function buildBlock(o: WriteCheckinOpts): string {
  const ck = o.checkin || {};
  const inputs: string[] = [];
  const sleep = num(ck.sleep_hours);
  const deep = num(ck.deep_sleep_min);
  const awake = num(ck.sleep_awake_min);
  const hr = num(ck.resting_hr);
  const fatigue = num(ck.fatigue);
  const soreness = num(ck.soreness);
  const weight = num(ck.weight_kg);
  const fat = num(ck.body_fat_pct);

  if (sleep !== null) inputs.push(`睡眠 ${sleep}h`);
  if (deep !== null) inputs.push(`深睡 ${Math.round(deep)}min`);
  if (awake !== null && awake >= 0) {
    inputs.push(`清醒 ${Math.round(awake)}min`);
    if (sleep !== null && sleep > 0) {
      const eff = Math.round((sleep * 60 / (sleep * 60 + awake)) * 1000) / 10;
      inputs.push(`睡眠效率 ${eff}%`);
    }
  }
  if (hr !== null) inputs.push(`静息心率 ${hr}`);
  if (fatigue !== null) inputs.push(`疲劳 ${fatigue}`);
  if (soreness !== null) inputs.push(`酸痛 ${soreness}`);
  if (ck.soreness_part) inputs.push(`酸痛部位 ${String(ck.soreness_part)}`);
  if (weight !== null) inputs.push(`体重 ${weight}kg`);
  if (fat !== null) inputs.push(`体脂 ${fat}%`);

  const v = o.verdict || {};
  const judge = String(v.judge || o.chosenTier || "—");
  const counts =
    v.red !== undefined || v.yellow !== undefined
      ? `${v.status ? v.status + " · " : ""}红 ${v.red ?? "-"} / 黄 ${v.yellow ?? "-"}${
          v.dimensions ? `（${v.dimensions} 维）` : ""
        }`
      : v.status || "";

  const dims = (v.dims || [])
    .map(
      (d) =>
        `${DIM_LABEL[d.name] || d.name} ${LEVEL_CN[d.level || ""] || d.level || "—"}${
          d.detail ? `（${d.detail}）` : ""
        }`
    )
    .join(" ｜ ");

  const tiers = (o.tiers || []).map((t) => `${t.tier} ${t.totalSets} 组`).join(" / ");
  const savedLine = o.saved
    ? `- 已写入练练：${o.saved.dayStr || o.date.replace(/-/g, "")} ${o.chosenTier || judge}（${o.saved.saved || 0} 个动作${
        (o.saved.skipped || []).length ? `，跳过 ${(o.saved.skipped || []).length} 个` : ""
      }）`
    : "";

  const lines = [
    BLOCK_BEGIN,
    `## 判档记录（小程序 · ${clockText()}）`,
    "",
    counts ? `**判档：${judge}**（${counts}）` : `**判档：${judge}**`,
    "",
    inputs.length ? `- 输入：${inputs.join(" / ")}` : "- 输入：—",
  ];
  if (dims) lines.push(`- 维度：${dims}`);
  if (tiers) lines.push(`- 三档：${tiers}`);
  if (savedLine) lines.push(savedLine);
  lines.push("- 来源：小程序录入（手动），确认后自动写入");
  lines.push(BLOCK_END);
  return lines.join("\n");
}

/** 有标记就整段换；没有就插在饮食计划块前面（没有饮食块就追加到末尾）。 */
function upsertBlock(body: string, block: string): string {
  const b = body.indexOf(BLOCK_BEGIN);
  const e = body.indexOf(BLOCK_END);
  if (b >= 0 && e > b) {
    return body.slice(0, b) + block + body.slice(e + BLOCK_END.length);
  }
  const diet = body.indexOf(DIET_BEGIN);
  if (diet >= 0) return body.slice(0, diet) + block + "\n\n" + body.slice(diet);
  return body.replace(/\s*$/, "") + "\n\n" + block + "\n";
}

/**
 * 当天还没有健康记录时的最小骨架（2026-11-18 改）。
 *
 * 原先的策略是「不存在就报错，别造空记录」。实际用起来早上一开机就没法录入——
 * 那天的记录往往要等别的流程才建，而判档是第一件事。
 * 现在改成**建一份最小可用记录**：只写 frontmatter 必需项 + 判档块，
 * 其余字段留空，后续任何脚本都能正常读（缺字段=空值），不会污染周复盘。
 */
function newRecord(date: string): string {
  return [
    "---",
    `title: "${date}-健康记录"`,
    'type: "health-daily"',
    `date: "${date}"`,
    'source: "小程序录入"',
    'tags: ["域/健康", "类型/健康数据记录表"]',
    'status: "inbox"',
    "---",
    "",
    "",
  ].join("\n");
}

/**
 * 写回当天健康记录。返回 ok=false 时**不要**假装成功——调用方要把原因回给页面。
 */
export async function writeCheckinRecord(o: WriteCheckinOpts): Promise<WriteResult> {
  const root = kbRoot();
  if (!root) return { ok: false, reason: "没配知识库路径（KB_DIRS / KB_DIR）" };
  const file = recordPath(o.date);
  let text: string;
  let created = false;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      return { ok: false, path: file, reason: e instanceof Error ? e.message : "读取失败" };
    }
    // 目录在不在：连目录都没有说明 KB_DIRS 配错了，别硬造
    try {
      await fs.access(path.dirname(file));
    } catch {
      return { ok: false, path: file, reason: `每日记录目录不存在：${path.dirname(file)}` };
    }
    text = newRecord(o.date);
    created = true;
  }

  const doc = splitDoc(text);
  if (!doc) return { ok: false, path: file, reason: "健康记录的 frontmatter 格式不对，没敢改" };

  const ck = o.checkin || {};
  const sleep = num(ck.sleep_hours);
  const deep = num(ck.deep_sleep_min);
  const awake = num(ck.sleep_awake_min);
  const v = o.verdict || {};

  const upd: Record<string, string | number | null> = {};
  if (sleep !== null) upd.sleep_hours = sleep;
  // 记录里存的是百分比；有分钟没有小时就没法换算，宁可不写
  if (sleep !== null && sleep > 0 && deep !== null) {
    upd.deep_sleep_pct = Math.round((deep / (sleep * 60)) * 1000) / 10;
  }
  // 睡眠效率 = 睡眠 ÷（睡眠 + 清醒）×100%，与苹果手表历史口径一致（155 天记录验证）。
  // 清醒时长来自录入页，不参与判档，只算这个展示字段。
  if (sleep !== null && sleep > 0 && awake !== null && awake >= 0) {
    const totalMin = sleep * 60 + awake;
    upd.sleep_efficiency_pct = Math.round((sleep * 60 / totalMin) * 1000) / 10;
    upd.sleep_awake_min = Math.round(awake * 10) / 10;
  }
  const hr = num(ck.resting_hr);
  if (hr !== null) upd.resting_hr = hr;
  const fatigue = num(ck.fatigue);
  if (fatigue !== null) upd.subjective_fatigue = Math.round(fatigue);
  const soreness = num(ck.soreness);
  if (soreness !== null) upd.muscle_soreness = Math.round(soreness);
  const weight = num(ck.weight_kg);
  if (weight !== null) upd.fasting_weight_kg = weight;
  const fat = num(ck.body_fat_pct);
  if (fat !== null) upd.body_fat_pct = fat;

  upd.checkin_at = isoNow();
  upd.checkin_source = "mini-program";
  upd.checkin_tier = String(v.judge || o.chosenTier || "");
  if (v.red !== undefined) upd.checkin_red = Number(v.red);
  if (v.yellow !== undefined) upd.checkin_yellow = Number(v.yellow);
  upd.checkin_confirmed = "true";

  const head = setFields(doc.head, upd);
  const body = upsertBlock(doc.body, buildBlock(o));
  const next = `---\n${head.join("\n")}\n---\n${body.startsWith("\n") ? "" : "\n"}${body.replace(/^\n+/, "\n")}`;

  if (next === text) return { ok: true, path: file, created };

  try {
    await fs.writeFile(file, next, "utf8");
  } catch (e) {
    return { ok: false, path: file, reason: e instanceof Error ? e.message : "写入失败" };
  }
  return { ok: true, path: file, created };
}

/** 判档块「输入：」行里补上清醒时长/睡眠效率；没有块就留一条补录说明。 */
function patchAwakeInInputs(body: string, awake: number, eff: number): string {
  if (!/^- 输入：/m.test(body)) {
    return body + `\n- 补录清醒时长：${awake}min → 睡眠效率 ${eff}%\n`;
  }
  return body.replace(/^- 输入：.*$/m, (line) => {
    const rest = line
      .replace(/清醒 [\d.]+min \/ /g, "")
      .replace(/睡眠效率 [\d.]+% \/ /g, "");
    const add = `清醒 ${awake}min / 睡眠效率 ${eff}% / `;
    const i = rest.indexOf("静息心率");
    return i >= 0 ? rest.slice(0, i) + add + rest.slice(i) : `${rest} / ${add.replace(/ \/ $/, "")}`;
  });
}

/**
 * 只补清醒时长 → 睡眠效率（2026-11-19，首页独立入口）。
 *
 * 不改判档结论、不重写判档块的其他内容，也不创建新记录：睡眠小时数从当天
 * frontmatter 读，缺了就明确报错，绝不替用户猜。写入后由调用方触发推云。
 */
export async function updateAwakeOnly(
  date: string,
  awakeMin: number
): Promise<WriteResult & { efficiencyPct?: number; sleepHours?: number }> {
  const root = kbRoot();
  if (!root) return { ok: false, reason: "没配知识库路径（KB_DIRS / KB_DIR）" };
  if (!Number.isFinite(awakeMin) || awakeMin < 0 || awakeMin > 600) {
    return { ok: false, reason: "清醒时长要在 0–600 分钟之间" };
  }
  const file = recordPath(date);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return { ok: false, path: file, reason: "当天健康记录不存在，先去判档页录一次" };
  }
  const doc = splitDoc(text);
  if (!doc) return { ok: false, path: file, reason: "健康记录的 frontmatter 格式不对，没敢改" };
  const sh = doc.head.find((l) => l.startsWith("sleep_hours:"));
  const sleep = sh ? num(sh.slice(sh.indexOf(":") + 1)) : null;
  if (sleep === null || sleep <= 0) {
    return { ok: false, path: file, reason: "当天没记录睡眠时长，先在判档页录一次" };
  }

  const awake = Math.round(awakeMin * 10) / 10;
  const eff = Math.round((sleep * 60 / (sleep * 60 + awake)) * 1000) / 10;
  const head = setFields(doc.head, {
    sleep_awake_min: awake,
    sleep_efficiency_pct: eff,
  });
  const body = patchAwakeInInputs(doc.body, awake, eff);
  const next = `---\n${head.join("\n")}\n---\n${body.startsWith("\n") ? "" : "\n"}${body.replace(/^\n+/, "\n")}`;
  if (next !== text) {
    try {
      await fs.writeFile(file, next, "utf8");
    } catch (e) {
      return { ok: false, path: file, reason: e instanceof Error ? e.message : "写入失败" };
    }
  }
  return { ok: true, path: file, efficiencyPct: eff, sleepHours: sleep };
}

/**
 * 追加/更新「已写入练练」那一行（2026-11-17）。
 *
 * 为什么单独一个函数：写入练练是**第二个确认**，发生在「确认录入」之后。
 * 那时判档块已经在文件里了，这里只补一行执行结果；没有块就什么也不做
 * （老入口从历史页直接写练练，没走过录入，不该因此造一个块出来）。
 */
export async function updateSavedLine(
  date: string,
  o: { tier: string; saved: number; dayStr?: string; skipped?: string[] }
): Promise<{ ok: boolean; reason?: string }> {
  const root = kbRoot();
  if (!root) return { ok: false, reason: "没配知识库路径" };
  const file = recordPath(date);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return { ok: false, reason: "当天记录不存在" };
  }
  const b = text.indexOf(BLOCK_BEGIN);
  const e = text.indexOf(BLOCK_END);
  if (b < 0 || e < b) return { ok: false, reason: "没有判档块（本次不是从录入页来的）" };

  const line = `- 已写入练练：${o.dayStr || date.replace(/-/g, "")} ${o.tier}（${o.saved} 个动作${
    (o.skipped || []).length ? `，跳过 ${(o.skipped || []).length} 个` : ""
  }）`;
  const inner = text.slice(b, e);
  const rest = inner.replace(/^- 已写入练练：.*$/m, "").replace(/\n{2,}$/, "\n");
  const next = text.slice(0, b) + rest + line + "\n" + text.slice(e);
  if (next === text) return { ok: true };
  try {
    await fs.writeFile(file, next, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "写入失败" };
  }
}

/**
 * 后台跑 publish_cloud.py：重建 weekly/plan 并推云存储。
 *
 * 不能 await：它要 20–40 秒，而 save-plan 的时限是 60 秒，等它会把「写入成功」
 * 这个已经发生的事实拖成超时。detached + unref，输出落临时日志方便事后查。
 */
export function triggerPublish(): { started: boolean; log?: string; reason?: string } {
  const dir = process.env.FIT_PERSONAL_SYSTEM || path.join(process.env.HOME || "", "Projects", "personal-system");
  const script = path.join(dir, "data", "publish_cloud.py");
  try {
    fsSync.accessSync(script);
  } catch {
    return { started: false, reason: `没找到 ${script}` };
  }
  const logPath = path.join(tmpdir(), "fit-agent-publish.log");
  try {
    const fd = fsSync.openSync(logPath, "a");
    const child = spawn("python3", [script], { cwd: dir, detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    return { started: true, log: logPath };
  } catch (e) {
    return { started: false, reason: e instanceof Error ? e.message : "启动失败" };
  }
}
