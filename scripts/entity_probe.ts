import { kbDir } from "./kb-dir";
import { entitiesIn } from "../src/lib/tools";

const CASES: Array<{ q: string; want: string[] }> = [
  { q: "深蹲和卧推哪个最近涨得更多", want: ["e:史密斯深蹲", "e:杠铃卧推"] },
  { q: "我上次腿课和上次胸课分别是什么时候", want: ["m:腿", "m:胸"] },
  { q: "这个月和上个月分别练了几次腿", want: ["m:腿"] },
  { q: "游泳和跑步哪个练得多", want: ["m:有氧"] },
  { q: "我的深蹲重量是多少", want: ["e:史密斯深蹲"] },
  { q: "热量和脂肪怎么分配", want: [] },
  { q: "为什么我练胸的时候脖子会酸", want: ["m:胸"] },
  { q: "腿举和史密斯深蹲哪个容量大", want: ["e:腿举(倒蹬)", "e:史密斯深蹲"] },
];

kbDir(); // 触发 .env.local 加载
let bad = 0;
for (const c of CASES) {
  const got = entitiesIn(c.q).map((e) => (e.kind === "exercise" ? `e:${e.name}` : `m:${e.name}`));
  const ok = JSON.stringify(got) === JSON.stringify(c.want);
  if (!ok) bad++;
  console.log(`${ok ? "✓" : "✗"} ${c.q}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(c.want)}`);
}
console.log(`\n${bad === 0 ? "✓ 全过" : "✗ 有偏差"}：${CASES.length - bad}/${CASES.length}`);
