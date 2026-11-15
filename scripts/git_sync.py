#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键收工：pull --rebase → 提交 → push（fitness-agent 版）。

为什么需要它
------------
2026-11-15 之前这个仓没有任何「什么时候该推」的契约，结果 3 个提交（结构化输出
20/20、样本口径收敛、报告页对齐）在本机挂了 16 小时，GitHub 上还是旧版。这个仓
是单机 + 只此一份，**没推就等于没备份**，代价比双端协作的仓更大。

用法
----
    python3 scripts/git_sync.py --check       # 只看状态，不动任何东西（开工前跑）
    python3 scripts/git_sync.py               # 收工：pull --rebase → 提交 → push
    python3 scripts/git_sync.py -m "改报告页"  # 自己写提交信息
    python3 scripts/git_sync.py --no-pull     # 网络不通但想先本地提交
    python3 scripts/git_sync.py --dry-run     # 只说会做什么

规则出处：仓根 AGENTS.md「git 协作契约」+ 知识库 `00 库规与导航/规则主表.md` P22
"""
import argparse
import datetime
import os
import socket
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 一旦出现在暂存区就必须中止（.gitignore 已挡，这里防 git add -f 或规则被改坏）
FORBIDDEN = (".env", ".env.local", ".env.production", ".env.development")

# 这些目录/后缀整个属于「私人材料」，公开仓一个都不该有
PRIVATE_PREFIX = (".notes/", "private/")
PRIVATE_SUFFIX = (".local.json", ".private.md", ".private.json")

# 提交前对正文做一次扫描：这个仓是**公开的作品库**，真实姓名/邮箱/本机路径/
# 密钥都不该出现在代码和文档里。命中就拦下，不让 commit 过去。
# 只放「硬指标」，不做模糊的语义判断（模糊判断会天天误报，最后被忽略）。
#
# 元组第三项 = 限定只查这些后缀；None = 所有文本都查。
# 「账本 / 健康数据」那几条只查 json/csv：因为文档里正常写「体重」「支付宝」
# 是合法讨论，而真正的数据导出几乎必然是 json 或 csv。
PRIVATE_PATTERNS = (
    (r"汪超", "真实姓名", None),
    (r"wangchao", "账号名/邮箱前缀", None),
    (r"坚果云", "私人知识库来源", None),
    (r"CloudStorage", "本机云盘路径", None),
    (r"/Users/[A-Za-z]", "本机绝对路径（含用户名）", None),
    (r"@163\.com|@qq\.com", "私人邮箱", None),
    (r"1[3-9]\d{9}(?!\d)", "手机号", None),
    (r"sk-[A-Za-z0-9_-]{20,}", "疑似 API key", None),
    (r"gh[pousr]_[A-Za-z0-9]{20,}", "GitHub token", None),
    # ↓ 从私有仓（personal-system）拷数据文件过来时，上面那些都扫不出来，靠这几条
    (r'"ledger"\s*:', "账本数据（ledger）", (".json",)),
    (r'"(account|merchant|amount)"\s*:\s*"', "账本字段（account/merchant/amount）", (".json",)),
    (r"垫付|人一|人二", "垫付人/私人账本用语", (".json", ".csv")),
    (r'"(fasting_weight|body_fat|sleep_hours|resting_hr|deep_sleep|hrv|vo2max)"',
     "真实身体数据字段", (".json", ".csv")),
    (r"^\s*date,.*(weight|fat|sleep)", "健康/体重导出表头", (".csv",)),
)


# 生成物：commit 里出现它们通常意味着有人在改 build 输出，提示一句
GENERATED = ("next-env.d.ts", "tsconfig.tsbuildinfo")

TEXT_EXT = (".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".html", ".css", ".yml",
            ".yaml", ".txt", ".sh", ".py", ".csv", ".example")

# 本文件自己就写着上面那些正则，扫它会全部命中，跳过自身（不是因为允许藏数据）
SCAN_SKIP = ("scripts/git_sync.py",)


# 本机常见代理端口：Clash 7890/7897、Surge 6152、V2Ray 1087/1080、其他 8889
LOCAL_PROXY_PORTS = (7890, 7897, 1087, 8889, 1080, 6152)
_PROXY_CACHE = []          # 单元素缓存，None 也缓存（避免重复扫端口）


def git(*args, check=False):
    p = subprocess.run(["git", *_proxy_args(), *args], cwd=ROOT, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if check and p.returncode != 0:
        raise SystemExit("✗ git %s 失败：\n%s" %
                         (" ".join(args), (p.stderr or p.stdout or "").strip()))
    return p


def _port_open(host, port, timeout=0.35):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def proxy_target():
    """返回 (host, port, 来源) 或 None。

    来源两种：`配置` = git 里写了 http.https://github.com.proxy；
    `自动发现` = 没写，但本机常见端口上有人在监听。

    为什么要自动发现：原先「没配代理」被当成「直连没问题」，于是 pull 失败只抛
    `Empty reply from server` —— 实际是直连被墙、代理开着但没配进 git，报错完全
    没法行动。探测到就用 `-c http.proxy=…` 临时带上，不改任何全局配置。
    """
    if _PROXY_CACHE:
        return _PROXY_CACHE[0]
    found = None
    p = subprocess.run(["git", "config", "--get", "http.https://github.com.proxy"],
                       cwd=ROOT, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    url = (p.stdout or "").strip()
    if url:
        hostport = url.split("//", 1)[-1].rstrip("/")
        if hostport:
            if ":" in hostport:
                host, port = hostport.rsplit(":", 1)
                try:
                    found = (host or "127.0.0.1", int(port), "配置")
                except ValueError:
                    found = None
            else:
                found = (hostport, 80, "配置")
    if not found:
        for port in LOCAL_PROXY_PORTS:
            if _port_open("127.0.0.1", port):
                found = ("127.0.0.1", port, "自动发现")
                break
    _PROXY_CACHE.append(found)
    return found


def _proxy_args():
    """只有「自动发现」的代理需要临时注入；写进 git 配置的它自己会读。"""
    t = proxy_target()
    if not t or t[2] != "自动发现":
        return []
    url = "http://%s:%d" % (t[0], t[1])
    return ["-c", "http.proxy=" + url, "-c", "https.proxy=" + url]


def proxy_alive():
    """(True/False/None, 说明)。None = 连本地都没找到代理。"""
    t = proxy_target()
    if not t:
        return None, "没找到代理（直连不通时：开代理，或配 http.https://github.com.proxy）"
    host, port, src = t
    if _port_open(host, port):
        return True, "%s:%d 在监听（%s）" % (host, port, src)
    return False, "%s:%d 连不上（%s，代理没开？）" % (host, port, src)


def in_progress():
    gitdir = (git("rev-parse", "--git-dir").stdout or ".git").strip()
    base = gitdir if os.path.isabs(gitdir) else os.path.join(ROOT, gitdir)
    for name, label in (("rebase-merge", "rebase"), ("rebase-apply", "rebase"),
                        ("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick")):
        if os.path.exists(os.path.join(base, name)):
            return label
    return None


def changed_files():
    p = git("status", "--porcelain")
    out = []
    for line in (p.stdout or "").splitlines():
        if not line.strip():
            continue
        path = line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        out.append(path.strip('"'))
    return out


def staged_files():
    p = git("diff", "--cached", "--name-only")
    return [l for l in (p.stdout or "").splitlines() if l.strip()]


def ahead_behind():
    p = git("rev-list", "--left-right", "--count", "HEAD...@{u}")
    parts = (p.stdout or "").split()
    if len(parts) != 2:
        return None, None
    return int(parts[0]), int(parts[1])


def auto_message(files):
    ts = datetime.datetime.now().strftime("%m-%d %H:%M")
    names = [os.path.basename(f) for f in files[:3]]
    tail = "（%s%s）" % ("、".join(names), " 等" if len(files) > 3 else "")
    return "同步 %s · %d 个文件%s" % (ts, len(files), tail)


def sensitive(paths):
    bad = []
    for f in paths:
        if f in FORBIDDEN:
            bad.append(f)
        elif f.endswith(".pem"):
            bad.append(f)
        elif f.startswith(PRIVATE_PREFIX) or f.endswith(PRIVATE_SUFFIX):
            bad.append(f)
        elif os.path.basename(f).startswith(".env") and not f.endswith(".env.example"):
            bad.append(f)
    return bad


def leaks(paths):
    """扫正文里的私人信息。返回 [(文件:行, 命中的标签, 片段)]。"""
    import re
    hits = []
    for f in paths:
        if not f.endswith(TEXT_EXT) or f in SCAN_SKIP:
            continue
        full = os.path.join(ROOT, f)
        try:
            with open(full, encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh, 1):
                    for pat, label, exts in PRIVATE_PATTERNS:
                        if exts and not f.endswith(exts):
                            continue
                        if re.search(pat, line):
                            hits.append(("%s:%d" % (f, i), label, line.strip()[:90]))
                            break
        except OSError:
            continue
    return hits


def report():
    branch = (git("branch", "--show-current").stdout or "").strip() or "(detached)"
    ahead, behind = ahead_behind()
    files = changed_files()
    ok, note = proxy_alive()
    busy = in_progress()

    print("仓     : %s" % ROOT)
    print("分支   : %s" % branch)
    if ahead is None:
        print("远程   : ⚠ 当前分支没有上游，push 会失败（git push -u origin %s）" % branch)
    else:
        flag = "✓ 已同步" if ahead == 0 and behind == 0 else "⚠ 未同步"
        print("远程   : %s  ↑%d 待推  ↓%d 待拉" % (flag, ahead, behind))
    print("代理   : %s %s" % ("✓" if ok else ("✗" if ok is False else "·"), note))
    if busy:
        print("状态   : ✗ 有 %s 未完成，先手工收尾再跑本脚本" % busy)
    print("改动   : %d 个文件" % len(files))
    for f in files[:12]:
        mark = "  ⛔ 生成物" if os.path.basename(f) in GENERATED else ""
        print("         %s%s" % (f, mark))
    if len(files) > 12:
        print("         …… 另有 %d 个" % (len(files) - 12))
    bad = sensitive(files)
    if bad:
        print("⛔ 发现密钥/私人文件（不该进公开仓）：%s" % "、".join(bad))
    hit = leaks(files)
    if hit:
        print("⛔ 正文里发现私人信息（%d 处），公开仓不许带：" % len(hit))
        for where, label, snippet in hit[:5]:
            print("         %s  [%s]  %s" % (where, label, snippet))
        if len(hit) > 5:
            print("         …… 另有 %d 处" % (len(hit) - 5))
    return {"ahead": ahead, "behind": behind, "files": files, "proxy_ok": ok,
            "busy": busy, "leak": hit}


def main():
    ap = argparse.ArgumentParser(description="一键收工（pull → commit → push）")
    ap.add_argument("-m", "--message", help="提交信息；不给则按变更文件自动生成")
    ap.add_argument("--check", action="store_true", help="只报告状态，不执行任何操作")
    ap.add_argument("--no-pull", action="store_true", help="跳过 pull（网络不通时用）")
    ap.add_argument("--dry-run", action="store_true", help="只说明会做什么")
    args = ap.parse_args()

    st = report()
    if args.check:
        return 0

    if st["busy"]:
        print("\n✗ 有未完成的 %s，请先解决（git status 看冲突文件）" % st["busy"])
        return 2

    if st["proxy_ok"] is False and not args.no_pull:
        print("\n✗ GitHub 代理连不上，先开代理再跑。非要先本地提交：加 --no-pull")
        return 2

    todo = []
    if not args.no_pull:
        todo.append("pull --rebase")
    if st["files"]:
        todo.append("提交 %d 个文件" % len(st["files"]))
    if st["ahead"]:
        todo.append("push")
    if not todo:
        print("\n✓ 干净且已同步，无需操作")
        return 0
    print("\n将执行：%s" % " → ".join(todo))
    if args.dry_run:
        return 0

    # 1) pull
    if not args.no_pull:
        p = git("pull", "--rebase", "--autostash")
        if p.returncode != 0:
            print("✗ pull 失败：\n%s" % (p.stderr or p.stdout or "").strip())
            return 2
        print("✓ pull 完成")

    # 2) commit
    files = changed_files()
    if files:
        git("add", "-A", check=True)
        staged = staged_files()
        bad = sensitive(staged)
        if bad:
            git("reset", check=True)
            print("⛔ 暂存区里有密钥/私人文件，已回滚暂存：%s" % "、".join(bad))
            return 2
        hit = leaks(staged)
        if hit:
            git("reset", check=True)
            print("⛔ 已回滚暂存：这些内容不该进公开仓（%d 处）" % len(hit))
            for where, label, snippet in hit[:8]:
                print("   %s  [%s]  %s" % (where, label, snippet))
            print("   处理：把它挪到 private/ 或 .notes/（都已 .gitignore），"
                  "或改成占位符（如 KB_DIR=/你的/训练记录目录）")
            return 2
        msg = args.message or auto_message(staged)
        p = git("commit", "-m", msg)
        if p.returncode != 0:
            print("✗ commit 失败：\n%s" % (p.stderr or p.stdout).strip())
            return 2
        print("✓ 已提交：%s" % msg)
    else:
        print("· 没有待提交的改动")

    # 3) push
    ahead, _ = ahead_behind()
    if ahead:
        p = git("push", "origin", "HEAD")
        if p.returncode != 0:
            detail = (p.stderr or p.stdout or "").strip()
            print("✗ push 失败：\n%s" % detail)
            if "rejected" in detail.lower():
                print("\n远端有你没有的提交：先 git pull --rebase 再重跑本脚本")
            return 2
        print("✓ 已推送")
    else:
        print("· 无需推送")

    print("\n✓ 收工。下次开工先跑：python3 scripts/git_sync.py --check")
    return 0


if __name__ == "__main__":
    sys.exit(main())
