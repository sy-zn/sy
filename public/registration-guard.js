(function () {
  function status(text, isError) {
    const el = document.getElementById("register-status");
    if (!el) return;
    el.hidden = false;
    el.className = isError ? "form-status error" : "form-status";
    el.textContent = text;
  }

  function getClient() {
    if (typeof state !== "undefined" && state.supabase) {
      return state.supabase;
    }
    return null;
  }

  async function loadInvites() {
    const sb = getClient();
    const rows = document.getElementById("invite-rows");
    if (!sb || !rows || typeof state === "undefined" || !state.isAdmin) return;

    const { data, error } = await sb
      .from("registration_invites")
      .select("email, used_at, created_at")
      .order("created_at", { ascending: false });
    if (error) return;

    rows.innerHTML = (data || [])
      .map((item) => {
        const usedAt = item.used_at ? String(item.used_at).slice(0, 10) : "-";
        const text = item.used_at ? "已注册" : "已同意，等待注册";
        return `<tr><td>${item.email}</td><td>${text}</td><td>${usedAt}</td></tr>`;
      })
      .join("");

    if (!rows.innerHTML) {
      rows.innerHTML = '<tr><td colspan="3">还没有添加允许注册的邮箱。</td></tr>';
    }
  }

  function bindRegister() {
    const form = document.getElementById("register-form");
    if (!form || form.dataset.guardBound) return;
    form.dataset.guardBound = "1";
    form.addEventListener(
      "submit",
      async (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();

        const sb = getClient();
        if (!sb) {
          status("系统还在初始化，请稍后再试。", true);
          return;
        }

        const payload = Object.fromEntries(new FormData(form).entries());
        const email = String(payload.email || "").trim().toLowerCase();
        const password = String(payload.password || "");
        const confirm = String(payload.confirm_password || "");

        if (!email) return status("请输入邮箱", true);
        if (password.length < 6) return status("密码至少 6 位", true);
        if (password !== confirm) return status("两次输入的密码不一致", true);

        const { data: allowed, error: allowError } = await sb.rpc("is_registration_invited", {
          candidate_email: email
        });
        if (allowError) return status(allowError.message || "注册校验失败", true);
        if (!allowed) return status("该邮箱暂未获得管理员同意，请联系管理员同意后再注册。", true);

        const { error } = await sb.auth.signUp({ email, password });
        if (error) return status(error.message || "注册失败", true);

        form.reset();
        status("注册成功。请登录；登录后仍需管理员绑定成员，才能进入账本。", false);
      },
      true
    );
  }

  function bindInvite() {
    const form = document.getElementById("invite-form");
    if (!form || form.dataset.guardBound) return;
    form.dataset.guardBound = "1";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const sb = getClient();
      if (!sb || typeof state === "undefined" || !state.isAdmin) {
        if (typeof showMessage === "function") showMessage("只有管理员可以同意注册邮箱", true);
        return;
      }

      const payload = Object.fromEntries(new FormData(form).entries());
      const email = String(payload.email || "").trim().toLowerCase();
      if (!email) return;

      const { error } = await sb.from("registration_invites").upsert(
        {
          email,
          created_by: state.user.id
        },
        { onConflict: "email" }
      );
      if (error) {
        if (typeof showMessage === "function") showMessage(error.message || "添加失败", true);
        return;
      }

      form.reset();
      if (typeof showMessage === "function") showMessage("已同意该邮箱注册。");
      await loadInvites();
    });
  }

  function boot() {
    bindRegister();
    bindInvite();
    loadInvites();
    setTimeout(loadInvites, 1200);
  }

  window.addEventListener("load", boot);
  setInterval(() => {
    bindRegister();
    bindInvite();
    loadInvites();
  }, 3000);
})();
