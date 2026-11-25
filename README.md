# Dota 2 Draft Assistant

基于 [OpenDota](https://www.opendota.com/) 数据的 Dota 2 选人 / 禁用辅助工具。支持路人模式的选人模拟、手动阵容分析，以及通过官方 Game State Integration (GSI) 实时读取游戏内 BP 阵容并给出补位推荐。界面支持中文、英文、瑞典语。

## 功能特性

### 三种视图

| 视图 | 地址 | 说明 |
| --- | --- | --- |
| 选人模拟 | `/?view=draft`（默认） | 按模式走完整的选禁流程，实时给出 pick / ban 推荐，结束后展示双方胜率与分路对比 |
| 手动分析 | `/?view=manual` | 不开游戏，手动选双方各 5 人，复用同一套分析面板 |
| 实时对局 | `/?view=gsi` | 游戏内 BP 时自动读取双方阵容与禁用，底部按分路给出补位推荐 |

顶部标签可切换视图，URL 会同步当前视图，方便直接分享链接。

### 两种路人模式

- **全英雄选择（All Pick）**：双方各 5 禁 5 选，禁用阶段与选取阶段交替进行。
- **随机征召（Random Draft）**：随机生成 20 人共享池，双方轮流选取（第 7 手交换先手），没有禁用阶段，可随时重随。

队长模式不在支持范围内。

### 推荐算法

所有数据来自 OpenDota API 及其 Explorer SQL，无需 API Key。

- **版本胜率**：通过 Explorer 关联 `match_patch` 统计最新版本路人胜率。新版本刚发布、总样本不足 5000 场时自动回退到近 30 天滚动窗口；单英雄样本不足 100 场时回退到整体路人胜率，最后才用职业胜率兜底。页面会标注实际口径，例如 `7.42 · 30d`。
- **克制对方**：按英雄对位表计算候选英雄对敌方已选英雄的胜率。预取「敌方已选 + 双方禁用」的对位数据后反转为候选视角；禁用英雄同时用于计算「克制者已被 ban」的安全加成。
- **己方配合**：用 Explorer self-join `player_matches` 统计近 365 天同队组合胜率，单组合样本至少 20 场才计入。
- **实时对局综合指数** = 版本胜率 40% + 克制对方 35% + 己方配合 25%。缺失样本的分项以 0.5（中性）回退，避免噪声主导排序。卡片上会分别显示三个分项。
- **选人模拟评分** = 版本胜率 35% + 克制 40% + 角色互补 5% + 职业热度 20%。

实时对局的推荐按 1–5 号位分组、空缺位置置顶、组内按综合指数降序排列。GSI 不推送精确分路，分路默认按英雄 `roles` 启发式推断；点击英雄左上角的号位角标可在 1–5 之间循环手动指定，换局后自动重置。

## 技术栈

- Next.js 15（App Router）+ React 18 + TypeScript
- Tailwind CSS + Zustand
- OpenDota API / Explorer SQL
- Python 标准库实现的零依赖 GSI 接收服务
- OpenNext + Cloudflare Workers 部署

## 快速开始

环境要求：Node.js 18.18+；实时对局功能另需 Python 3。

```bash
npm install
npm run dev
```

打开 <http://localhost:3000>。

生产构建与部署：

```bash
npm run build && npm start        # 本地生产模式
npm run build:cloudflare          # 构建 Cloudflare Workers 产物
npm run preview                   # wrangler dev 本地预览
```

## 实时对局（GSI）配置

### 1. 启动本地接收服务

```bash
cd gsi_server
python3 gsi_server.py
# 自定义：python3 gsi_server.py --port 9000 --token mytoken
```

默认监听 `127.0.0.1:8765`，token 为 `dota2draft`。打开 <http://127.0.0.1:8765> 可以看到自带的状态监控页，先确认服务正常。

服务提供的端点：

| 端点 | 用途 |
| --- | --- |
| `POST /gsi` | 接收 Dota 客户端推送（校验 token，按段增量合并，检测新 `matchid` 自动重置） |
| `GET /state` | 前端轮询的解析后状态，带 CORS |
| `GET /raw` | 最近一次原始 payload，用于排查字段差异 |
| `GET /health` | 健康检查 |
| `POST /reset` | 手动清空当前状态 |

GSI 每次只推送发生变化的字段段，所以服务端在内存中做增量合并；换局时按 `matchid` 清空上一局的选禁数据。服务端只输出英雄 id / name，英雄名称与图片由前端用 `/api/heroes` 映射。

### 2. 放置 GSI 配置文件

把 `gsi_server/gamestate_integration_dota2_draft.cfg` 复制到游戏配置目录：

```
Steam\steamapps\common\dota 2 beta\game\dota\cfg\gamestate_integration\
```

文件名必须以 `gamestate_integration_` 开头、以 `.cfg` 结尾。如果启动时改了端口或 token，需要同步修改 cfg 里的 `uri` 与 `auth.token`。

### 3. 打开实时视图

启动前端后访问 <http://localhost:3000/?view=gsi>。游戏进入 BP 阶段后，双方选禁会自动出现在页面上，底部推荐会随阵容变化刷新。

> 浏览器会阻止 HTTPS 页面向本地 HTTP 服务发起请求，因此实时视图请通过本地开发服务器（`http://localhost`）访问。游戏数据只在你的本机流转，不会上传到外部服务。

## 数据接口

| 路径 | 说明 | 缓存 |
| --- | --- | --- |
| `GET /api/heroes` | 英雄列表，含职业、路人、最新版本胜率 | CDN 1 小时 |
| `GET /api/matchups/[heroId]` | 指定英雄对所有英雄的对位场次与胜场 | CDN 1 小时 |
| `GET /api/synergy?heroes=1,5,22` | 这些英雄作为锚点时的同队组合胜率，最多 5 个 | CDN 1 小时 |

接口对英雄 id 做白名单校验，避免把外部输入拼进 Explorer SQL。

## 目录结构

```
app/
  page.tsx                    视图切换与选人模拟主页面
  api/                        OpenDota 数据代理接口
components/
  Header.tsx                  视图与语言切换
  PhaseIndicator.tsx          选禁阶段进度
  TeamPanel.tsx               队伍选禁面板
  HeroPool.tsx                英雄池、搜索与筛选
  Recommendations.tsx         选人模拟的 pick / ban 推荐
  DraftSummary.tsx            选禁结束后的双方对比
  ManualAnalysis.tsx          手动阵容分析
  GSILive.tsx                 实时对局面板
  GSIRecommendations.tsx      按分路分组的实时补位推荐
lib/
  draftEngine.ts              两种模式的选禁顺序
  scoreEngine.ts              评分与分析逻辑
  opendota.ts                 数据获取与胜率口径
  position.ts                 分路推断与占位计算
  i18n.ts / heroNames.ts / types.ts
store/draftStore.ts           Zustand 状态
gsi_server/                   GSI 接收服务与示例 cfg
```

## 已知限制

- 只支持全英雄选择与随机征召两种路人模式。
- 新版本刚发布时版本样本很少，胜率会自动回退到近 30 天窗口，属于预期行为。
- GSI 不提供分路字段，实时页的分路为启发式推断，必要时请手动指定。
- 克制与配合依赖历史对局样本，样本不足的英雄显示为中性值，排序可能偏保守。
