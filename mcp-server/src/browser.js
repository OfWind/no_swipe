import { createClient } from "@supabase/supabase-js";

const root = document.querySelector("#app");
const params = new URLSearchParams(location.search);
const authorizationId = params.get("authorization_id");
const HANDOFF_KEY = "no-swipe-oauth-handoff";

const brandMark = `
  <span class="mark" aria-hidden="true">
    <svg viewBox="0 0 64 64">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#173F5F"/>
      <rect x="18" y="11" width="28" height="42" rx="8" fill="none" stroke="#EAF4F7" stroke-width="3"/>
      <path d="M32 42V22M25 29l7-7 7 7" fill="none" stroke="#3CAEA3" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M13 51L51 13" fill="none" stroke="#FF6B6B" stroke-width="5" stroke-linecap="round"/>
    </svg>
  </span>
`;

function icon(path) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="${path}"/></svg>`;
}

const icons = {
  upload: icon("M12 16V4M12 4l-4 4M12 4l4 4M5 20h14"),
  id: icon("M4 6h16v12H4zM8 10h.01M12 10h4M8 14h8"),
  shield: icon("M12 3l8 3v6c0 5-3.4 7.6-8 9-4.6-1.4-8-4-8-9V6z"),
};

function shell(content, kicker = "安全连接") {
  root.classList.remove("complete");
  root.removeAttribute("aria-busy");
  root.innerHTML = `
    <div class="brand">
      ${brandMark}
      <span class="brand-copy">
        <span class="brand-name">No Swipe</span>
        <span class="brand-kicker">${kicker}</span>
      </span>
    </div>
    ${content}
  `;
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

function completeAuthorization(redirectUrl) {
  if (!redirectUrl) throw new Error("缺少回调地址");
  sessionStorage.setItem(HANDOFF_KEY, redirectUrl);
  location.replace("/oauth/complete");
}

async function publicConfig() {
  const response = await fetch("/api/public-config", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("无法加载登录配置");
  return response.json();
}

function renderLegal(kind) {
  const privacy = kind === "privacy";
  shell(`
    <p class="eyebrow">${privacy ? "隐私" : "条款"}</p>
    <h1>${privacy ? "隐私说明" : "使用条款"}</h1>
    <p class="lede">No Swipe 仅上传插件运行时生成的推荐流观察、任务配置摘要、执行结果和同步状态。</p>
    <p class="muted follow">不会要求或上传抖音 Cookie、Supabase token、邮箱验证码或密码。用户可以撤销插件连接。</p>
    <p class="foot-links back-link"><a href="/">返回 No Swipe</a></p>
  `, "法律信息");
}

async function renderLogin(supabase, redirectTo) {
  shell(`
    <p class="eyebrow">登录</p>
    <h1>登录 No Swipe</h1>
    <p class="lede">使用任意可接收验证码的邮箱继续。无需预先注册。</p>
    <form class="stack" id="email-form">
      <label>邮箱<input name="email" type="email" autocomplete="email" required placeholder="you@example.com" /></label>
      <button type="submit">发送验证码</button>
    </form>
  `, "邮箱验证");

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
      <p class="eyebrow">验证</p>
      <h1>输入邮箱验证码</h1>
      <p class="lede">验证码已发送到 <strong>${escapeHtml(email)}</strong>。</p>
      <form class="stack" id="otp-form">
        <label>6 位验证码<input class="otp" name="token" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="8" required /></label>
        <button type="submit">登录并继续</button>
      </form>
    `, "邮箱验证");
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
  if (data?.redirect_url && !data.authorization_id) return completeAuthorization(data.redirect_url);
  const clientName = data?.client?.name || "Codex / ChatGPT";
  const requestedScopes = String(data?.scope || "openid email profile").split(/\s+/).filter(Boolean);

  shell(`
    <p class="eyebrow">授权</p>
    <h1>授权 ${escapeHtml(clientName)}</h1>
    <p class="lede">连接后，No Swipe 可以把本插件采集的数据安全写入我们的数据库。</p>
    <ul class="permissions">
      <li>${icons.upload}<div><strong>上传观察数据</strong><span>推荐内容判断、执行结果、停留时长及任务配置摘要。</span></div></li>
      <li>${icons.id}<div><strong>识别你的连接</strong><span>使用已验证邮箱区分用户、支持撤销和防止滥用。</span></div></li>
      <li>${icons.shield}<div><strong>不会获取</strong><span>抖音 Cookie、邮箱验证码、密码或其他插件数据。</span></div></li>
    </ul>
    <p class="muted follow-lg">请求范围：${requestedScopes.map(escapeHtml).join(" · ")}</p>
    <div class="actions"><button class="secondary" id="deny" type="button">拒绝</button><button id="approve" type="button">同意并连接</button></div>
    <p class="legal foot-links center-links"><a href="/privacy" target="_blank">隐私说明</a> · <a href="/terms" target="_blank">使用条款</a></p>
  `, "授权确认");

  async function decide(approved) {
    root.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    const result = approved
      ? await supabase.auth.oauth.approveAuthorization(authorizationId)
      : await supabase.auth.oauth.denyAuthorization(authorizationId);
    if (result.error) {
      root.querySelectorAll("button").forEach((button) => { button.disabled = false; });
      return message(result.error.message);
    }
    if (approved) return completeAuthorization(result.data.redirect_url);
    location.assign(result.data.redirect_url);
  }
  root.querySelector("#approve").addEventListener("click", () => decide(true));
  root.querySelector("#deny").addEventListener("click", () => decide(false));
}

async function renderAccount(supabase) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData?.user) return renderLogin(supabase, "/account");

  const { data: grants, error: grantsError } = await supabase.auth.oauth.listGrants();
  if (grantsError) throw grantsError;
  const rows = (grants || []).map((grant) => `
    <li data-client-id="${escapeHtml(grant.client.id)}">
      <div>
        <strong>${escapeHtml(grant.client.name || "Codex / ChatGPT")}</strong>
        <span class="muted">权限：${grant.scopes.map(escapeHtml).join(" · ") || "email"}</span>
      </div>
      <button class="secondary" data-revoke="${escapeHtml(grant.client.id)}" type="button">撤销此连接</button>
    </li>
  `).join("");

  shell(`
    <p class="eyebrow">账号</p>
    <h1>连接管理</h1>
    <p class="lede">已登录：${escapeHtml(userData.user.email || userData.user.id)}</p>
    ${rows
      ? `<ul class="permissions grant-list">${rows}</ul>`
      : `<p class="success">当前没有已授权的 Codex 或 ChatGPT 连接。</p>`}
    <p class="muted follow-lg">撤销后，该客户端的 OAuth grant 和 refresh token 会失效；已签发的短效 access token 最迟在到期时停止工作。再次连接必须重新授权。</p>
    <p class="foot-links back-link"><a href="/">返回 No Swipe</a></p>
  `, "连接管理");

  root.querySelectorAll("[data-revoke]").forEach((button) => {
    button.addEventListener("click", async () => {
      const clientId = button.dataset.revoke;
      if (button.dataset.confirmed !== "true") {
        button.dataset.confirmed = "true";
        button.textContent = "再次点击确认撤销";
        button.classList.remove("secondary");
        button.classList.add("danger");
        return;
      }
      button.disabled = true;
      const { error } = await supabase.auth.oauth.revokeGrant({ clientId });
      if (error) {
        button.disabled = false;
        return message(error.message);
      }
      await renderAccount(supabase);
      message("连接已撤销。", "success");
    });
  });
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
  if (location.pathname === "/account") return renderAccount(supabase);
  shell(`
    <p class="eyebrow">服务</p>
    <h1>数据连接</h1>
    <p class="lede">该服务为 No Swipe Codex 插件提供 OAuth 授权和推荐流观察数据上传。</p>
    <p class="muted follow">请从 Codex 的插件安装流程开始连接。</p>
    <p class="foot-links back-link"><a href="/account">管理或撤销连接</a></p>
  `);
}

main().catch((error) => {
  shell(`<p class="eyebrow">出错了</p><h1>暂时无法继续</h1><p class="error">${escapeHtml(error?.message || error)}</p>`);
});
