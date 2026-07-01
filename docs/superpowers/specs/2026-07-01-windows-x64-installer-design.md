# PetMo Windows x64 内测安装包设计

## 目标

为 Windows 10/11 x64 用户生成可双击安装的 `PetMo-Setup-0.1.0.exe`，用于朋友内部测试。

## 构建方式

使用 GitHub Actions 的 `windows-latest` runner 构建，不依赖开发者 Mac 上的 Wine。工作流先执行 `npm ci` 和全部测试，再调用 electron-builder 生成 NSIS x64 安装包，并将 `.exe` 作为 Actions Artifact 上传。

## 安装体验

- 安装器允许用户选择安装目录。
- 默认创建开始菜单快捷方式和桌面快捷方式。
- 应用安装后显示名称 `PetMo`。
- 支持标准卸载流程。
- 当前内测版不进行 Windows 商业代码签名，因此 SmartScreen 可能显示“未知发布者”；测试用户可通过“更多信息 → 仍要运行”继续。

## 项目改动

- `package.json` 增加 Windows NSIS x64 构建配置和 `app:win` 脚本。
- `.github/workflows/build-windows.yml` 增加手动触发和 `main` 分支触发的 Windows 构建任务。
- `README.md` 增加 Windows 安装包构建与下载说明。
- 使用现有 `build/icon.png` 作为 Windows 应用图标，由 electron-builder 在构建阶段转换。

## 验收标准

- `npm test` 全部通过。
- GitHub Actions Windows 构建成功。
- Artifact 中存在 `PetMo-Setup-0.1.0.exe`。
- 构建日志确认目标为 Windows x64 NSIS。
- 仓库中不提交 `release/` 构建产物或签名凭据。
