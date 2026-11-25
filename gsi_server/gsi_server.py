#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Dota 2 GSI 接收服务器（零依赖，仅用 Python 标准库）

作用：
  Dota 2 客户端在 BP / 对局过程中，按 gamestate_integration_*.cfg 的配置，
  主动把游戏状态以 JSON POST 到本机 `POST /gsi`。本服务器接收后：
    1. 校验 auth.token（防止误连）
    2. 解析 draft（选禁）/ map（阶段）/ player+hero（自己的英雄）
    3. 因为 GSI 每次只推送"发生变化的段"，这里对状态做增量合并（patch）
    4. 对外提供 `GET /state`，供 dota2-draft 前端轮询展示阵容并分析

设计取舍：
  - 只输出英雄 id / name，不内置英雄数据库；前端用现成的 /api/heroes 数据做映射
  - GSI 原生不推送"分路(lane)"字段，分路在前端按英雄 roles 推断
  - 单文件、零第三方依赖，python3 gsi_server.py 即可运行

用法：
  python3 gsi_server.py                       # 默认 0.0.0.0:8765, token=dota2draft
  python3 gsi_server.py --port 9000 --token mytoken
  python3 gsi_server.py --no-auth             # 不校验 token（仅本地调试）

端点：
  POST /gsi     接收 GSI 数据（路径可用 --path 改，需与 cfg 的 uri 一致）
  GET  /state   返回当前解析状态（前端轮询，带 CORS）
  GET  /raw     返回最近一次原始 payload（调试）
  GET  /        自带极简监控页（验证 GSI 是否打通）
  POST /reset   清空当前状态
  GET  /health  健康检查
"""

import argparse
import json
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# 阶段映射：Valve 的 DOTA_GAMERULES_STATE_* -> 前端易读的阶段标识
# ---------------------------------------------------------------------------
PHASE_MAP = {
    "DOTA_GAMERULES_STATE_INIT": "init",
    "DOTA_GAMERULES_STATE_DISCONNECT": "disconnect",
    "DOTA_GAMERULES_STATE_TEAM_SHOWCASE": "showcase",
    "DOTA_GAMERULES_STATE_HERO_SELECTION": "picking",   # ← BP 选人阶段
    "DOTA_GAMERULES_STATE_STRATEGY_TIME": "strategy",
    "DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD": "loading",
    "DOTA_GAMERULES_STATE_PRE_GAME": "pregame",
    "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS": "playing",
    "DOTA_GAMERULES_STATE_POST_GAME": "postgame",
}

# team 编号兼容：GSI 用 team2=天辉/radiant, team3=夜魇/dire
TEAM_TO_SIDE = {
    "team2": "radiant", "2": "radiant", "radiant": "radiant", "good": "radiant",
    "team3": "dire", "3": "dire", "dire": "dire", "bad": "dire",
}


def to_int(value):
    """把 GSI 里的 id 安全转成 int；无效值返回 None。"""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        n = int(value)
    except (ValueError, TypeError):
        return None
    return n if n > 0 else None


def side_of(team_value):
    return TEAM_TO_SIDE.get(str(team_value).lower())


class DraftState:
    """
    线程安全的增量状态容器。
    GSI 每次 POST 只带变化的段，所以需要在内存里累积合并；
    检测到新的 matchid 时自动重置，避免上一局的英雄残留。
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.match_id = None
        self.phase = "menu"
        self.active_team = None
        self.radiant = {"picks": [], "bans": []}
        self.dire = {"picks": [], "bans": []}
        self.local_hero = None      # 玩家自己的英雄 {"id":..,"name":..}
        self.local_side = None
        self.last_update = 0.0
        self.payload_count = 0
        self.last_raw = None

    # ---- 内部：解析 draft 段，返回规范化结构 -------------------------------
    @staticmethod
    def _parse_draft(draft):
        radiant = {"picks": [], "bans": []}
        dire = {"picks": [], "bans": []}
        active_team = None

        if not isinstance(draft, dict):
            return radiant, dire, active_team

        active_team = side_of(draft.get("activeteam"))

        # 形态 A：draft.team2 / draft.team3 下 pick#_id / ban#_id（最常见）
        for team_key, side in (("team2", radiant), ("team3", dire)):
            block = draft.get(team_key)
            if not isinstance(block, dict):
                continue
            picks, bans = [], []
            for i in range(10):
                hid = to_int(block.get(f"pick{i}_id"))
                if hid is not None:
                    picks.append({"id": hid, "name": block.get(f"pick{i}_class") or ""})
                bid = to_int(block.get(f"ban{i}_id"))
                if bid is not None:
                    bans.append({"id": bid, "name": block.get(f"ban{i}_class") or ""})
            # 按 id 去重，保持顺序
            side["picks"] = DraftState._dedupe(picks)
            side["bans"] = DraftState._dedupe(bans)

        # 形态 B：picks_bans 数组（部分版本 / 观战推送）
        pnb = draft.get("picks_bans")
        if isinstance(pnb, list):
            for item in pnb:
                if not isinstance(item, dict):
                    continue
                side_key = side_of(item.get("team"))
                if side_key is None:
                    continue
                target = radiant if side_key == "radiant" else dire
                hid = to_int(item.get("hero_id"))
                if hid is None:
                    continue
                entry = {"id": hid, "name": item.get("name") or item.get("class") or ""}
                bucket = target["picks"] if item.get("is_pick") else target["bans"]
                if not any(x["id"] == hid for x in bucket):
                    bucket.append(entry)

        return radiant, dire, active_team

    @staticmethod
    def _dedupe(entries):
        seen, out = set(), []
        for e in entries:
            if e["id"] not in seen:
                seen.add(e["id"])
                out.append(e)
        return out

    # ---- 对外：合并一次 GSI 推送 -------------------------------------------
    def apply(self, payload):
        with self.lock:
            self.payload_count += 1
            self.last_raw = payload
            self.last_update = time.time()

            p_map = payload.get("map") if isinstance(payload.get("map"), dict) else {}
            new_match = str(p_map.get("matchid") or "")

            # 换局：清空旧阵容
            if new_match and new_match != "0" and new_match != self.match_id:
                self.match_id = new_match
                self.radiant = {"picks": [], "bans": []}
                self.dire = {"picks": [], "bans": []}
                self.local_hero = None
                self.local_side = None
                self.active_team = None

            # 阶段
            game_state = p_map.get("game_state")
            if game_state:
                self.phase = PHASE_MAP.get(game_state, str(game_state).replace("DOTA_GAMERULES_STATE_", "").lower())

            # draft 段：整段替换（GSI 发 draft 时带的是完整快照）
            if "draft" in payload:
                radiant, dire, active = self._parse_draft(payload["draft"])
                self.radiant, self.dire = radiant, dire
                if active is not None:
                    self.active_team = active

            # player / hero 段：玩家自己的英雄与阵营
            p_player = payload.get("player") if isinstance(payload.get("player"), dict) else {}
            p_hero = payload.get("hero") if isinstance(payload.get("hero"), dict) else {}
            if p_hero.get("id") or p_hero.get("name"):
                self.local_hero = {
                    "id": to_int(p_hero.get("id")),
                    "name": p_hero.get("name"),
                }
            if p_player.get("team_name"):
                self.local_side = side_of(p_player.get("team_name"))

    # ---- 对外：快照（供 GET /state）----------------------------------------
    def snapshot(self):
        with self.lock:
            age = time.time() - self.last_update if self.last_update else None
            return {
                "connected": age is not None and age < 15,
                "lastUpdate": self.last_update,
                "ageSeconds": round(age, 1) if age is not None else None,
                "payloadCount": self.payload_count,
                "matchId": self.match_id,
                "phase": self.phase,
                "activeTeam": self.active_team,
                "localHero": self.local_hero,
                "localSide": self.local_side,
                "radiant": self.radiant,
                "dire": self.dire,
                # 双方各 5 人是否齐全，前端据此决定是否可分析
                "ready": len(self.radiant["picks"]) >= 5 and len(self.dire["picks"]) >= 5,
            }

    def reset(self):
        with self.lock:
            self.__init__()


STATE = DraftState()

# 由 main() 注入的运行参数
CFG = {"token": "dota2draft", "require_auth": True, "gsi_path": "/gsi"}


class Handler(BaseHTTPRequestHandler):
    # 静默访问日志（可按需打开）
    def log_message(self, fmt, *args):
        pass

    # ---- 响应工具 ----------------------------------------------------------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _text(self, text, status=200, content_type="text/html; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    # ---- 路由 --------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/state":
            self._json(STATE.snapshot())
        elif path == "/raw":
            self._json({"raw": STATE.last_raw})
        elif path == "/health":
            self._json({"ok": True, "time": datetime.now().isoformat(timespec="seconds")})
        elif path == "/" or path == "/index.html":
            self._text(MONITOR_HTML)
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/reset":
            STATE.reset()
            self._json({"ok": True})
            return
        if path != CFG["gsi_path"]:
            self._json({"error": "not found"}, 404)
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._json({"error": f"invalid json: {e}"}, 400)
            return

        # token 校验
        if CFG["require_auth"]:
            sent = (payload.get("auth") or {}).get("token") if isinstance(payload.get("auth"), dict) else None
            if sent != CFG["token"]:
                self._json({"error": "bad token"}, 403)
                return

        STATE.apply(payload)
        self._json({"ok": True})


# ---------------------------------------------------------------------------
# 自带极简监控页：不启动前端也能验证 GSI 是否打通
# ---------------------------------------------------------------------------
MONITOR_HTML = r"""<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dota2 GSI 监控</title>
<style>
 body{background:#0e1116;color:#e6e8eb;font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:0;padding:20px}
 h1{color:#d4af37;font-size:18px} .card{background:#171b22;border:1px solid #2a303a;border-radius:8px;padding:14px;margin:10px 0}
 .row{display:flex;gap:10px;flex-wrap:wrap}.tag{padding:2px 8px;border-radius:4px;font-size:12px;background:#222836}
 .radiant{color:#7fd68a}.dire{color:#e07a7a}.dim{color:#7b8491}.big{font-size:16px;font-weight:600}
 code{color:#9ad0ff}
</style></head><body>
<h1>Dota 2 GSI 监控</h1>
<div class="card" id="status">连接中…</div>
<div class="row">
 <div class="card radiant" style="flex:1;min-width:240px"><div class="big">天辉 Radiant</div><div id="radiant">—</div></div>
 <div class="card dire" style="flex:1;min-width:240px"><div class="big">夜魇 Dire</div><div id="dire">—</div></div>
</div>
<div class="card dim" id="hint">在 Dota 2 中把 cfg 放到 gamestate_integration 目录并开始一场比赛，这里会自动刷新。</div>
<script>
const names={}; // 由前端填充英雄名（这里显示 id 即可）
function fmt(list){return list.length?list.map(x=>'<span class="tag">#'+x.id+(x.name?' '+x.name:'')+'</span>').join(' '):'<span class="dim">等待中…</span>'}
async function tick(){
 try{
  const s=await (await fetch('/state')).json();
  document.getElementById('status').innerHTML =
   (s.connected?'<span class="radiant">● 已连接</span>':'<span class="dire">● 未连接</span>')+
   ' · 阶段 <code>'+s.phase+'</code> · 对局 '+s.matchId+' · 推送 '+s.payloadCount+' 次'+
   ' · '+s.ageSeconds+'s 前更新';
  document.getElementById('radiant').innerHTML='Pick: '+fmt(s.radiant.picks)+'<br>Ban: '+fmt(s.radiant.bans);
  document.getElementById('dire').innerHTML='Pick: '+fmt(s.dire.picks)+'<br>Ban: '+fmt(s.dire.bans);
 }catch(e){document.getElementById('status').textContent='读取失败: '+e}
}
tick();setInterval(tick,1000);
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser(description="Dota 2 GSI 接收服务器")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址（默认 127.0.0.1；局域网观战用 0.0.0.0）")
    ap.add_argument("--port", type=int, default=8765, help="监听端口（默认 8765）")
    ap.add_argument("--token", default="dota2draft", help="auth token（需与 cfg 中一致）")
    ap.add_argument("--path", default="/gsi", help="GSI POST 路径（需与 cfg 的 uri 一致）")
    ap.add_argument("--no-auth", action="store_true", help="不校验 token（仅本地调试）")
    args = ap.parse_args()

    CFG["token"] = args.token
    CFG["require_auth"] = not args.no_auth
    CFG["gsi_path"] = args.path

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[GSI] 监听 http://{args.host}:{args.port}{args.path}")
    print(f"[GSI] token={'关闭校验' if args.no_auth else args.token}  监控页=http://{args.host}:{args.port}/")
    print("[GSI] 等待 Dota 2 推送数据… (Ctrl+C 退出)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[GSI] 已停止")
        server.shutdown()


if __name__ == "__main__":
    main()
