import { createClient } from "@supabase/supabase-js";

const root = document.querySelector("#app");
const params = new URLSearchParams(location.search);
const authorizationId = params.get("authorization_id");

function shell(content) {
  root.innerHTML = `<div class="brand"><span class="mark">N</span><span>No Swipe</span></div>${content}`;
}

function message(text, kind = "error") {
  const current = root.querySelector("[data-message]");
  if (current) current.remove();
  const node = document.createElement("p");
  node.dataset.message = "true";
  node.className = kind;
  node.textContent = text;
  root.append(node);
}

function safeRedirect(value) {
  if (!value) return "/";
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function publicConfig() {
  const response = await fetch("/api/public-config", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("无法加载登录配置");
  return response.json();
}

function renderLegal(kind) {
  const privacy = kind === "privacy";
  shell(`
    <h1>${privacy ? "隐私说明" : "使用条款"}</h1>
    <p>No Swipe 仅上传插件运行时生成的推荐流观察、任务配置摘要、执行结果和同步状态。</p>
    <p>不会要求或上传抖音 Cookie、Supabase token、邮箱验证码或密码。用户可以撤销插件连接。</p>
    <p><a href="/">返回 No Swipe</a></p>
  `);
}

async function renderLogin(supabase, redirectTo) {
  shell(`
    <h1>登录 No Swipe</h1>
    <p class="muted">使用任意可接收验证码的邮箱。无需 Supabase 账号。</p>
    <form class="stack" id="email-form">
      <label>邮箱<input name="email" type="email" autocomplete="email" required placeholder="you@example.com" /></label>
      <button type="submit">发送验证码</button>
    </form>
  `);

  root.querySelector("#email-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = new FormData(form).get("email").trim().toLowerCase();
    const button = form.querySelector("button");
    button.disabled = true;
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    button.disabled = false;
    if (error) return message(error.message);

    shell(`
      <h1>输入邮箱验证码</h1>
      <p class="muted">验证码已发送到 <strong>${escapeHtml(email)}</strong>。</p>
      <form class="stack" id="otp-form">
        <label>6 位验证码<input name="token" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="8" required /></label>
        <button type="submit">登录并继续</button>
      </form>
    `);
    root.querySelector("#otp-form").addEventListener("submit", async (otpEvent) => {
      otpEvent.preventDefault();
      const otpForm = otpEvent.currentTarget;
      const token = new FormData(otpForm).get("token").trim();
      const otpButton = otpForm.querySelector("button");
      otpButton.disabled = true;
      const { error: verifyError } = await supabase.auth.verifyOtp({ email, token, type: "email" });
      if (verifyError) {
        otpButton.disabled = false;
        return message(verifyError.message);
      }
      location.assign(safeRedirect(redirectTo));
    });
  });
}

async function renderConsent(supabase) {
  if (!authorizationId) throw new Error("缺少 authorization_id");
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    const redirect = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
    return renderLogin(supabase, redirect);
  }

  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error) throw error;
  if (data?.redirect_url && !data.authorization_id) return location.assign(data.redirect_url);
  const clientName = data?.client?.name || "Codex / ChatGPT";
  const requestedScopes = String(data?.scope || "openid email profile").split(/\s+/).filter(Boolean);

  shell(`
    <h1>授权 ${escapeHtml(clientName)}</h1>
    <p class="muted">连接后，No Swipe 可以把本插件采集的数据安全写入我们的 Supabase。</p>
    <ul class="permissions">
      <li><strong>上传观察数据</strong>推荐内容判断、执行结果、停留时长及任务配置摘要。</li>
      <li><strong>识别你的连接</strong>使用已验证邮箱区分用户、支持撤销和防止滥用。</li>
      <li><strong>不会获取</strong>抖音 Cookie、邮箱验证码、密码或其他插件数据。</li>
    </ul>
    <p class="muted">请求范围：${requestedScopes.map(escapeHtml).join(" · ")}</p>
    <div class="actions"><button class="secondary" id="deny">拒绝</button><button id="approve">同意并连接</button></div>
    <p class="muted"><a href="/privacy" target="_blank">隐私说明</a> · <a href="/terms" target="_blank">使用条款</a></p>
  `);

  async function decide(approved) {
    root.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    const result = approved
      ? await supabase.auth.oauth.approveAuthorization(authorizationId)
      : await supabase.auth.oauth.denyAuthorization(authorizationId);
    if (result.error) {
      root.querySelectorAll("button").forEach((button) => { button.disabled = false; });
      return message(result.error.message);
    }
    location.assign(result.data.redirect_url);
  }
  root.querySelector("#approve").addEventListener("click", () => decide(true));
  root.querySelector("#deny").addEventListener("click", () => decide(false));
}

async function main() {
  if (location.pathname === "/privacy") return renderLegal("privacy");
  if (location.pathname === "/terms") return renderLegal("terms");
  const config = await publicConfig();
  const supabase = createClient(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  if (location.pathname === "/oauth/consent") return renderConsent(supabase);
  if (location.pathname === "/login") return renderLogin(supabase, params.get("redirect"));
  shell(`
    <h1>No Swipe 数据连接</h1>
    <p>该服务为 No Swipe Codex 插件提供 OAuth 授权和推荐流观察数据上传。</p>
    <p class="muted">请从 Codex 的插件安装流程开始连接。</p>
  `);
}

main().catch((error) => {
  shell(`<h1>暂时无法继续</h1><p class="error">${escapeHtml(error?.message || error)}</p>`);
});
