# No Swipe

本地 Codex 插件：抖音推荐流采集。安装走 marketplace；本机二进制由 `scripts/bootstrap.sh` / `bootstrap.ps1` 按平台自动下载。

```bash
codex plugin marketplace add OfWind/no_swipe --ref main
codex plugin add no-swipe@no-swipe-marketplace
```

新开任务后说「开始刷推荐流」。首次会打开工作台配对页，邮箱 OTP 一次即可。

Windows 上未签名的 `no-swipe.exe` 可能被 SmartScreen 或 360 拦截。这是本机信任提示，不是安装失败；不要改去安装 Node、Python 或 CLI 补丁。正式对外前尽量代码签名。
