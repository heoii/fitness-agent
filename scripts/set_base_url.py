#!/usr/bin/env python3
"""把新的公网隧道地址写回微信云数据库 fit_agent_config.baseUrl。

隧道每次重启域名都会变，手工去开发者工具改是整套流程里唯一必须人工的一步。
这个脚本把它自动化：拿到新 URL → 查集合 → 更新那一条记录的 baseUrl。

用法：
    python3 scripts/set_base_url.py https://xxx-yyy.trycloudflare.com
    python3 scripts/set_base_url.py --show          # 只打印当前值

凭据复用 personal-system 的 .env（WX_APPID / WX_SECRET / WX_ENV）与它的
access_token 缓存文件——**不自己另取一个 token**，否则会把对方缓存的 token
顶掉（微信 access_token 全局唯一，任一端重取，另一端约 5 分钟后失效）。

可用环境变量覆盖：
    FIT_ENV_FILE   凭据文件路径，默认 ~/Projects/personal-system/.env
    FIT_COLLECTION 集合名，默认 fit_agent_config
"""

import json
import os
import pathlib
import sys
import time
import urllib.parse
import urllib.request

HOME = pathlib.Path.home()
ENV_FILE = pathlib.Path(
    os.environ.get("FIT_ENV_FILE", HOME / "Projects" / "personal-system" / ".env")
)
TOKEN_CACHE = HOME / "Projects" / "personal-system" / "data" / ".wx_token.json"
COLLECTION = os.environ.get("FIT_COLLECTION", "fit_agent_config")
FIELD = "baseUrl"


def load_env():
    cfg = {}
    for k in ("WX_APPID", "WX_SECRET", "WX_ENV"):
        if os.environ.get(k):
            cfg[k] = os.environ[k]
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    miss = [k for k in ("WX_APPID", "WX_SECRET", "WX_ENV") if not cfg.get(k)]
    if miss:
        sys.exit("✗ %s 里缺：%s" % (ENV_FILE, "、".join(miss)))
    return cfg


def http_json(url, payload=None, timeout=15):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def get_token(appid, secret, force=False):
    if not force and TOKEN_CACHE.exists():
        try:
            c = json.loads(TOKEN_CACHE.read_text(encoding="utf-8"))
            if c.get("appid") == appid and c.get("expireAt", 0) > time.time() + 120:
                return c["token"]
        except Exception:
            pass
    q = urllib.parse.urlencode(
        {"grant_type": "client_credential", "appid": appid, "secret": secret}
    )
    r = http_json("https://api.weixin.qq.com/cgi-bin/token?" + q)
    if not r.get("access_token"):
        sys.exit("✗ 获取 access_token 失败：%s（检查 AppSecret / IP 白名单）" % r)
    TOKEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_CACHE.write_text(
        json.dumps(
            {
                "appid": appid,
                "token": r["access_token"],
                "expireAt": time.time() + int(r.get("expires_in", 7200)),
            }
        ),
        encoding="utf-8",
    )
    return r["access_token"]


def db_call(cfg, token, query):
    r = http_json(
        "https://api.weixin.qq.com/tcb/databasequery?access_token=" + token,
        {"env": cfg["WX_ENV"], "query": query},
    )
    return r


def db_update(cfg, token, query):
    return http_json(
        "https://api.weixin.qq.com/tcb/databaseupdate?access_token=" + token,
        {"env": cfg["WX_ENV"], "query": query},
    )


def fetch_record(cfg, token):
    r = db_call(cfg, token, 'db.collection("%s").limit(1).get()' % COLLECTION)
    if r.get("errcode") != 0:
        return r, None
    data = r.get("data") or []
    if not data:
        return r, None
    rec = data[0]
    return r, json.loads(rec) if isinstance(rec, str) else rec


def main():
    args = [a for a in sys.argv[1:] if a]
    if not args or args[0] in ("-h", "--help"):
        sys.exit(__doc__)

    cfg = load_env()
    token = get_token(cfg["WX_APPID"], cfg["WX_SECRET"])

    def with_retry(fn):
        """token 被别端顶掉时重取一次再试。"""
        r = fn(token)
        if r.get("errcode") in (40001, 40014, 42001):
            t2 = get_token(cfg["WX_APPID"], cfg["WX_SECRET"], force=True)
            r = fn(t2)
        return r

    def fetch(token_):
        code, record = fetch_record(cfg, token_)
        out = dict(code)
        out["_record"] = record
        return out

    r = with_retry(fetch)
    rec = r.get("_record")
    if r.get("errcode") != 0:
        sys.exit("✗ 查询集合失败：%s" % r)
    if not rec:
        sys.exit("✗ 集合 %s 里没有记录（先在开发者工具建一条）" % COLLECTION)

    if args[0] == "--show":
        print("当前 %s = %s" % (FIELD, rec.get(FIELD)))
        return

    url = args[0].rstrip("/")
    if not url.startswith("https://"):
        sys.exit("✗ baseUrl 必须 https:// 开头：%s" % url)
    for tail in ("/api/ask",):
        if url.endswith(tail):
            url = url[: -len(tail)]
    if url == rec.get(FIELD):
        print("= %s 未变化，跳过写入" % url)
        return

    q = 'db.collection("%s").doc("%s").update({data:{%s:"%s"}})' % (
        COLLECTION,
        rec["_id"],
        FIELD,
        url,
    )
    r2 = with_retry(lambda t: db_update(cfg, t, q))
    if r2.get("errcode") != 0:
        sys.exit("✗ 更新失败：%s" % r2)
    print("✓ %s 已更新" % FIELD)
    print("  旧：%s" % (rec.get(FIELD) or "(空)"))
    print("  新：%s" % url)


if __name__ == "__main__":
    main()
