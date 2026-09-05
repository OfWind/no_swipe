# No Swipe

本地 Codex 插件：抖音推荐流采集。安装走 marketplace；本机二进制由 `scripts/bootstrap.sh` / `bootstrap.ps1` 按平台自动下载。

```bash
codex plugin marketplace add OfWind/no_swipe --ref main
codex plugin add no-swipe@no-swipe-marketplace
```

新开任务后说「开始刷推荐流」。首次会打开[内网工作台](https://fai.zhuanspirit.com/creators/)的配对页。连接公司网络，按提示完成公司 SSO 和工作台邮箱 OTP，登录后回到带原始 `code` 参数的 `/creators/pair` 页面完成授权。引导脚本会同步当前工作台地址，并保留已有设备凭据。之后的版本由 Codex 后台刷新 marketplace，新开任务时引导脚本自动换二进制，用户不用再输入升级命令。

普通运行按 Chrome、Edge、Codex 内置浏览器的顺序选择：先尝试 Codex/ChatGPT 浏览器扩展已连接的用户 Chrome，再尝试已连接的用户 Edge，两者均不可用时才在首次页面操作前回退内置浏览器。No Swipe 不使用 Safari；一旦开始授权、账号核验或采集，整项任务固定使用同一浏览器，不在故障恢复时跨浏览器切换。这里的用户 Chrome/Edge 与 `chrome-devtools-mcp` 启动的隔离诊断浏览器是独立路径。

Windows 上未签名的 `no-swipe.exe` 可能被 SmartScreen 或 360 拦截。这是本机信任提示，不是安装失败；不要改去安装 Node、Python 或 CLI 补丁。正式对外前尽量代码签名。
