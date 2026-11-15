/**
 * 索引缓存跨版本兼容自检：`npm run w8:cache`（不调模型）
 *
 * 复现的是 W15 那次真事故：dev 服务启动早于 W12，`globalThis.__kbIndex` 里
 * 躺着一个**没有 sections 字段**的旧对象。热更新后新代码执行
 * `idx.sections.get(...)` → `Cannot read properties of undefined`，网页整页报错，
 * 重启才愈。
 *
 * 这里的判据不是「重启后能跑」——那不用测。测的是：**旧缓存还在内存里时，
 * 第一个请求就得自己重建，不许崩**。
 *
 * 全部判据均为确定性：手工往 globalThis 注入各种坏缓存，看 getIndex /
 * retrieve 能不能自愈。
 */
import { kbDir } from "./kb-dir";
import {
  retrieve,
  getIndex,
  resetIndex,
  indexMeta,
  INDEX_SCHEMA,
  type Built,
} from "../src/lib/retrieve";

kbDir();

const cases: Array<{ name: string; ok: boolean; got: string; want: string }> = [];
const push = (name: string, ok: boolean, got: unknown, want: unknown) =>
  cases.push({ name, ok, got: String(got), want: String(want) });

const g = globalThis as unknown as { __kbIndex?: Built };
const Q = "练胸为什么脖子会酸";

/** 注入一个坏缓存；返回注入的那个对象本身，用来确认「拿回来的不是它」 */
function inject(mutate: (o: Record<string, unknown>) => void): Built {
  const fresh = getIndex();
  const bad: Record<string, unknown> = { ...fresh };
  mutate(bad);
  const obj = bad as unknown as Built;
  g.__kbIndex = obj;
  return obj;
}

/* ── ① 正常路径：新建的索引带版本、字段齐全 ── */
resetIndex();
const healthy = getIndex();
push("新索引带 schema 版本", healthy.schema === INDEX_SCHEMA, healthy.schema, INDEX_SCHEMA);
push("新索引 sections 是 Map", healthy.sections instanceof Map, typeof healthy.sections, "Map");
push("正常索引会被复用", getIndex() === healthy, getIndex() === healthy, true);
const meta = indexMeta();
push("indexMeta 仍可用", meta.chunks > 5000, meta.chunks, ">5000");

/* ── ② 事故现场：W12 之前的旧缓存（没有 scheme / sections） ── */
const oldLike = inject((o) => {
  delete o.schema;
  delete o.sections;
});
let threw = "";
let afterOld: Built | undefined;
try {
  afterOld = getIndex();
} catch (e) {
  threw = e instanceof Error ? e.message : String(e);
}
push("旧缓存不抛异常", threw === "", threw || "无异常", "无异常");
push("旧缓存触发重建", !!afterOld && afterOld !== oldLike, !!afterOld && afterOld !== oldLike, true);
push("重建后 sections 回来", !!afterOld && afterOld.sections instanceof Map, !!afterOld?.sections, true);
push("重建后 schema 是当前版", afterOld?.schema === INDEX_SCHEMA, afterOld?.schema, INDEX_SCHEMA);

/* ── ③ 检索层也不许崩：这才是对用户可见的那一层 ── */
inject((o) => {
  delete o.schema;
  delete o.sections;
});
let hits: ReturnType<typeof retrieve> = [];
threw = "";
try {
  hits = retrieve(Q, { k: 5 });
} catch (e) {
  threw = e instanceof Error ? e.message : String(e);
}
push("坏缓存下 retrieve 不抛", threw === "", threw || "无异常", "无异常");
push("坏缓存下仍有 top5", hits.length === 5, hits.length, 5);
push("坏缓存下答案仍带节位", hits.some((h) => h.section), hits.some((h) => h.section), true);

/* ── ④ 版本号对但字段烂：不能只信版本号 ── */
const lying = inject((o) => {
  o.schema = INDEX_SCHEMA;
  o.sections = undefined;
});
push("假版本+空字段被识破", getIndex() !== lying, getIndex() !== lying, true);

const emptyChunks = inject((o) => {
  o.chunks = [];
});
push("空块索引被识破", getIndex() !== emptyChunks, getIndex() !== emptyChunks, true);

/* ── ⑤ 语料目录变了必须重建：否则换 KB 还在拿旧索引答，比报错更隐蔽 ── */
const wrongDir = inject((o) => {
  o.dir = "/definitely/not/the/kb";
});
push("目录变更触发重建", getIndex() !== wrongDir, getIndex() !== wrongDir, true);
push("重建后 dir 正常", getIndex().dir.length > 0, getIndex().dir.length, ">0");

/* ── ⑥ 收尾：显式 reset 仍能重建（原有 API 不回归） ── */
resetIndex();
const rebuilt = getIndex();
push("resetIndex 后能重建", rebuilt.chunks.length > 5000, rebuilt.chunks.length, ">5000");

let bad = 0;
for (const c of cases) {
  if (!c.ok) bad++;
  console.log(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(26)} got=${c.got}  want=${c.want}`);
}
console.log(`\n${bad === 0 ? "✓ 全过" : "✗ 有偏差"}：${cases.length - bad}/${cases.length}`);
if (bad) process.exitCode = 1;
