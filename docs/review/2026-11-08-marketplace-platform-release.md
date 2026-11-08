# 商店多平台发布验证

正式发布由 `.github/workflows/publish.yml` 手动触发。必须输入与已提交 `package.json` 一致的版本；`publish` 默认关闭，仅构建并验证，不上传商店。

流程并行运行完整回归与六个平台加纯 TS 包的构建验证。两者均成功后，检查七包集合，生成 SHA256SUMS，并上传经验证的 workflow artifact。手动选择 `publish=true` 时，发布任务下载该 artifact，先校验 SHA256，再使用 vsce 逐包上传六个平台包与通用纯 TS 回退包。平台匹配的 VS Code 会选择对应平台包；通用包用于没有专用包的平台。

2026-11-08 [验证运行 42466710658](https://github.com/cuihairu/kode/actions/runs/42466710658) 使用提交 `675affe3` 和版本 `0.2.0`，完整回归、七个平台构建与验证、产物集合检查全部通过。该次 `publish=false`，上传商店的任务被跳过；验证结果不代表商店已接收新版本。

首次正式发版需由用户提供新的版本号，并将其更新提交后以该版本和 `publish=true` 手动触发。Marketplace 的逐包上传可能在中途失败；发生时应核查商店已有平台及 workflow 日志，再决定如何处理余下包，不能把部分成功视为完整发布。纯 TS 包是同一扩展版本的通用回退，不是独立扩展 ID；匹配平台会自动选择对应的 Rust 包。
