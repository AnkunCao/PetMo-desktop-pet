# PetMo macOS 本机 App 封装设计

## 目标

生成可从 Finder 双击启动的 Apple Silicon `PetMo.app`，供当前 Mac 本机测试。第一阶段不启用 Developer ID 签名、公证或 DMG。

## 构建方式

- 使用 `electron-builder` 的 macOS `dir` 目标生成未签名 `.app`。
- 产品名为 `PetMo`，Bundle ID 为 `com.petmo.desktop-pet`。
- 架构锁定当前机器的 `arm64`。
- 1024×1024 紫色边牧 PNG 作为应用图标源。
- 输出到 `release/mac-arm64/PetMo.app`。

## 文件范围

打包源码、依赖、渲染资源和构建图标；排除测试、文档、Git 元数据、本地配置、缓存、发布目录和用户生成资源。

## 验证

- 完整测试通过。
- `.app` 结构和 Info.plist 中的名称、Bundle ID 正确。
- 主可执行文件为 arm64。
- 使用 `open` 启动后进程存活且不立即崩溃。
- Finder 可识别自定义图标。

## 后续阶段

对朋友发布时再增加 Developer ID、Hardened Runtime、公证、DMG 与 GitHub Release。
