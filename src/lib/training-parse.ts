/**
 * 训练记录 → 结构化 JSON 的**唯一出处**（W3 第三步）。
 *
 * 为什么不用模型干这件事：这一步是纯格式问题，正则比 7B 模型准且快 300 倍。
 * 语言模型留给它真正擅长的部分（W2 那种「自然语言 → 结构」）；已经从练练批量
 * 导入的、格式稳定的 md，用正则是唯一正确选择——模型反而会在这里编数据
 * （W2 那条 19/20 的失败样本就是模型自造 schema）。
 *
 * 一个刻意保守的地方：**解析不出来就返回 null 或者把字段留 null，绝不猜**。
 * 语料里有 29 条 `- 组1：自重 × ，休息 60s`（次数位置是空的），那不是 0 次，
 * 是没记录。把它当 0 会让「掉力点」算出假信号，W2 已经踩过一次。
 */
import type { Doc } from "./corpus";
import { isStrengthDoc, section } from "./corpus";

export interface SetRecord {
  index: number;
  /** 负重（kg）；自重动作无此项 */
  weightKg: number | null;
  bodyweight: boolean;
  /** 次数；`自重 × `（空）时为 null，**不是 0** */
  reps: number | null;
  restS: number | null;
  warmup: boolean;
}

export interface ExerciseRecord {
  /** 动作名，去掉（kg）与「— 容量 N」后缀 */
  name: string;
  /** 标题括号里的单位，一般是 kg */
  unit: string | null;
  /** 标题里写明的容量（练练 App 算的） */
  volume: number | null;
  /** 自己按 weight×reps 算的容量，用于与 volume 交叉校验。保留 1 位小数——
   *  练练 App 的容量带 .5（如 687.5），四舍五入会凭空造出 55 处「不一致」。 */
  computedVolume: number;
  sets: SetRecord[];
  /** 首组（排除热身）比末组多掉 ≥20% 时给出，否则 null */
  dropOff: { firstSetReps: number; lastSetReps: number; pct: number } | null;
}

export interface TrainingRecord {
  date: string | null;
  session: string | null;
  durationMin: number | null;
  calorie: number | null;
  capacity: number | null;
  muscleGroups: string[];
  muscleFocus: string[];
  exercises: ExerciseRecord[];
}

const SET_LINE = /^-\s*组\s*(\d+)\s*[：:]\s*(.*)$/;
const DROP_OFF_PCT = 20;

function num(v: string | string[] | number | boolean | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

function list(v: string | string[] | number | boolean | undefined): string[] {
  return Array.isArray(v) ? v : [];
}

/** 解析一行组记录。容忍：无休息、无次数、热身标记、全角/半角冒号。 */
export function parseSetLine(line: string): SetRecord | null {
  const m = line.trim().match(SET_LINE);
  if (!m) return null;
  const index = Number(m[1]);
  const payload = m[2];

  const warmup = /（热身）|\(热身\)/.test(payload);
  const bodyweight = /自重/.test(payload);

  let weightKg: number | null = null;
  if (!bodyweight) {
    const w = payload.match(/(\d+(?:\.\d+)?)\s*(?:kg|KG|Kg|公斤)/);
    if (w) weightKg = Number(w[1]);
  }

  const repsMatch = payload.match(/[×xX✕]\s*(\d+)/);
  const reps = repsMatch ? Number(repsMatch[1]) : null;

  const restMatch = payload.match(/休息\s*(\d+)\s*s/);
  const restS = restMatch ? Number(restMatch[1]) : null;

  // 既没重量也没自重也没次数 → 不是一条能用的组记录
  if (!bodyweight && weightKg === null && reps === null) return null;

  return { index, weightKg, bodyweight, reps, restS, warmup };
}

/** 从 `### 史密斯深蹲（kg）— 容量 2060` 里拆出 名称 / 单位 / 容量。 */
export function parseExerciseTitle(title: string): {
  name: string;
  unit: string | null;
  volume: number | null;
} {
  let rest = title.trim();
  let volume: number | null = null;
  const v = rest.match(/[—–-]\s*容量\s*([\d.]+)\s*$/);
  if (v && v.index !== undefined) {
    volume = Number(v[1]);
    rest = rest.slice(0, v.index).trim();
  }
  let unit: string | null = null;
  const u = rest.match(/（([^）]*)）\s*$/);
  if (u && u.index !== undefined) {
    unit = u[1].trim();
    rest = rest.slice(0, u.index).trim();
  }
  return { name: rest, unit, volume };
}

function dropOffOf(sets: SetRecord[]): ExerciseRecord["dropOff"] {
  const working = sets.filter((s) => !s.warmup && s.reps !== null && s.reps > 0);
  if (working.length < 2) return null;
  const first = working[0].reps as number;
  const last = working[working.length - 1].reps as number;
  if (first <= 0) return null;
  const pct = Math.round(((first - last) / first) * 1000) / 10;
  return pct >= DROP_OFF_PCT ? { firstSetReps: first, lastSetReps: last, pct } : null;
}

/** 解析一篇训练记录；不是力量记录（没有动作明细）返回 null。 */
export function parseTraining(doc: Doc): TrainingRecord | null {
  if (!isStrengthDoc(doc)) return null;
  const body = section(doc, "动作明细");
  if (body === null) return null;

  const exercises: ExerciseRecord[] = [];
  let current: { title: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const { name, unit, volume } = parseExerciseTitle(current.title);
    const sets = current.lines
      .map(parseSetLine)
      .filter((s): s is SetRecord => s !== null)
      .sort((a, b) => a.index - b.index);
    if (!name) return;
    const computedVolume =
      Math.round(sets.reduce((acc, s) => acc + (s.weightKg ?? 0) * (s.reps ?? 0), 0) * 10) / 10;
    exercises.push({ name, unit, volume, computedVolume, sets, dropOff: dropOffOf(sets) });
    current = null;
  };

  for (const line of body.split("\n")) {
    if (/^###\s/.test(line)) {
      flush();
      current = { title: line.replace(/^###\s+/, "").trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();

  return {
    date: doc.date,
    session: typeof doc.fm.session === "string" ? doc.fm.session : null,
    durationMin: num(doc.fm.duration_min),
    calorie: num(doc.fm.calorie),
    capacity: num(doc.fm.capacity),
    muscleGroups: list(doc.fm.muscle_groups),
    muscleFocus: list(doc.fm.muscle_focus),
    exercises,
  };
}
