/**
 * 训练记录目录的**唯一出处**。
 *
 * 为什么不把路径写死：这个仓库要公开，路径里带着邮箱和真实姓名，不能进版本库。
 * 也不该写进代码注释里。
 *
 * 用法：仓库根目录建 `.env.local`（已在 .gitignore 里），写一行
 *   KB_DIR=/你的/训练记录/目录
 * 格式参考 `.env.example`。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Node 22 自带 loadEnvFile，不引第三方依赖
const loadEnvFile = (
  process as unknown as { loadEnvFile?: (p: string) => void }
).loadEnvFile;
const ENV_FILE = resolve(process.cwd(), ".env.local");
if (loadEnvFile && existsSync(ENV_FILE)) {
  try {
    loadEnvFile(ENV_FILE);
  } catch {
    // 读不到就退回 process.env，由下面的检查报错
  }
}

export function kbDir(): string {
  const dir = process.env.KB_DIR;
  if (!dir) {
    console.error(
      [
        "缺少环境变量 KB_DIR。",
        "",
        "在仓库根目录创建 .env.local，写一行：",
        "  KB_DIR=/你的/训练记录目录",
        "",
        "（.env.local 已在 .gitignore 里，不会被提交）",
      ].join("\n")
    );
    process.exit(1);
  }
  if (!existsSync(dir)) {
    console.error(`KB_DIR 指向的目录不存在：${dir}`);
    process.exit(1);
  }
  return dir;
}
