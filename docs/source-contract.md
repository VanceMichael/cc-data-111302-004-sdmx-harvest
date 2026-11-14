# 来源协议

本地交换约定参照SDMX信息模型，限于 fixtures/data.xml 与 structure.json 描述的子集。GET /flow 返回结构引用 latest，GET /structure/latest 或 /structure/1、/structure/2 返回维度顺序及属性；GET /concepts/:version 返回概念与观测状态码定义；GET /codes/:version 返回对应地区码表，lateCodes 时第2版码表404。GET /data 返回所选表示的XML原文。第二版的维度顺序变化且新增地区，并包含一个引用未知地区码 Z 的序列；保密观察无数值。XML标签与属性命名以样本为准，不要求支持全部SDMX格式。

## 数据表示

- 紧凑表示：`Series` 用 `key` 属性携带以点号分隔的位置键，键段顺序必须按对应结构版本 `dimensions` 声明的顺序还原（v1 为 `REGION.MEASURE`，v2 为 `MEASURE.REGION`），不能按固定位置猜测。
- 通用表示：`Series/Key/Value` 以 `id`/`value` 显式给出维度，与排列位置无关。
- 属性分三级：数据集级（如 `UNIT`，挂在 `DataSet` 上）、序列级（如 `CONFID`，挂在 `Series` 上）、观测级（如 `STATUS`，挂在 `Obs` 上）；下级继承上级，同名下级覆盖上级。
- `Obs` 没有 `value` 属性即发布方未给数值：`STATUS=C` 表示保密不可披露，`STATUS=M` 表示缺报，两者都不得改写为空字符串或零值后继续当数值处理。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作（`structureVersion`、`lateCodes`、`representation`）。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
