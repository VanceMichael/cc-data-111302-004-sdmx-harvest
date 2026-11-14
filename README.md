# 统计交换目录的结构版本与观测语义采集

这是用于内部数据接入的 Node.js 项目。当前提供可独立启动的本地来源、单次原文读取接口、结构版本感知的采集器以及来源契约测试；浏览器页面和仪器网关使用合成业务资料，不连接真实账户或设备。

## 环境与命令

Node.js 22.22.1 或更新的 22.x。依赖由 package-lock.json 锁定。

```sh
npm ci --ignore-scripts
npm run build
npm test
npm start
```

`npm start` 在标准输出报告来源地址。默认绑定本机回环地址并使用动态端口；可通过 `HOST` 与 `PORT` 指定监听地址和端口，例如 `HOST=127.0.0.1 PORT=8080 npm start`。按 Ctrl+C 关闭来源；动态端口避免与同机其他接入站冲突。`npm run demo` 在同一进程启动来源，读取一次目录后退出，不代表持续接收业务已经完成。

```sh
# 端到端演示：两种表示、结构升级、迟到码表、未知码隔离、别版保护
npm run harvest:demo

docker build -t sdmx-harvest:local .
docker run --rm --network none sdmx-harvest:local
docker run --rm --network none sdmx-harvest:local npm run demo
```

依赖在镜像构建阶段安装，运行阶段不需要公网。完整来源测试和一次目录演示通常数秒即可结束，适合在90秒以内查看真实输出。

## 目录

- `src/source.mjs`：本地来源生命周期与HTTP入口（数据流、结构、概念、码表、数据原文）。
- `src/client.mjs`：目录读取及原始字节获取。
- `src/harvest/`：结构版本感知采集器。
  - `structure.mjs`：沿数据流定义取得结构引用；`latest` 只在领取瞬间解析为确定版本，之后只请求该版本的结构、码表、概念，每份资料保存原文与 SHA-256。
  - `xml.mjs` / `dataset.mjs`：受限 XML 子集解析，支持紧凑与通用两种表示，忠实区分“没有 value 属性”与 `value="0"`。
  - `interpret.mjs`：按钉版结构的维度顺序解释键，按数据集/序列/观测三级合并有效属性，保留观测状态、保密标记与无数值语义；引用未知码的序列整条转异常，不影响其他序列。
  - `store.mjs`：原子写入的本地入库；原文按哈希落盘，完整结构包不可变，系列解释按结构版本分别保存，已确认解释拒绝覆盖。
  - `harvest.mjs`：一次领取与迟到资料后的定向重解释（只重解受影响原文）。
  - `query.mjs` / `cli.mjs`：资料组查看入口与命令行。
  - `demo.mjs`：本地交换站全流程演示。
- `fixtures/source.json`：来源初始状态。
- `docs/source-contract.md`：来源协议范围、控制与领域语义。
- `test/`：单元测试与实际来源集成测试。

## 采集器命令行

```sh
# 领取（结构钉版 + 原文落盘 + 解释；默认入库 .local/harvest）
node src/harvest/cli.mjs harvest --source http://127.0.0.1:8080 --store .local/harvest

# 修订结构到齐后，仅重新解释受影响的原文
node src/harvest/cli.mjs reinterpret --source http://127.0.0.1:8080 --store .local/harvest

# 资料组查看：系列（原始标识、规范维度、有效属性、定义依据）、异常、结构包、领取记录
node src/harvest/cli.mjs series [--id 'MEASURE=COUNT|REGION=B'] --store .local/harvest
node src/harvest/cli.mjs anomalies [--all] --store .local/harvest
node src/harvest/cli.mjs bundles --store .local/harvest
node src/harvest/cli.mjs harvests --store .local/harvest

# 确认某系列某结构版本的统计发布；确认后重领与重解释都不会覆盖
node src/harvest/cli.mjs confirm --id 'REGION=A|MEASURE=COUNT' --version 1 --store .local/harvest
```

观测的数值状态有四种，均为显式表达，不会把不可披露值变成空字符串后继续当正常数值：

- `numeric`：发布方给出的数值，同时保留原文文本与解析后的数字；
- `no-value`：原文无数值，原因按状态概念区分为 `non-disclosable`（保密不可披露）、`missing`（缺报）或 `no-value-by-status`；
- `conflicting-value`：状态定义声称无数值却携带了数值，保留原文并标记语义冲突；
- 挂起序列以 `structure-pending` 单列，与缺报完全不同。

运行时状态仅用于来源模拟，重启来源会回到 fixtures 中的值。接入业务自己的持久状态请使用 `.local/` 或明确的外部路径。来源管理入口 `/state` 和 `/control` 是本地操作设施，不能作为绕过浏览器页面的业务写入捷径。
