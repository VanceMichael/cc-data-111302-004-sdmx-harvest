# 来源协议

本地交换约定参照SDMX信息模型，限于 fixtures/data.xml 与 structure.json 描述的子集。GET /flow 返回结构引用 latest，GET /structure/latest 或 /structure/1、/structure/2 返回维度顺序及属性。GET /codes/:version 返回对应地区码表，lateCodes 时第2版码表404。GET /data 返回所选表示的XML原文。第二版的维度顺序变化且新增地区，保密观察无数值。XML标签与属性命名以样本为准，不要求支持全部SDMX格式。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
