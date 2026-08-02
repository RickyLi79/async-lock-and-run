<!-- 语言切换导航（顶部左上方） -->

<a id="top"></a>
<p align="left">
  <a href="./README.md">English</a> ｜ <strong>简体中文</strong>
</p>

<div align="center">

# 🔒 async-lock-and-run

**Run async functions under a per-key mutual exclusion lock.**

> 按 `lockerId`（键）互斥地运行异步函数：同一把锁内的调用自动串行（FIFO 到达顺序），不同锁之间完全并行。轻量、零运行时依赖，纯 JS/TS 实现，浏览器可用。

[![npm version](https://img.shields.io/npm/v/@rickyli79/async-lock-and-run.svg)](https://www.npmjs.com/package/@rickyli79/async-lock-and-run)
[![npm downloads](https://img.shields.io/npm/dm/@rickyli79/async-lock-and-run.svg)](https://www.npmjs.com/package/@rickyli79/async-lock-and-run)
[![license](https://img.shields.io/npm/l/@rickyli79/async-lock-and-run.svg)](https://github.com/rickyli79/async-lock-and-run)

</div>

---

## 📑 目录

- [📖 项目简介](#项目简介)
- [✨ 特性](#特性)
- [📦 安装](#安装)
- [🚀 快速开始](#快速开始)
- [🧩 API 文档](#api-文档)
- [⚠️ 语义与注意事项](#语义与注意事项)
- [🌐 浏览器兼容](#浏览器兼容)
- [🛠️ 开发](#开发)
- [🚢 发布流程](#发布流程)
- [📄 许可证](#许可证)

---

<a id="项目简介"></a>

## 📖 项目简介

`@rickyli79/async-lock-and-run` 是一个极简的「按键互斥」异步锁工具。它围绕一个核心函数 `asyncLockAndRun` 展开：你提供一把锁的标识 `lockerId` 和一个异步函数 `body`，它会保证——**对同一个 `lockerId` 的所有调用按到达顺序（FIFO）串行执行，对不同的 `lockerId` 完全并行执行**。

典型场景：

- 同一资源的并发限流（例如同时有大量请求打到同一个接口/键上，只允许一个在执行）。
- 需要互斥的写操作（数据库同键写入、缓存更新、token 刷新等）。
- 只想「给某段异步代码排队」，又不想引入重量级的任务队列/信号量库。

它没有任何运行时依赖，实现是纯 JS/TS（没有静态 `node:` 导入），因此同时支持 **Node.js 与浏览器**。

<a id="特性"></a>

## ✨ 特性

- 🔑 **按键互斥**：同一 `lockerId` 的调用串行执行（FIFO 到达顺序）；不同 `lockerId` 完全并行。
- 🎯 **调用独立**：每次调用都会执行自己的 `body`，并拿到属于自己的结果，互不串扰。
- 🛡️ **错误隔离**：某个 `body` reject 只影响它自己这一次调用，排队的兄弟调用照常执行；锁在 reject 时也**一定会释放**，不会卡死后续调用。
- 🆔 **Key 按身份比较**：数字 `1` 和字符串 `"1"` 是**不同的锁**，`symbol` 彼此唯一。
- 🔄 **可重入检测**：在 Node.js（≥ 22.3，支持 `process.getBuiltinModule`）下，在 `body` 内对同一个 `lockerId` 再次调用会检测到并**抛错**（防止死锁）；不支持的运行时（如浏览器）退化为普通按 key 互斥。
- 🧩 **纯 JS/TS、零依赖**：无静态 `node:` 依赖，浏览器可直接使用。
- 📦 **双格式**：同时输出 ESM 与 CJS，TypeScript 类型完整。

<a id="安装"></a>

## 📦 安装

使用 pnpm（本项目开发环境要求 `pnpm ^11.18.0`）：

```bash
pnpm add @rickyli79/async-lock-and-run
```

也可以使用 npm 或 yarn：

```bash
npm install @rickyli79/async-lock-and-run
# 或
yarn add @rickyli79/async-lock-and-run
```

> 该包发布到 npm 公开注册表（`https://registry.npmjs.org`），`publishConfig.access = public`。

### 模块格式（ESM + CJS）

包提供双格式构建（由 tsup 生成），`exports` 映射如下：

| 入口                         | 类型声明           | 说明     |
| ---------------------------- | ------------------ | -------- |
| `import` → `dist/index.js`   | `dist/index.d.ts`  | ESM 入口 |
| `require` → `dist/index.cjs` | `dist/index.d.cts` | CJS 入口 |

包级配置：`type: module`，`main: ./dist/index.cjs`，`module: ./dist/index.js`。

**ESM（推荐）**

```ts
import { asyncLockAndRun } from "@rickyli79/async-lock-and-run";
```

**CJS**

```js
const { asyncLockAndRun } = require("@rickyli79/async-lock-and-run");
```

<a id="快速开始"></a>

## 🚀 快速开始

### 示例一：并发限流 / 互斥

同时发起多个请求，但同一资源串行执行、不同资源并行执行：

```ts
import { asyncLockAndRun } from "@rickyli79/async-lock-and-run";

// 模拟对某个资源的受限/昂贵操作
async function fetchRemote(key: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return `data:${key}`;
}

// 同一 lockerId 串行执行，不同 lockerId 完全并行
function loadOnce(key: string): Promise<string> {
  return asyncLockAndRun({ lockerId: key, body: () => fetchRemote(key) });
}

// 同时发起 3 个对 "hot" 的请求 + 1 个对 "cold" 的请求
const [a, b, c, d] = await Promise.all([
  loadOnce("hot"),
  loadOnce("hot"), // 排队：等待上一个 "hot" 完成后才执行
  loadOnce("hot"), // 排队：等待前两个 "hot" 完成后才执行
  loadOnce("cold"), // 不同 key，与 "hot" 完全并行，不排队
]);

console.log(a, b, c, d);
```

### 示例二：错误隔离

某个调用失败，不影响排队中的其它调用，锁也会正常释放：

```ts
import { asyncLockAndRun } from "@rickyli79/async-lock-and-run";

const failing = asyncLockAndRun({
  lockerId: "job",
  body: async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw new Error("boom");
  },
});

const succeeding = asyncLockAndRun({
  lockerId: "job",
  body: async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return "ok";
  },
});

try {
  await failing; // 只会 reject 它自己这一次调用
} catch (error) {
  console.error("本次调用失败：", (error as Error).message); // boom
}

console.log(await succeeding); // "ok" —— 排队中的兄弟调用照常执行
```

<a id="api-文档"></a>

## 🧩 API 文档

包的核心（也是唯一）导出是异步函数 `asyncLockAndRun`。

### 函数签名

```ts
async function asyncLockAndRun<T = void>(arg: AsyncLockAndRun<T>): Promise<T>;
```

### 参数

`arg` 是一个对象，包含两个字段：

| 参数           | 类型                         | 必填 | 说明                                                                                                          |
| -------------- | ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `arg.lockerId` | `string \| number \| symbol` | 是   | 锁的标识。相同 `lockerId` 互斥串行（FIFO）；不同 `lockerId` 完全并行。按**身份**比较：`1` 与 `"1"` 是不同锁。 |
| `arg.body`     | `() => Promise<T>`           | 是   | 需要在锁内互斥执行的异步函数，其返回值就是本次调用的结果。                                                    |

### 返回值

`Promise<T>`：

- 正常完成时，resolve 为 `body` 的返回值（`T`）。
- 若 `body` 抛错 / reject，则以相同原因 reject——**只影响本次调用**，排队中的兄弟调用不受影响，锁一定会释放。
- 在 Node.js 下若发生**可重入调用**（见下文「语义与注意事项」），会以 `Error` reject。

### 类型定义

```ts
export type AsyncLockAndRun<T> = {
  lockerId: string | number | symbol;
  body: () => Promise<T>;
};

export async function asyncLockAndRun<T = void>(
  arg: AsyncLockAndRun<T>,
): Promise<T>;
```

<a id="语义与注意事项"></a>

## ⚠️ 语义与注意事项

1. **按 `lockerId` 互斥（FIFO）**：同一 `lockerId` 的调用严格按照「到达顺序」排队，一次只执行一个；不同 `lockerId` 互不阻塞，完全并行。
2. **每次调用独立**：每个调用都会执行自己的 `body` 并拿到自己的结果，不会复用或共享其它调用的结果。
3. **错误隔离**：`body` reject 只 reject 它自己这一次调用；排队的兄弟调用照常执行，锁在 reject 时也一定释放（内部通过 `try/finally` 保证）。
4. **Key 按身份比较**：数字 `1` 和字符串 `"1"` 被视为**不同**的锁；`symbol` 各自唯一。因此请确保调用方传递的 `lockerId` 类型一致，否则会产生「看似相同实则不同」的锁。
5. **可重入检测（Node.js ≥ 22.3）**：在 `body` 内部对**同一个 `lockerId`** 再次调用 `asyncLockAndRun` 会造成死锁，因此 Node.js 下会检测并抛错（`reentrant call ... would deadlock`）。如果你确实需要在锁内做嵌套异步工作，请使用**不同的 `lockerId`**。
6. **无检测的运行时**：在不支持 `async_hooks` 的运行时（如浏览器）中，可重入检测被禁用，行为退化为普通的按 key 互斥——此时在 `body` 内重入同一个 `lockerId` **会死锁**。请务必避免重入。

<a id="浏览器兼容"></a>

## 🌐 浏览器兼容

本包实现为纯 JS/TS，**没有任何静态的 `node:` 依赖**（`node:async_hooks` 仅在支持 `process.getBuiltinModule` 的运行时内按需动态加载），因此可以直接在浏览器 / 打包器（Vite、Webpack 等）中使用。

需要注意的差异：

- 浏览器没有 `async_hooks` 等价物，**可重入检测被禁用**。
- 因此浏览器环境下，在 `body` 内对同一个 `lockerId` 重入会**直接死锁**，请避免这种写法（换用不同的 `lockerId` 或重构逻辑）。

<a id="开发"></a>

## 🛠️ 开发

### 环境要求

- Node.js（≥ 22.3 以便在本地验证可重入检测路径）
- pnpm `^11.18.0`（`devEngines.packageManager`，不满足时会提示下载）

### 脚本

| 命令                         | 说明                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `pnpm run typecheck`         | 类型检查（`tsc --noEmit`）                                                    |
| `pnpm test`                  | 运行测试（`vitest run`，当前共 **9** 个测试）                                 |
| `pnpm run build`             | 构建（`tsup`，生成 ESM + CJS + d.ts / d.cts）                                 |
| `pnpm run changelog`         | 生成 `CHANGELOG.md`（`auto-changelog`，keepachangelog 模板，起始版本 v0.1.0） |
| `pnpm run changelog:preview` | 生成预览版 `CHANGELOG-preview.md`                                             |

### 目录结构

```
async-lock-and-run/
├── src/
│   ├── index.ts          # 核心实现（asyncLockAndRun + 可重入检测）
│   └── index.test.ts     # vitest 测试（9 个用例）
├── tsup.config.ts        # 双格式构建配置（ESM + CJS + dts）
├── vitest.config.ts      # 测试配置
├── tsconfig.json         # TypeScript 配置
├── .github/workflows/    # CI / 自动发布（publish.yml）
└── package.json
```

<a id="发布流程"></a>

## 🚢 发布流程

本项目采用 **dev（开发）→ main（发布）** 的双分支模型。

### 手动发版步骤

1. 提升版本号并提交到 `dev`：

   ```bash
   npm version patch   # 或 minor / major
   git push origin dev
   ```

2. 打开 `dev → main` 的 Pull Request，**使用 merge commit（不要 squash / rebase）** 合并。

3. 合并到 `main` 后，自动发布链路被触发。

### 自动发布链路

`push main` 时，GitHub Actions（`.github/workflows/publish.yml`）自动执行：

```mermaid
flowchart LR
    A["dev 分支"] -->|"npm version patch / minor / major"| B["提升版本号"]
    B -->|"push dev"| C["PR dev → main（merge commit）"]
    C -->|"push main"| D["GitHub Actions publish.yml"]
    D --> E["版本门禁"]
    E --> F["typecheck / test / build"]
    F --> G["pnpm publish（OIDC Trusted Publishing + provenance）"]
    G --> H["自动打 vX.Y.Z tag"]
    H --> I["生成 changelog / 建 GitHub Release"]
    I --> J["CHANGELOG.md 提交回 main"]
```

要点：

- 发布使用 **OIDC Trusted Publishing + provenance**，无需在 CI 中保存 npm token。
- 发布成功后会**自动打 `vX.Y.Z` tag**、生成 changelog、创建 GitHub Release，并把 `CHANGELOG.md` 提交回 `main`。
- 未通过版本门禁或 typecheck/test/build 任一环节，发布不会执行。

<a id="许可证"></a>

## 📄 许可证

[MIT](./LICENSE) © [Ricky Li](mailto:382688672@qq.com)
