# Eagleye

> 一条有证据链的情报流水线：把嘈杂来源变成可检查的信号、知识图谱边和简报。

[English](README.md)

[![CI](https://github.com/tim0n1994/eagleye/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tim0n1994/eagleye/actions/workflows/ci.yml?query=branch%3Amain)
[![最新发布](https://img.shields.io/github/v/release/tim0n1994/eagleye?label=release)](https://github.com/tim0n1994/eagleye/releases)
[![许可证](https://img.shields.io/github/license/tim0n1994/eagleye)](LICENSE)

Eagleye 不停在“抓到文档”或“生成一段话”。它保留从来源到结论的路径：采集信号、保存来源关系、做富化处理、连接知识图谱，并生成面向操作者的简报。

```text
来源 → 来源关系 → 富化 → 图谱 → 简报
```

## 它解决什么问题

- **证据先于解释：** 每个派生结果都应能回到生成它的来源材料。
- **状态就是数据：** 冷却、认证失败、重试、取消和部分收敛都保持可见。
- **边界保持清晰：** 采集器、worker、API、MCP、存储和部署各自拥有独立的失败面。
- **当前公开版本：** `v1.1.2` 提供可复现的应用代码与运行契约。

## 本地运行

需要 Node.js 22.21+ 或 24+、Python 3.12 和 `uv`：

```sh
cp .env.example .env
npm ci
npm run lint
npm test
npm run test:pipeline
```

默认服务端口为 `3019`。请将 `EAGLEYE_DB_PATH` 指向可丢弃的本地数据库；真实凭证、来源会话、模型配置和生产数据不在仓库中。

完整的流水线、部署与 ThinkPad 回读说明见 [English README](README.md)。
