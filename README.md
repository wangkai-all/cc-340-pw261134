# Field Relay · 三源商品资料采集台

一个从零实现、可直接运行的采集台演示。三家**虚构**供应商是三个真实本地 HTTP 服务，各自用不同方言提供同一批商品资料；采集台按优先级逐字段裁决，经过真实请求取数，向下游接收端投递，全程可追溯。无任何运行时第三方依赖（Node.js 内置 `http` / `sqlite` / `fetch`），Playwright 仅用于测试。

## 运行

```bash
npm start
```

启动后：

| 角色 | 地址 |
| --- | --- |
| 采集台页面 | http://127.0.0.1:4310 |
| Aurora Supply Co.（P1，首选，会回传更正） | http://127.0.0.1:4411 |
| Borealis Wholesale（P2，只能补字段） | http://127.0.0.1:4412 |
| Cirrus Archive（P3，慢速存档，拒绝部分字段） | http://127.0.0.1:4413 |
| 下游接收端 | http://127.0.0.1:4510 |

端口可用环境变量覆盖：`PORT`、`SOURCE_PORT`（起始端口，依次 +0/+1/+2）、`RECEIVER_PORT`、`HOST`。

三家供应商的原始路由是 `GET /records/:id?fields=...`，另有管理路由 `/admin/online`、`/admin/delay`、`/admin/fail-next`、`/admin/revisions`、`/admin/reset`；页面上的「断开/回传修订/注入失败」按钮就是调用这些接口。

## 核心规则

**字段状态互不混同。** 每个字段的结论只能来自某个来源的实际答复，并严格区分：

- `已授权` — 授权来源给出了值
- `明确清空` — 来源明确说该字段为空（Aurora 的 `field_cleared`），并非缺失
- `未授权` — 来源明确拒绝提供（Cirrus 的 `__FORBIDDEN__` / `authorization`），并非缺失
- `已答复·缺失` — 来源答复了，但确实没有这个字段
- `等待中` — 更高优先级的所有者尚未答复（未提问 / 来源离线 / 上次请求失败，页面给出具体原因）
- `未采集` — 从未向任何来源请求过
- `暂定` / `已过期` — 值仍展示，但更高优先级来源未答复或该来源已不可用，**不能**支撑完整性承诺

低优先级来源的值永远不会覆盖高优先级的清空；高优先级未答复时，低优先级的答复也不会被当成最终结论。

**完整性承诺不被偷偷改变。** 承诺由当前裁决实时计算：必填字段全部为「已授权且非暂定、非过期」才允许发布完整版。否则只能显式发布**部分版**：`contract` 冻结 `promise: partial` 与 `blockingRequired`，payload 中不含被阻塞字段，页面和下游都会如实展示「未承诺完整」。下游接收端会再次校验：声称 complete 却缺必填字段的信封返回 `422 completeness_mismatch`。

**只补采受影响字段。** 调整优先级前先在页面预览「将影响 N 个字段」；应用后只向拥有这些字段的来源发起带 `?fields=` 的请求。每次请求的原始响应（包括 503/502 错误体和 HTTP 状态码）都原样入库，字段结论、发布版本都通过 id 指回原始响应。旧发布版冻结当时的字段状态与 payload，被新版取代后仍可查看，并记录后继版本。

**重复领取。** 下游按 `idempotency-key` 去重：同一版本投递两次只入库一份，第二次标记为重复并计数。

## 演示脚本（页面底部四个按钮可一键运行）

1. **换优先级只补采受影响字段** — 把 Cirrus 提到首位，查看影响面预览，应用后仅重取受影响字段，发布新版并与旧版对比。
2. **来源断连与补采** — 断开 Aurora 后补采标题与价格，观察必填字段变为等待、完整版发布被拒绝（409）、原始响应里保留 503；恢复连接后补取恢复。
3. **补采途中再次修订** — 把 Aurora 调慢，在请求在途时排队一条修订；本次响应不包含该修订（快照先于延迟），页面标出「来源有更新待取」，再次补采后生效。
4. **下游重复领取** — 同一版本用同一幂等键投递两次，接收端只留一份回执。

也可以手动操作：拖动/箭头调整优先级、按字段「重取」、切换商品（SKU-1001 ~ SKU-1004，不同数据缺口）、查看原始响应 JSON、打开历史版本对话框。

## 测试

```bash
npm test            # 12 个 API 测试 + 8 个浏览器测试
npm run test:api    # 仅 API
npm run test:ui     # 仅 Playwright（需先 npx playwright install chromium）
```

- `tests/api.test.mjs`：直接起真实应用，断言清空/缺失/未授权区分、部分发布契约、下游拒收谎言、按影响面补采、断连保留 503 原始帧、在途修订、重复投递去重、旧版可追溯、注入失败保留错误体。
- `tests/ui.test.mjs`：用 Chromium 操作真实页面走完全部场景，截图输出在 `/tmp/ui`。

在本沙箱里运行浏览器测试还需要 Playwright 的共享库与字体环境（普通机器无需）：

```bash
export LD_LIBRARY_PATH=/tmp/libs/root/usr/lib/x86_64-linux-gnu:/tmp/libs/root/lib/x86_64-linux-gnu
export FONTCONFIG_FILE=/tmp/libs/fc/fonts.conf
```

也可对已运行的实例跑 UI 测试：`BASE_URL=http://127.0.0.1:4310 npm run test:ui`。

## 结构

```
server/main.js              HTTP 路由、静态文件、快照组装
server/lib/catalog.js       SQLite 持久化：原始响应、请求尝试、claim、发布版、投递、事件
server/lib/sources.js       三家供应商服务（三种方言 + 管理控制 + 修订队列）
server/lib/adjudication.js  逐字段裁决、完整性契约、发布快照与差异
server/lib/collector.js     真实 fetch、按字段定向补采、发布、健康度
server/downstream.js        下游接收端：信封校验、幂等去重
public/                     单页采集台（原生 JS，无框架）
tests/                      API 与 Playwright 测试
```

所有商品、供应商、数值均为虚构内容。
