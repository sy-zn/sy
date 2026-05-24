(function () {
  const T = {
    init: "\u7cfb\u7edf\u8fd8\u5728\u521d\u59cb\u5316\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002",
    email: "\u8bf7\u8f93\u5165\u90ae\u7bb1",
    password: "\u5bc6\u7801\u81f3\u5c11 6 \u4f4d",
    confirm: "\u4e24\u6b21\u8f93\u5165\u7684\u5bc6\u7801\u4e0d\u4e00\u81f4",
    checkFail: "\u6ce8\u518c\u6821\u9a8c\u5931\u8d25",
    notAllowed: "\u8be5\u90ae\u7bb1\u6682\u672a\u83b7\u5f97\u7ba1\u7406\u5458\u540c\u610f\uff0c\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458\u540c\u610f\u540e\u518d\u6ce8\u518c\u3002",
    signupFail: "\u6ce8\u518c\u5931\u8d25",
    signupOk: "\u6ce8\u518c\u6210\u529f\u3002\u8bf7\u767b\u5f55\uff1b\u767b\u5f55\u540e\u4ecd\u9700\u7ba1\u7406\u5458\u7ed1\u5b9a\u6210\u5458\uff0c\u624d\u80fd\u8fdb\u5165\u8d26\u672c\u3002",
    onlyAdmin: "\u53ea\u6709\u7ba1\u7406\u5458\u53ef\u4ee5\u540c\u610f\u6ce8\u518c\u90ae\u7bb1",
    addFail: "\u6dfb\u52a0\u5931\u8d25",
    addOk: "\u5df2\u540c\u610f\u8be5\u90ae\u7bb1\u6ce8\u518c\u3002",
    used: "\u5df2\u6ce8\u518c",
    pending: "\u5df2\u540c\u610f\uff0c\u7b49\u5f85\u6ce8\u518c",
    empty: "\u8fd8\u6ca1\u6709\u6dfb\u52a0\u5141\u8bb8\u6ce8\u518c\u7684\u90ae\u7bb1\u3002"
  };

  const style = document.createElement("style");
  style.textContent = ".form-status{margin:0;border-radius:10px;padding:9px 10px;background:#eef8f2;color:#186d47;font-size:13px}.form-status.error{background:#fff1f1;color:#a32626}.invite-wrap{margin-bottom:12px}";
  document.head.appendChild(style);

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
        const text = item.used_at ? T.used : T.pending;
        return `<tr><td>${item.email}</td><td>${text}</td><td>${usedAt}</td></tr>`;
      })
      .join("");

    if (!rows.innerHTML) {
      rows.innerHTML = `<tr><td colspan="3">${T.empty}</td></tr>`;
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
        if (!sb) return status(T.init, true);

        const payload = Object.fromEntries(new FormData(form).entries());
        const email = String(payload.email || "").trim().toLowerCase();
        const password = String(payload.password || "");
        const confirm = String(payload.confirm_password || "");

        if (!email) return status(T.email, true);
        if (password.length < 6) return status(T.password, true);
        if (password !== confirm) return status(T.confirm, true);

        const { data: allowed, error: allowError } = await sb.rpc("is_registration_invited", {
          candidate_email: email
        });
        if (allowError) return status(allowError.message || T.checkFail, true);
        if (!allowed) return status(T.notAllowed, true);

        const { error } = await sb.auth.signUp({ email, password });
        if (error) return status(error.message || T.signupFail, true);

        form.reset();
        status(T.signupOk, false);
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
        if (typeof showMessage === "function") showMessage(T.onlyAdmin, true);
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
        if (typeof showMessage === "function") showMessage(error.message || T.addFail, true);
        return;
      }

      form.reset();
      if (typeof showMessage === "function") showMessage(T.addOk);
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
